// Running a request from a .http file: resolve it, send it, and feed the result back into the file's own
// scripts and into the variables a later request reads.
//
// The sequence matters and is IntelliJ's: pre-request script -> substitute -> send -> remember the response
// under the request's name -> response handler -> `>>` save. Each step can fail on its own terms, and each
// failure is rendered where the response would have been rather than thrown away in a console.

/** The source of a `< {% … %}` / `> ./handler.js` script. An external file is read by main (repo-confined). */
async function httpScriptSource(spec) {
  if (!spec) return { text: '' };
  if (typeof spec.text === 'string') return { text: spec.text };
  if (!spec.path) return { text: '' };
  const file = await readHttpFileText(spec.path);
  return file.ok ? { text: file.text } : { error: file.error };
}

/** Reads a repo-relative file for the runner; `undefined` bridge means a browser review, not a missing file. */
async function readHttpFileText(path) {
  if (!window.kakapoHttp || typeof window.kakapoHttp.readFile !== 'function') {
    return { ok: false, error: t('http.needsApp') };
  }
  try {
    const result = await window.kakapoHttp.readFile(path);
    return result && result.ok ? { ok: true, text: String(result.text || '') } : { ok: false, error: (result && result.error) || 'cannot read ' + path };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * Percent-encodes the characters that cannot appear in a URL literally. IntelliJ does this unless the
 * request says `# @no-auto-encoding`, and without it a `{{query}}` that resolved to "two words" produces a
 * URL the sender rejects. Existing %XX escapes are left alone — encoding them again is the classic
 * double-encoding bug.
 */
function encodeHttpUrl(url) {
  return String(url).replace(/%(?![0-9a-fA-F]{2})|[^\x21-\x7e]|[ "<>`^{}|\\]/g, function (char) {
    return Array.prototype.map.call(new TextEncoder().encode(char), function (byte) {
      return '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase();
    }).join('');
  });
}

/** `Authorization: Basic user pass` — IntelliJ's space-separated form, which main has to encode. */
function httpAuthFromHeader(value) {
  const match = /^\s*(Basic|Digest)\s+(\S+)\s+(\S.*)$/i.exec(String(value || ''));
  if (!match) return null;
  return { type: match[1].toLowerCase(), user: match[2], password: match[3].trim() };
}

function httpHeaderValue(headers, name) {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).filter(function (header) { return header.toLowerCase() === wanted; })[0];
  return key ? headers[key] : '';
}

/**
 * Turns a parsed request plus a variable scope into the exact payload main will send.
 *
 * Returns `{ error }` instead of a request when a {{variable}} has no value: the alternative is sending
 * "{{host}}/get" and reading back "unsupported URL scheme", which names the symptom and hides the cause.
 */
async function resolveHttpRequest(request, scope) {
  const headers = {};
  let auth = null;
  for (let i = 0; i < request.headers.length; i++) {
    const name = applyHttpVars(request.headers[i].name, scope, 0);
    if (!name) continue;
    const value = applyHttpVars(request.headers[i].value, scope, 0);
    if (name.toLowerCase() === 'authorization') {
      const parsed = httpAuthFromHeader(value);
      if (parsed) { auth = parsed; continue; } // not a sendable header value: main encodes it instead
    }
    headers[name] = value;
  }
  const url = applyHttpVars(request.url, scope, 0);
  const unresolved = httpUnresolvedVar(
    request.url + ' ' + request.headers.map(function (h) { return h.name + ' ' + h.value; }).join(' ')
    + ' ' + (request.body || ''), scope);
  if (unresolved) return { error: t('http.unresolved').replace(/\{name\}/g, unresolved) };

  const payload = {
    method: request.method === 'GRAPHQL' ? 'POST' : (request.method || 'GET'),
    url: request.directives.noAutoEncoding ? url : encodeHttpUrl(url),
    headers: headers,
    noRedirect: request.directives.noRedirect,
    noCookieJar: request.directives.noCookieJar,
    timeoutMs: request.directives.timeoutMs,
    connectTimeoutMs: request.directives.connectTimeoutMs,
    auth: auth,
  };

  if (request.kind === 'graphql') {
    const split = splitGraphqlBody(applyHttpVars(request.body, scope, 0));
    if (!httpHeaderValue(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    payload.body = JSON.stringify({ query: split.query, variables: split.variables || {} });
    return { request: payload };
  }

  const contentType = httpHeaderValue(headers, 'content-type');
  if (/multipart\/form-data/i.test(contentType)) {
    // The boundary belongs in the header, but a file that leaves it out still says what it is on its first
    // delimiter line — read it from there rather than refusing a request whose intent is unambiguous.
    const declared = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType);
    const sniffed = /^\s*--(\S+)\s*$/m.exec(request.body || '');
    const boundary = declared ? declared[1] : sniffed ? sniffed[1] : '';
    if (!boundary) return { error: t('http.noBoundary') };
    if (!declared) {
      const key = Object.keys(headers).filter(function (name) { return name.toLowerCase() === 'content-type'; })[0];
      headers[key] = contentType.replace(/\s*;?\s*$/, '') + '; boundary=' + boundary;
    }
    const parsed = parseHttpMultipart(request.body, boundary);
    const parts = [];
    for (let i = 0; i < parsed.length; i++) {
      const part = parsed[i];
      const partHeaders = {};
      Object.keys(part.headers).forEach(function (name) { partHeaders[name] = applyHttpVars(part.headers[name], scope, 0); });
      if (part.file) { parts.push({ headers: partHeaders, file: part.file }); continue; }
      if (part.fileAsText) {
        // No filename on the disposition: IntelliJ sends the file's CONTENTS as this field's text.
        const file = await readHttpFileText(part.fileAsText);
        if (!file.ok) return { error: file.error };
        parts.push({ headers: partHeaders, text: part.substitute ? applyHttpVars(file.text, scope, 0) : file.text });
        continue;
      }
      parts.push({ headers: partHeaders, text: applyHttpVars(part.text, scope, 0) });
    }
    payload.bodyParts = parts;
    payload.boundary = boundary;
    return { request: payload };
  }

  if (request.bodyFile) {
    if (!request.bodyFile.substitute) {
      // Raw: main reads the bytes, so a binary body never passes through a JS string.
      payload.bodyFile = request.bodyFile.path;
      return { request: payload };
    }
    const file = await readHttpFileText(request.bodyFile.path);
    if (!file.ok) return { error: file.error };
    const unresolvedInFile = httpUnresolvedVar(file.text, scope);
    if (unresolvedInFile) return { error: t('http.unresolved').replace(/\{name\}/g, unresolvedInFile) };
    payload.body = applyHttpVars(file.text, scope, 0);
    return { request: payload };
  }

  if (request.body) payload.body = applyHttpVars(request.body, scope, 0);
  return { request: payload };
}

/** The WebSocket half of the bridge; absent in a browser review, like sendHttp's. */
function sendSocket(request) {
  if (window.kakapoHttp && typeof window.kakapoHttp.sendSocket === 'function') {
    return Promise.resolve(window.kakapoHttp.sendSocket(request));
  }
  return Promise.resolve({ ok: false, transcript: [], durationMs: 0, error: t('http.needsApp') });
}

function sendHttp(request) {
  if (window.kakapoHttp && typeof window.kakapoHttp.send === 'function') {
    return Promise.resolve(window.kakapoHttp.send(request));
  }
  // A browser/static review has no main process to send through. Say that, rather than failing as if the
  // request itself were wrong.
  return Promise.resolve({ ok: false, error: t('http.needsApp'), durationMs: 0 });
}

/** Remembers a response under its request's name, for {{login.response.body.$.token}}. */
function rememberHttpResponse(request, result) {
  if (request.directives.noLog || !result || !result.ok) return;
  const text = result.body == null ? '' : String(result.body);
  let json = null;
  try { json = JSON.parse(text); } catch (error) { /* a text response is still referable as .body */ }
  httpResponsesByName.set(request.name, {
    status: result.status, headers: result.headers || {}, body: text, json: json,
  });
}

// `path` and `target` are passed in because this is no longer only the source view's runner: the diff
// shows .http files too, and a request there is the same request. Both default to the source view, which
// is where every existing caller runs from.
async function runHttpRequest(reqIndex, pathOverride, targetOverride) {
  const path = pathOverride || document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests[reqIndex]) return;
  const request = requests[reqIndex];
  const target = targetOverride || document.getElementById('http-resp-' + reqIndex);
  const key = path + '#' + reqIndex;
  const fail = function (message) {
    if (target) renderHttpFailure(target, message);
    showToast(message);
  };

  if (request.kind === 'unsupported') {
    fail(t('http.unsupportedProtocol').replace('{method}', request.method));
    return;
  }
  if (request.kind === 'websocket') {
    await runWebSocketRequest(request, path, reqIndex, target, fail);
    return;
  }

  // A pre-request script's variables belong to this run, not to every run since the file was opened.
  httpRequestVars.delete(key);
  const log = { lines: [], tests: [] };
  httpScriptLogByRequest.set(key, log);
  let scope = httpScope(path, reqIndex);

  const pre = await httpScriptSource(request.preScript);
  if (pre.error) { fail(pre.error); return; }
  if (pre.text) {
    const outcome = await runHttpScript(pre.text, {
      client: httpClientApi(log), request: httpRequestApi(request, scope, key),
    });
    if (!outcome.ok) { fail(t('http.preScriptFailed').replace('{error}', outcome.error)); return; }
    scope = httpScope(path, reqIndex); // request.variables.set() happened; rebuild so it is visible
  }

  const resolved = await resolveHttpRequest(request, scope);
  if (resolved.error) { fail(resolved.error); return; }

  if (target) {
    target.className = 'http-response loading';
    target.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span class="http-loading-copy">'
      + escapeHtml(resolved.request.method + ' ' + resolved.request.url) + '</span>';
  }

  let result;
  try {
    result = await sendHttp(resolved.request);
  } catch (error) {
    fail(String(error && error.message ? error.message : error));
    return;
  }
  rememberHttpResponse(request, result);

  const handler = await httpScriptSource(request.handler);
  if (handler.error) log.error = handler.error;
  else if (handler.text) {
    const outcome = await runHttpScript(handler.text, {
      client: httpClientApi(log),
      request: httpRequestApi(request, scope, key),
      response: httpResponseApi(result),
    });
    if (!outcome.ok) log.error = outcome.error;
  }

  let saved = null;
  if (request.output && result && result.ok) saved = await saveHttpResponseFile(request, result, scope);

  if (target) renderHttpResponse(target, result, { log: log, saved: saved, request: resolved.request });
  return result;
}

/** `>> out.json` / `>>! out.json`. The path is substituted first, so {{$historyFolder}} resolves. */
async function saveHttpResponseFile(request, result, scope) {
  const path = applyHttpVars(request.output.path, scope, 0);
  if (!window.kakapoHttp || typeof window.kakapoHttp.saveResponse !== 'function') {
    return { ok: false, error: t('http.needsApp') };
  }
  try {
    const body = result.body != null ? String(result.body) : '';
    const outcome = await window.kakapoHttp.saveResponse({ path: path, force: request.output.force, body: body });
    return outcome && outcome.ok ? { ok: true, path: outcome.path } : { ok: false, error: (outcome && outcome.error) || 'save failed' };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/** The open .http file, or '' — the one place the runner's keyboard entry points ask where they are. */
function httpOpenPath() {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  return isHttpFile(path) ? path : '';
}

/**
 * Which request the caret is in. A caret inside a request's span picks that request; a caret below the last
 * one picks the last — the same rule ⌘Enter has always used, now shared with the cURL copy so the two keys
 * cannot disagree about which request the reviewer means.
 */
function httpRequestIndexAtCaret(path) {
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests.length) return -1;
  const caretLine = viewerCursor && viewerCursor.path === path ? viewerCursor.lineIndex : 0;
  let chosen = -1;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const from = req.boundaryLine >= 0 ? req.boundaryLine : req.startLine;
    if (from <= caretLine && caretLine <= req.endLine) return i;
    if (from <= caretLine) chosen = i;
  }
  return chosen < 0 ? 0 : chosen;
}

function runHttpAtCaret() {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const chosen = httpRequestIndexAtCaret(path);
  if (chosen >= 0) runHttpRequest(chosen);
}

/**
 * Runs every request in the open .http file, in file order and one at a time — which is the only order that
 * makes a file a sequence: a login request's handler sets the token the next request sends.
 */
async function runHttpFile() {
  const path = httpOpenPath();
  const requests = httpRequestsByPath.get(path);
  if (!path || !requests || !requests.length) return;
  showToast(t('http.runningAll').replace('{count}', String(requests.length)));
  let failures = 0;
  for (let i = 0; i < requests.length; i++) {
    const result = await runHttpRequest(i, path);
    if (!result || !result.ok) failures += 1;
  }
  showToast(failures
    ? t('http.ranAllWithFailures').replace('{count}', String(requests.length)).replace('{failed}', String(failures))
    : t('http.ranAll').replace('{count}', String(requests.length)));
}

/**
 * Copies the request as a cURL command — the shape of it a reviewer pastes into a terminal, an issue or a
 * message. The reverse direction (pasting cURL in to get a request) is deliberately absent: kakapo never
 * writes to the file under review, so there would be nowhere to put it.
 */
async function copyHttpAsCurl(reqIndex, pathOverride) {
  const path = pathOverride || document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests[reqIndex]) return false;
  const request = requests[reqIndex];
  const resolved = await resolveHttpRequest(request, httpScope(path, reqIndex));
  if (resolved.error) { showToast(resolved.error); return false; }
  const quote = function (value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; };
  const parts = ['curl'];
  if (resolved.request.method !== 'GET') parts.push('-X', resolved.request.method);
  parts.push(quote(resolved.request.url));
  Object.keys(resolved.request.headers).forEach(function (name) {
    parts.push('-H', quote(name + ': ' + resolved.request.headers[name]));
  });
  if (resolved.request.auth) parts.push(resolved.request.auth.type === 'digest' ? '--digest' : '--basic',
    '-u', quote(resolved.request.auth.user + ':' + resolved.request.auth.password));
  if (!resolved.request.noRedirect) parts.push('-L');
  if (resolved.request.bodyFile) parts.push('--data-binary', quote('@' + resolved.request.bodyFile));
  else if (resolved.request.bodyParts) {
    resolved.request.bodyParts.forEach(function (part) {
      const disposition = part.headers['Content-Disposition'] || part.headers['content-disposition'] || '';
      const name = (/name\s*=\s*"([^"]*)"/.exec(disposition) || [])[1] || 'field';
      parts.push('-F', quote(name + '=' + (part.file ? '@' + part.file : part.text || '')));
    });
  } else if (resolved.request.body) parts.push('--data-raw', quote(resolved.request.body));
  const command = parts.join(' ');
  copyTextToClipboard(command);
  showToast(t('http.copiedCurl'));
  return true;
}

/**
 * A WEBSOCKET request: open the socket, send what the file lists, show the transcript.
 *
 * Shares the variable scope and the `@timeout` directive with every other request, and nothing else —
 * there is no status line, no headers and no body to save, because what came back is an exchange rather
 * than a response.
 */
async function runWebSocketRequest(request, path, reqIndex, target, fail) {
  const scope = httpScope(path, reqIndex);
  const url = applyHttpVars(request.url, scope, 0);
  const unresolved = httpUnresolvedVar(request.url + ' ' + (request.body || ''), scope);
  if (unresolved) { fail(t('http.unresolved').replace(/\{name\}/g, unresolved)); return; }
  const protocols = request.headers
    .filter(function (header) { return header.name.toLowerCase() === 'sec-websocket-protocol'; })
    .map(function (header) { return applyHttpVars(header.value, scope, 0); })
    .join(',')
    .split(',')
    .map(function (value) { return value.trim(); })
    .filter(Boolean);
  const messages = splitSocketMessages(applyHttpVars(request.body, scope, 0));
  if (target) {
    target.className = 'http-response loading';
    target.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span class="http-loading-copy">'
      + escapeHtml('WEBSOCKET ' + url) + '</span>';
  }
  const result = await sendSocket({
    url: url,
    protocols: protocols,
    messages: messages,
    timeoutMs: request.directives.timeoutMs,
  });
  if (target) renderWebSocketTranscript(target, result);
  return result;
}
