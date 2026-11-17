
function isHttpFile(path) {
  return /\.(http|rest)$/i.test(path || '');
}

var HTTP_SYNTAX = null;
function httpSyntax() {
  if (HTTP_SYNTAX) return HTTP_SYNTAX;
  HTTP_SYNTAX = {
    methods: {
      GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1, OPTIONS: 1, TRACE: 1, CONNECT: 1, GRAPHQL: 1,
      WEBSOCKET: 1,
    },
    unsupported: { GRPC: 1, GRPCS: 1 },
    directives: {
      'no-redirect': 1, 'no-cookie-jar': 1, 'no-log': 1, 'no-auto-encoding': 1,
      'use-os-credentials': 1, timeout: 1, 'connection-timeout': 1, name: 1,
    },
  };
  return HTTP_SYNTAX;
}

function httpVarPattern() {
  return /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
}

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

function parseHttpRunLine(line) {
  const match = /^\s*(run|import)\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  const verb = match[1];
  let rest = match[2];
  const overrides = {};
  const tail = /\(([^)]*)\)\s*$/.exec(rest);
  if (tail) {
    rest = rest.slice(0, tail.index).trim();
    tail[1].split(',').forEach(function (pair) {
      const assignment = /^\s*@?([\w.$-]+)\s*=\s*(.*?)\s*$/.exec(pair);
      if (assignment) overrides[assignment[1]] = assignment[2];
    });
  }
  if (!rest) return null;
  const named = /^(.*?)#([^#]+)$/.exec(rest);
  return {
    verb: verb,
    path: named ? named[1].trim() : (rest.charAt(0) === '#' ? '' : rest),
    requestName: named ? named[2].trim() : (rest.charAt(0) === '#' ? rest.slice(1).trim() : ''),
    overrides: overrides,
  };
}

function httpRequestName(line) {
  const named = /^\s*(?:#+|\/\/)\s*@name\s*=?\s*(.+)$/.exec(line);
  return named ? named[1].trim() : '';
}

function httpBodyFileSpec(line) {
  const match = /^\s*<(@([\w-]*))?\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { path: match[3], substitute: Boolean(match[1]), encoding: (match[2] || '').toLowerCase() };
}

function httpRedirectSpec(line) {
  const output = /^\s*>>(!?)\s+(.+?)\s*$/.exec(line);
  if (output) return { kind: 'output', path: output[2], force: output[1] === '!' };
  const handler = /^\s*>\s*(.*)$/.exec(line);
  if (!handler) return null;
  const rest = handler[1].trim();
  if (rest.indexOf('{%') === 0) return { kind: 'script', inline: true, text: rest.slice(2) };
  return rest ? { kind: 'script', inline: false, path: rest } : null;
}

function parseHttpRequests(content) {
  const lines = String(content).split(/\r?\n/);
  const requests = [];
  const vars = {};
  const imports = [];
  const scriptLines = {};
  let curr = null;
  let phase = 'pre';
  let script = null;
  function flush() {
    if (!curr) return;
    if (script && script.sink) { script.sink.text = script.lines.join('\n'); script = null; }
    if (curr.url || curr.runSpec) {
      curr.body = curr.bodyLines.join('\n').replace(/\s+$/, '');
      requests.push(curr);
    }
  }
  function start(boundaryLine, name, index) {
    return {
      name: name, method: '', url: '', httpVersion: '', headers: [], bodyLines: [], body: '',
      bodyFile: null, preScript: null, handler: null, output: null, auth: null, runSpec: null,
      directives: emptyHttpDirectives(), kind: 'http',
      startLine: -1, endLine: index, boundaryLine: boundaryLine,
    };
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (script) {
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
        const name = httpRequestName(rawLine);
        if (name) { curr.name = name; continue; }
        applyHttpDirective(rawLine, curr.directives);
        continue;
      }
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
      const runLine = parseHttpRunLine(trimmed);
      if (runLine) {
        if (runLine.verb === 'import') { imports.push(runLine.path); continue; }
        curr.runSpec = runLine;
        curr.method = 'RUN';
        curr.kind = 'run';
        curr.startLine = i;
        curr.name = curr.name
          || ('run ' + (runLine.path || '') + (runLine.requestName ? '#' + runLine.requestName : '')).trim();
        flush();
        curr = start(-1, '', i);
        phase = 'pre';
        continue;
      }
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
        curr.method = 'GET';
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
    if (!curr.bodyLines.length && !curr.bodyFile && trimmed.charAt(0) === '<') {
      const spec = httpBodyFileSpec(rawLine);
      if (spec) { curr.bodyFile = spec; continue; }
    }
    curr.bodyLines.push(rawLine);
  }
  flush();
  const taken = Object.create(null);
  requests.forEach(function (request, index) {
    request.index = index;
    const base = request.name || '#' + (index + 1);
    request.name = taken[base] ? base + (index + 1) : base;
    taken[request.name] = true;
  });
  return { requests: requests, vars: vars, scriptLines: scriptLines, imports: imports };
}

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
    if (!current) return;
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
    .filter(function (message) { return message.text || message.waitForServer; });
}

function splitGraphqlBody(bodyText) {
  const text = String(bodyText || '');
  const blocks = text.split(/\n\s*\n/);
  if (blocks.length > 1) {
    const tail = blocks[blocks.length - 1].trim();
    if (tail.charAt(0) === '{') {
      try {
        const variables = JSON.parse(tail);
        return { query: blocks.slice(0, -1).join('\n\n').trim(), variables: variables };
      } catch (error) { }
    }
  }
  return { query: text.trim(), variables: null };
}

function httpSharedVars() {
  return httpEnvironments.$shared || {};
}

function currentHttpSsl() {
  const store = httpEnvironments.$ssl || {};
  const raw = store[currentHttpEnvName];
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch (error) { return undefined; }
}

function currentHttpEnv() {
  return Object.assign({}, httpSharedVars(), httpEnvironments[currentHttpEnvName] || {});
}

function httpScope(path, requestIndex) {
  return {
    path: path,
    vars: httpVarsByPath.get(path) || {},
    env: currentHttpEnv(),
    dotenv: httpEnvironments.$dotenv || {},
    processEnv: httpEnvironments.$env || {},
    globals: httpGlobals,
    requestVars: httpRequestVars.get(path + '#' + requestIndex) || {},
    iteration: 0,
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

function httpDynamicValue(name) {
  if (name === '$uuid' || name === '$random.uuid') {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      const value = Math.random() * 16 | 0;
      return (char === 'x' ? value : (value & 0x3 | 0x8)).toString(16);
    });
  }
  if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
  if (name === '$isoTimestamp') return new Date().toISOString();
  if (name === '$randomInt') return String(httpRandomInt(0, 1001));
  if (name === '$projectRoot') return '';
  if (name === '$historyFolder') return '$historyFolder';
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

function httpJsonPath(value, path) {
  const raw = String(path || '');
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

function httpVarValue(name, scope, depth) {
  const level = Number(depth) || 0;
  if (level > 10) return undefined;
  const resolveRaw = function (raw) {
    const element = httpCollectionElement(raw, scope);
    if (element !== undefined) raw = element;
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
      } catch (error) { }
    }
  }
  return undefined;
}

function httpCollectionElement(raw, scope) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.charAt(0) !== '[') return undefined;
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return undefined; }
  if (!Array.isArray(parsed) || !parsed.length) return undefined;
  const at = Math.max(0, Math.min(Number(scope && scope.iteration) || 0, parsed.length - 1));
  const value = parsed[at];
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function httpCollectionLength(text, scope) {
  let longest = 1;
  const pattern = httpVarPattern();
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const name = match[1];
    const raw = Object.prototype.hasOwnProperty.call(scope.requestVars, name) ? scope.requestVars[name]
      : Object.prototype.hasOwnProperty.call(scope.globals, name) ? scope.globals[name]
        : Object.prototype.hasOwnProperty.call(scope.vars, name) ? scope.vars[name]
          : Object.prototype.hasOwnProperty.call(scope.env, name) ? scope.env[name] : undefined;
    const value = String(raw == null ? '' : raw).trim();
    if (value.charAt(0) !== '[') continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) longest = Math.max(longest, parsed.length);
    } catch (error) { }
  }
  return longest;
}

function applyHttpVars(text, scope, depth) {
  return String(text == null ? '' : text).replace(httpVarPattern(), function (whole, name) {
    const value = httpVarValue(name, scope, depth);
    return value === undefined ? whole : value;
  });
}

function httpUnresolvedVar(text, scope) {
  const pattern = httpVarPattern();
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    if (httpVarValue(match[1], scope, 0) === undefined) return match[1];
  }
  return '';
}
