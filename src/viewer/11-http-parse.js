// The .http file format, parsed. This is the half of the HTTP Client that reads; 11-http-run.js is the half
// that sends, and 11-http-script.js runs the scripts a file attaches to a request.
//
// The format is IntelliJ's (JetBrains calls it the HTTP Client; the files are .http/.rest), and the point of
// following it exactly is that the same file works in both tools — a reviewer reads a request in kakapo and
// runs it in the IDE, or the other way round, without editing anything.
//
// One parse serves three readers: the gutter (which line gets a Run button), the highlighter (what each
// token is), and the runner (what to send). They used to disagree about where a request ended, which is why
// every request carries its own line span.

function isHttpFile(path) {
  return /\.(http|rest)$/i.test(path || '');
}

// A FUNCTION, not module-level constants, for the reason tokenSets() in 11-render-http.js is one: the
// slices are concatenated into one script, and the diff view decorates a restored .http file at LOAD time
// (01-diff-model.js -> decorateDiffHttpRuns -> parseHttpRequests) — before a statement in this slice has
// run. As `let` that read throws; as `var` it reads `undefined`, and `undefined['GET']` is where the parse
// stopped. A call is always answerable.
//
// GRAPHQL is a request line like any other and is sent as a POST with a {query, variables} body.
// WEBSOCKET is one too: Node ships a WebSocket client, so the messages a file lists can actually be sent
// (http-socket.ts). GRPC is the one that stays unsendable — it needs a protobuf runtime, which is a
// dependency this CLI does not take, and a Run button that cannot send is worse than none.
var HTTP_SYNTAX = null;
function httpSyntax() {
  if (HTTP_SYNTAX) return HTTP_SYNTAX;
  HTTP_SYNTAX = {
    methods: {
      GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1, OPTIONS: 1, TRACE: 1, CONNECT: 1, GRAPHQL: 1,
      WEBSOCKET: 1,
    },
    unsupported: { GRPC: 1, GRPCS: 1 },
    // The comment-line directives that are syntax rather than prose — the highlighter colours exactly
    // these, so a typo'd `# @no-redirectt` stays grey and is visibly not doing anything.
    directives: {
      'no-redirect': 1, 'no-cookie-jar': 1, 'no-log': 1, 'no-auto-encoding': 1,
      'use-os-credentials': 1, timeout: 1, 'connection-timeout': 1, name: 1,
    },
  };
  return HTTP_SYNTAX;
}

/** A fresh regex per call: a shared global one carries `lastIndex` between unrelated scans. */
function httpVarPattern() {
  return /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
}

// `# @timeout 600`, `// @connection-timeout 2 m`. Seconds unless the unit says otherwise, as in IntelliJ.
function httpDurationMs(value) {
  const match = /^\s*([\d.]+)\s*(ms|s|m)?\s*$/i.exec(String(value || ''));
  if (!match) return 0;
  const amount = parseFloat(match[1]);
  if (!isFinite(amount)) return 0;
  const unit = (match[2] || 's').toLowerCase();
  return Math.round(amount * (unit === 'ms' ? 1 : unit === 'm' ? 60000 : 1000));
}

function emptyHttpDirectives() {
  return {
    noRedirect: false, noCookieJar: false, noLog: false, noAutoEncoding: false,
    useOsCredentials: false, timeoutMs: 0, connectTimeoutMs: 0,
  };
}

// A comment line that is a request directive rather than prose. Returns true when it consumed the line.
function applyHttpDirective(line, directives) {
  const match = /^\s*(?:#+|\/\/)\s*@([\w-]+)(?:[=\s]+(.*))?$/.exec(line);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const value = (match[2] || '').trim();
  if (name === 'no-redirect') { directives.noRedirect = true; return true; }
  if (name === 'no-cookie-jar') { directives.noCookieJar = true; return true; }
  if (name === 'no-log') { directives.noLog = true; return true; }
  if (name === 'no-auto-encoding') { directives.noAutoEncoding = true; return true; }
  if (name === 'use-os-credentials') { directives.useOsCredentials = true; return true; }
  if (name === 'timeout') { directives.timeoutMs = httpDurationMs(value); return true; }
  if (name === 'connection-timeout') { directives.connectTimeoutMs = httpDurationMs(value); return true; }
  return false;
}

// `# @name login` / `# @name = login` / `### login`.
function httpRequestName(line) {
  const named = /^\s*(?:#+|\/\/)\s*@name\s*=?\s*(.+)$/.exec(line);
  return named ? named[1].trim() : '';
}

/**
 * `< ./body.json`, `<@ ./body.json`, `<@utf-8 ./body.json`.
 *
 * The `@` is the whole difference and it decides who reads the file: without it the bytes go out untouched
 * (main reads them, so a PNG stays a PNG), with it the text is substituted for {{variables}} first — which
 * means the renderer has to read it, and a binary file would not survive the trip.
 */
function httpBodyFileSpec(line) {
  const match = /^\s*<(@([\w-]*))?\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { path: match[3], substitute: Boolean(match[1]), encoding: (match[2] || '').toLowerCase() };
}

/** `> {% … %}`, `> ./handler.js`, `>> out.json`, `>>! out.json`. */
function httpRedirectSpec(line) {
  const output = /^\s*>>(!?)\s+(.+?)\s*$/.exec(line);
  if (output) return { kind: 'output', path: output[2], force: output[1] === '!' };
  const handler = /^\s*>\s*(.*)$/.exec(line);
  if (!handler) return null;
  const rest = handler[1].trim();
  if (rest.indexOf('{%') === 0) return { kind: 'script', inline: true, text: rest.slice(2) };
  return rest ? { kind: 'script', inline: false, path: rest } : null;
}

/**
 * Parses an IntelliJ-style .http file into a list of requests. Each request tracks the line of its request
 * line (for the gutter Run button) and the line span it covers (for placing the inline response and for
 * ⌘/⌥Enter).
 *
 * `vars` keeps the RAW text of each `@name = value`, not a resolved value: a variable may reference another
 * one, and a dynamic variable ({{$uuid}}) has to be evaluated per request rather than once per parse.
 */
function parseHttpRequests(content) {
  const lines = String(content).split(/\r?\n/);
  const requests = [];
  const vars = {};
  // Which lines belong to a {% … %} block, so the highlighter can treat them as JavaScript instead of as
  // .http syntax. Collected here because the parser is the only pass that knows where a block ends.
  const scriptLines = {};
  let curr = null;
  let phase = 'pre';
  let script = null; // an unterminated {% … %} block being collected
  function flush() {
    if (!curr) return;
    if (script && script.sink) { script.sink.text = script.lines.join('\n'); script = null; }
    if (curr.url) {
      curr.body = curr.bodyLines.join('\n').replace(/\s+$/, '');
      requests.push(curr);
    }
  }
  function start(boundaryLine, name, index) {
    return {
      name: name, method: '', url: '', httpVersion: '', headers: [], bodyLines: [], body: '',
      bodyFile: null, preScript: null, handler: null, output: null, auth: null,
      directives: emptyHttpDirectives(), kind: 'http',
      startLine: -1, endLine: index, boundaryLine: boundaryLine,
    };
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (script) {
      // Inside a {% … %} block, nothing else is syntax — a `###` in a script is JavaScript.
      scriptLines[i] = true;
      const end = rawLine.indexOf('%}');
      if (end < 0) { script.lines.push(rawLine); if (curr) curr.endLine = i; continue; }
      script.lines.push(rawLine.slice(0, end));
      script.sink.text = script.lines.join('\n').replace(/^\n/, '');
      script = null;
      if (curr) curr.endLine = i;
      continue;
    }
    if (trimmed.indexOf('###') === 0) {
      flush();
      curr = start(i, trimmed.replace(/^#+/, '').trim(), i);
      phase = 'pre';
      continue;
    }
    if (!curr) {
      curr = start(-1, '', i);
      phase = 'pre';
    }
    curr.endLine = i;
    if (phase === 'pre') {
      if (trimmed === '') continue;
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) {
        // A comment above the request line is where names and directives live.
        const name = httpRequestName(rawLine);
        if (name) { curr.name = name; continue; }
        applyHttpDirective(rawLine, curr.directives);
        continue;
      }
      // `< {% … %}` / `< ./script.js` before the request line is a PRE-REQUEST script. The same `<` after
      // the headers is an external body — the phase is the only thing that tells them apart.
      if (trimmed.charAt(0) === '<') {
        const inline = /^\s*<\s*\{%([\s\S]*)$/.exec(rawLine);
        if (inline) {
          curr.preScript = { text: '' };
          scriptLines[i] = true;
          script = { lines: [], sink: curr.preScript };
          const end = inline[1].indexOf('%}');
          if (end >= 0) { curr.preScript.text = inline[1].slice(0, end); script = null; }
          else script.lines.push(inline[1]);
          continue;
        }
        const spec = httpBodyFileSpec(rawLine);
        if (spec) { curr.preScript = { path: spec.path }; continue; }
      }
      const varMatch = /^@([\w.$-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (varMatch) { vars[varMatch[1]] = varMatch[2].trim(); continue; }
      const syntax = httpSyntax();
      const sp = trimmed.search(/\s/);
      const firstToken = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
      const upper = firstToken.toUpperCase();
      let target;
      if (sp >= 0 && (syntax.methods[upper] || syntax.unsupported[upper])) {
        curr.method = upper;
        curr.kind = upper === 'GRAPHQL' ? 'graphql'
          : upper === 'WEBSOCKET' ? 'websocket'
            : syntax.unsupported[upper] ? 'unsupported' : 'http';
        target = trimmed.slice(sp + 1).trim();
      } else {
        curr.method = 'GET'; // the short form: a bare URL on its own line
        target = trimmed;
      }
      const version = /\s+(HTTP\/[\d.]+(?:\s*\(Prior Knowledge\))?)\s*$/i.exec(target);
      if (version) { curr.httpVersion = version[1]; target = target.slice(0, version.index).trim(); }
      curr.url = target;
      curr.startLine = i;
      phase = 'headers';
      continue;
    }
    if (phase === 'headers') {
      // A URL split across lines: every continuation is indented and starts with /, ? or & (IntelliJ's
      // rule). Only before the first header, because after one a `  /x` line is a malformed header.
      if (!curr.headers.length && /^\s+[/?&#]/.test(rawLine) && !/^\s*#/.test(rawLine)) {
        curr.url += trimmed;
        continue;
      }
      if (trimmed === '') { phase = 'body'; continue; }
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) {
        applyHttpDirective(rawLine, curr.directives);
        continue;
      }
      if (trimmed.charAt(0) === '>') {
        // A handler or an output redirect can follow the headers with no body in between.
        const spec = httpRedirectSpec(rawLine);
        if (spec && spec.kind === 'output') { curr.output = { path: spec.path, force: spec.force }; continue; }
        if (spec && spec.inline) {
          curr.handler = { text: '' };
          scriptLines[i] = true;
          script = { lines: [], sink: curr.handler };
          const end = spec.text.indexOf('%}');
          if (end >= 0) { curr.handler.text = spec.text.slice(0, end); script = null; }
          else script.lines.push(spec.text);
          continue;
        }
        if (spec) { curr.handler = { path: spec.path }; continue; }
      }
      const colon = rawLine.indexOf(':');
      if (colon > 0) curr.headers.push({ name: rawLine.slice(0, colon).trim(), value: rawLine.slice(colon + 1).trim() });
      continue;
    }
    // phase === 'body'
    if (trimmed.charAt(0) === '>') {
      const spec = httpRedirectSpec(rawLine);
      if (spec && spec.kind === 'output') { curr.output = { path: spec.path, force: spec.force }; continue; }
      if (spec && spec.inline) {
        curr.handler = { text: '' };
        scriptLines[i] = true;
        script = { lines: [], sink: curr.handler };
        const end = spec.text.indexOf('%}');
        if (end >= 0) { curr.handler.text = spec.text.slice(0, end); script = null; }
        else script.lines.push(spec.text);
        continue;
      }
      if (spec) { curr.handler = { path: spec.path }; continue; }
    }
    // `< ./body.json` is the whole body; a later inline line would contradict it, so the first one wins.
    if (!curr.bodyLines.length && !curr.bodyFile && trimmed.charAt(0) === '<') {
      const spec = httpBodyFileSpec(rawLine);
      if (spec) { curr.bodyFile = spec; continue; }
    }
    curr.bodyLines.push(rawLine);
  }
  flush();
  // Unnamed requests are addressable by position, as in IntelliJ (#1, #2 …), and a duplicate name gets its
  // position appended so {{name.response…}} always refers to exactly one request.
  const taken = Object.create(null);
  requests.forEach(function (request, index) {
    request.index = index;
    const base = request.name || '#' + (index + 1);
    request.name = taken[base] ? base + (index + 1) : base;
    taken[request.name] = true;
  });
  return { requests: requests, vars: vars, scriptLines: scriptLines };
}

/**
 * `multipart/form-data` body -> parts. A part whose Content-Disposition carries a filename and whose content
 * is `< ./file` is sent as that file's bytes (main reads it); without a filename the same reference means
 * "send the file's contents as this field's text", which is IntelliJ's rule and a real difference on the wire.
 */
function parseHttpMultipart(bodyText, boundary) {
  const delimiter = '--' + boundary;
  const parts = [];
  let current = null;
  let inHeaders = false;
  String(bodyText || '').split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (trimmed === delimiter || trimmed === delimiter + '--') {
      if (current) parts.push(current);
      current = trimmed === delimiter ? { headers: {}, lines: [], file: null } : null;
      inHeaders = Boolean(current);
      return;
    }
    if (!current) return; // the preamble before the first delimiter is not part of the body
    if (inHeaders) {
      if (trimmed === '') { inHeaders = false; return; }
      const colon = line.indexOf(':');
      if (colon > 0) current.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      return;
    }
    if (!current.lines.length && !current.file && trimmed.charAt(0) === '<') {
      const spec = httpBodyFileSpec(line);
      if (spec) { current.file = spec; return; }
    }
    current.lines.push(line);
  });
  if (current) parts.push(current);
  return parts.map(function (part) {
    const disposition = part.headers['Content-Disposition'] || part.headers['content-disposition'] || '';
    const named = /filename\s*=/.test(disposition);
    return {
      headers: part.headers,
      file: part.file && named ? part.file.path : null,
      fileAsText: part.file && !named ? part.file.path : null,
      substitute: part.file ? part.file.substitute : false,
      text: part.lines.join('\r\n').replace(/\s+$/, ''),
    };
  });
}

/**
 * A WEBSOCKET body is a list of messages separated by `===`, and `=== wait-for-server` means "hold here
 * until the server has said something" — which is how a handshake is written down in the order it happens.
 */
function splitSocketMessages(bodyText) {
  const messages = [];
  let current = { text: '', waitForServer: false };
  let pendingWait = false;
  String(bodyText || '').split(/\r?\n/).forEach(function (line) {
    const separator = /^\s*===\s*(.*)$/.exec(line);
    if (!separator) { current.text += (current.text ? '\n' : '') + line; return; }
    messages.push(current);
    pendingWait = /wait-for-server/i.test(separator[1]);
    current = { text: '', waitForServer: pendingWait };
  });
  messages.push(current);
  return messages
    .map(function (message) { return { text: message.text.replace(/^\s+|\s+$/g, ''), waitForServer: message.waitForServer }; })
    // A separator with nothing after it is the end of the list, not an empty message. One that only says
    // "wait" is kept, because waiting IS the instruction.
    .filter(function (message) { return message.text || message.waitForServer; });
}

/**
 * A GRAPHQL request's body is the operation, optionally followed by a JSON object of variables. Split from
 * the END: the operation itself contains braces, so the only reliable marker is a trailing block that
 * parses as JSON on its own.
 */
function splitGraphqlBody(bodyText) {
  const text = String(bodyText || '');
  const blocks = text.split(/\n\s*\n/);
  if (blocks.length > 1) {
    const tail = blocks[blocks.length - 1].trim();
    if (tail.charAt(0) === '{') {
      try {
        const variables = JSON.parse(tail);
        return { query: blocks.slice(0, -1).join('\n\n').trim(), variables: variables };
      } catch (error) { /* not variables after all — it is part of the operation */ }
    }
  }
  return { query: text.trim(), variables: null };
}

// ---- variables --------------------------------------------------------------------------------------

function httpSharedVars() {
  return httpEnvironments.$shared || {};
}

function currentHttpEnv() {
  // The selected environment overrides $shared, which is the base every environment shares.
  return Object.assign({}, httpSharedVars(), httpEnvironments[currentHttpEnvName] || {});
}

/** Everything a {{name}} in `path`'s file can resolve against, in IntelliJ's precedence order. */
function httpScope(path, requestIndex) {
  return {
    path: path,
    vars: httpVarsByPath.get(path) || {},
    env: currentHttpEnv(),
    dotenv: httpEnvironments.$dotenv || {},
    processEnv: httpEnvironments.$env || {},
    globals: httpGlobals,
    requestVars: httpRequestVars.get(path + '#' + requestIndex) || {},
    responses: httpResponsesByName,
  };
}

function httpRandomInt(from, to) {
  return Math.floor(Math.random() * (to - from)) + from;
}

function httpRandomString(length, alphabet) {
  let out = '';
  for (let i = 0; i < (Number(length) || 0); i++) out += alphabet.charAt(httpRandomInt(0, alphabet.length));
  return out;
}

var HTTP_FAKER_WORDS_CACHE = null;
function httpFakerWords() {
  if (HTTP_FAKER_WORDS_CACHE) return HTTP_FAKER_WORDS_CACHE;
  HTTP_FAKER_WORDS_CACHE = {
  name: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Barbara Liskov', 'Edsger Dijkstra'],
  first_name: ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger'],
  last_name: ['Lovelace', 'Hopper', 'Turing', 'Liskov', 'Dijkstra'],
  city: ['Cambridge', 'Seoul', 'Delft', 'Zurich', 'Osaka'],
  company: ['Kakapo Labs', 'Northwind', 'Initech', 'Globex', 'Umbrella'],
  word: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
  phone: ['+1-202-555-0143', '+82-2-555-0176', '+31-20-555-0112'],
  };
  return HTTP_FAKER_WORDS_CACHE;
}

/**
 * `{{$uuid}}`, `{{$timestamp}}`, `{{$random.integer(1, 10)}}` … Returns `undefined` for a name this port
 * does not implement, so the caller can say so instead of sending the literal text.
 *
 * IntelliJ's `$random.*` is backed by Java Faker's several hundred generators. The handful below are the
 * ones .http files actually use; the rest resolve to undefined and are reported by name.
 */
function httpDynamicValue(name) {
  if (name === '$uuid' || name === '$random.uuid') {
    // crypto.randomUUID is present in Electron and in jsdom; the fallback keeps a browser review working.
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      const value = Math.random() * 16 | 0;
      return (char === 'x' ? value : (value & 0x3 | 0x8)).toString(16);
    });
  }
  if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
  if (name === '$isoTimestamp') return new Date().toISOString();
  if (name === '$randomInt') return String(httpRandomInt(0, 1001));
  if (name === '$projectRoot') return ''; // paths stay repository-relative: main is the only side that knows the root
  if (name === '$historyFolder') return '$historyFolder'; // a sentinel main maps to its own user-data mirror
  const call = /^\$random\.([\w.]+)(?:\(([^)]*)\))?$/.exec(name);
  if (!call) return undefined;
  const generator = call[1];
  const args = (call[2] || '').split(',').map(function (part) { return part.trim(); }).filter(Boolean);
  if (generator === 'integer') return String(httpRandomInt(Number(args[0]) || 0, Number(args[1]) || 1001));
  if (generator === 'float') {
    const from = Number(args[0]) || 0;
    const to = args.length > 1 ? Number(args[1]) : 1;
    return String(from + Math.random() * (to - from));
  }
  if (generator === 'alphabetic') return httpRandomString(args[0], 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (generator === 'alphanumeric') return httpRandomString(args[0], 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  if (generator === 'hexadecimal') return httpRandomString(args[0], '0123456789abcdef');
  if (generator === 'email') return httpRandomString(8, 'abcdefghijklmnopqrstuvwxyz') + '@example.com';
  if (httpFakerWords()[generator]) {
    const pool = httpFakerWords()[generator];
    return pool[httpRandomInt(0, pool.length)];
  }
  return undefined;
}

/**
 * Minimal JSONPath, enough for what .http files ask of it: `$.a.b`, `$.a[0].b`, `$['a.b']`, and `..name` for
 * the first match at any depth. Returns undefined when the path does not exist, which is how a caller tells
 * "no such field" from "the field is empty".
 */
function httpJsonPath(value, path) {
  const raw = String(path || '');
  // The recursive form is recognised BEFORE the leading `$.` is stripped: stripping first turns `$..id`
  // into `.id`, which reads as an ordinary path and finds nothing.
  const recursive = /^\$?\.\.(.+)$/.exec(raw);
  if (recursive) {
    const wanted = recursive[1].split(/[.[]/)[0];
    const queue = [value];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(node, wanted)) return node[wanted];
      Object.keys(node).forEach(function (key) { queue.push(node[key]); });
    }
    return undefined;
  }
  const expression = raw.replace(/^\$\.?/, '');
  if (!expression) return value;
  let cursor = value;
  const tokens = expression.match(/[^.[\]'"]+|\['[^']*'\]|\["[^"]*"\]|\[\d+\]/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    if (cursor == null) return undefined;
    const key = tokens[i].replace(/^\[['"]?|['"]?\]$/g, '');
    cursor = cursor[key];
  }
  return cursor;
}

/** `{{login.response.body.$.token}}` / `{{login.response.headers.Location}}`. */
function httpResponseReference(name, scope) {
  const match = /^([\w.$-]+?)\.response\.(body|headers|status)(?:\.(.+))?$/.exec(name);
  if (!match) return undefined;
  const stored = scope.responses.get(match[1]);
  if (!stored) return undefined;
  if (match[2] === 'status') return String(stored.status);
  if (match[2] === 'headers') {
    const headers = stored.headers || {};
    const wanted = String(match[3] || '').toLowerCase();
    const key = Object.keys(headers).filter(function (name) { return name.toLowerCase() === wanted; })[0];
    return key ? String(headers[key]) : undefined;
  }
  const resolved = match[3] ? httpJsonPath(stored.json, match[3]) : stored.json != null ? stored.json : stored.body;
  if (resolved === undefined) return undefined;
  return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
}

/**
 * One {{name}} -> its value, or undefined when nothing defines it.
 *
 * Precedence, nearest scope first: a pre-request script's variables, client.global, the file's own
 * `@name =`, the selected environment (which already has $shared folded under it), then the dynamic and
 * namespaced forms. `depth` stops a variable that references itself from recursing.
 */
function httpVarValue(name, scope, depth) {
  const level = Number(depth) || 0;
  if (level > 10) return undefined;
  const resolveRaw = function (raw) {
    return String(raw).indexOf('{{') < 0 ? String(raw) : applyHttpVars(raw, scope, level + 1);
  };
  if (name.charAt(0) === '$') {
    const namespaced = /^\$(env|processEnv|dotenv)\.(.+)$/.exec(name);
    if (namespaced) {
      const store = namespaced[1] === 'dotenv' ? scope.dotenv : scope.processEnv;
      return Object.prototype.hasOwnProperty.call(store, namespaced[2]) ? String(store[namespaced[2]]) : undefined;
    }
    return httpDynamicValue(name);
  }
  if (Object.prototype.hasOwnProperty.call(scope.requestVars, name)) return resolveRaw(scope.requestVars[name]);
  if (Object.prototype.hasOwnProperty.call(scope.globals, name)) return resolveRaw(scope.globals[name]);
  if (Object.prototype.hasOwnProperty.call(scope.vars, name)) return resolveRaw(scope.vars[name]);
  if (Object.prototype.hasOwnProperty.call(scope.env, name)) return resolveRaw(scope.env[name]);
  const reference = httpResponseReference(name, scope);
  if (reference !== undefined) return reference;
  // A dotted name is a JSONPath into a variable whose value is JSON — {{client.host.url}} reads
  // {"host": {"url": …}} out of the `client` variable (IntelliJ 2024.2+).
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const raw = Object.prototype.hasOwnProperty.call(scope.vars, head) ? scope.vars[head]
      : Object.prototype.hasOwnProperty.call(scope.env, head) ? scope.env[head]
        : Object.prototype.hasOwnProperty.call(scope.globals, head) ? scope.globals[head] : undefined;
    if (raw !== undefined) {
      try {
        const nested = httpJsonPath(typeof raw === 'string' ? JSON.parse(raw) : raw, name.slice(dot + 1));
        if (nested !== undefined) return typeof nested === 'object' ? JSON.stringify(nested) : String(nested);
      } catch (error) { /* not JSON: then this really is an undefined variable */ }
    }
  }
  return undefined;
}

/** Substitutes every {{name}} in `text`. An unknown name is left verbatim so the runner can name it. */
function applyHttpVars(text, scope, depth) {
  return String(text == null ? '' : text).replace(httpVarPattern(), function (whole, name) {
    const value = httpVarValue(name, scope, depth);
    return value === undefined ? whole : value;
  });
}

/** The first {{name}} in `text` that nothing resolves — the request's reason for not being sent. */
function httpUnresolvedVar(text, scope) {
  const pattern = httpVarPattern();
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    if (httpVarValue(match[1], scope, 0) === undefined) return match[1];
  }
  return '';
}
