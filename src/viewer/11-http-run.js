
async function httpScriptSource(spec) {
  if (!spec) return { text: '' };
  if (typeof spec.text === 'string') return { text: spec.text };
  if (!spec.path) return { text: '' };
  const file = await readHttpFileText(spec.path);
  return file.ok ? { text: file.text } : { error: file.error };
}

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

function encodeHttpUrl(url) {
  return String(url).replace(/%(?![0-9a-fA-F]{2})|[^\x21-\x7e]|[ "<>`^{}|\\]/g, function (char) {
    return Array.prototype.map.call(new TextEncoder().encode(char), function (byte) {
      return '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase();
    }).join('');
  });
}

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

async function resolveHttpRequest(request, scope) {
  const headers = {};
  let auth = null;
  for (let i = 0; i < request.headers.length; i++) {
    const name = applyHttpVars(request.headers[i].name, scope, 0);
    if (!name) continue;
    const value = applyHttpVars(request.headers[i].value, scope, 0);
    if (name.toLowerCase() === 'authorization') {
      const parsed = httpAuthFromHeader(value);
      if (parsed) { auth = parsed; continue; }
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
    ssl: currentHttpSsl(),
  };

  if (request.kind === 'graphql') {
    const split = splitGraphqlBody(applyHttpVars(request.body, scope, 0));
    if (!httpHeaderValue(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    payload.body = JSON.stringify({ query: split.query, variables: split.variables || {} });
    return { request: payload };
  }

  const contentType = httpHeaderValue(headers, 'content-type');
  if (/multipart\/form-data/i.test(contentType)) {
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
  return Promise.resolve({ ok: false, error: t('http.needsApp'), durationMs: 0 });
}

function rememberHttpResponse(request, result) {
  if (request.directives.noLog || !result || !result.ok) return;
  const text = result.body == null ? '' : String(result.body);
  let json = null;
  try { json = JSON.parse(text); } catch (error) { }
  httpResponsesByName.set(request.name, {
    status: result.status, headers: result.headers || {}, body: text, json: json,
  });
}

async function runHttpRequest(reqIndex, pathOverride, targetOverride) {
  const path = pathOverride || sourceOpenPath();
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
  if (request.kind === 'run') {
    await runHttpRunDirective(request, path, target, fail);
    return;
  }

  httpRequestVars.delete(key);
  const log = { lines: [], tests: [] };
  httpScriptLogByRequest.set(key, log);
  let scope = httpScope(path, reqIndex);

  const pre = await httpScriptSource(request.preScript);
  if (pre.error) { fail(pre.error); return; }
  if (pre.text) {
    const outcome = await runHttpScript(pre.text, {
      client: httpClientApi(log), request: httpRequestApi(request, scope, key),
      path: path,
    });
    if (!outcome.ok) { fail(t('http.preScriptFailed').replace('{error}', outcome.error)); return; }
    scope = httpScope(path, reqIndex);
  }

  const iterations = httpCollectionLength(
    request.url + ' ' + request.headers.map(function (h) { return h.name + ' ' + h.value; }).join(' ')
      + ' ' + (request.body || ''), scope);
  if (iterations > 1) {
    return await runHttpCollection(request, path, reqIndex, target, fail, log, iterations);
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
      path: path,
    });
    if (!outcome.ok) log.error = outcome.error;
  }

  let saved = null;
  if (request.output && result && result.ok) saved = await saveHttpResponseFile(request, result, scope);

  if (target) renderHttpResponse(target, result, { log: log, saved: saved, request: resolved.request });
  return result;
}

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

function httpOpenPath() {
  const path = sourceOpenPath();
  return isHttpFile(path) ? path : '';
}

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
  const path = sourceOpenPath();
  const chosen = httpRequestIndexAtCaret(path);
  if (chosen >= 0) runHttpRequest(chosen);
}

async function runHttpFile() {
  const path = httpOpenPath();
  const requests = httpRequestsByPath.get(path);
  if (!path || !requests || !requests.length) return;
  showToast(t('http.runningAll', { count: requests.length }));
  let failures = 0;
  for (let i = 0; i < requests.length; i++) {
    const result = await runHttpRequest(i, path);
    if (!result || !result.ok) failures += 1;
  }
  showToast(failures
    ? t('http.ranAllWithFailures', { count: requests.length, failed: failures })
    : t('http.ranAll', { count: requests.length }));
}

async function copyHttpAsCurl(reqIndex, pathOverride) {
  const path = pathOverride || sourceOpenPath();
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

function resolveHttpRunPath(from, target) {
  const wanted = String(target || '').replace(/\\/g, '/').trim();
  if (!wanted) return from;
  if (wanted.charAt(0) === '/') return wanted.slice(1);
  const base = String(from || '').replace(/\/[^/]*$/, '');
  const parts = (base ? base.split('/') : []).concat(wanted.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

async function loadHttpRequestsOf(path) {
  const known = httpRequestsByPath.get(path);
  if (known) return known;
  const file = sourceByPath.get(path);
  let content = file && sourceContentLoaded(file) ? file.content : '';
  if (!content) {
    const read = await readHttpFileText(path);
    if (!read.ok) return null;
    content = read.text;
  }
  const parsed = parseHttpRequests(content);
  httpRequestsByPath.set(path, parsed.requests);
  httpVarsByPath.set(path, parsed.vars);
  httpImportsByPath.set(path, parsed.imports);
  return parsed.requests;
}

async function httpRunTargets(spec, fromPath) {
  const direct = resolveHttpRunPath(fromPath, spec.path);
  const candidates = [direct];
  if (!spec.path) {
    for (const imported of httpImportsByPath.get(fromPath) || []) {
      candidates.push(resolveHttpRunPath(fromPath, imported));
    }
  }
  for (const candidate of candidates) {
    const requests = await loadHttpRequestsOf(candidate);
    if (!requests) continue;
    const sendable = requests.filter(function (request) { return request.kind !== 'run'; });
    if (!spec.requestName) return { path: candidate, requests: sendable };
    const named = sendable.filter(function (request) { return request.name === spec.requestName; });
    if (named.length) return { path: candidate, requests: named };
  }
  return null;
}

async function runHttpRunDirective(request, path, target, fail) {
  const spec = request.runSpec;
  if (!spec) return;
  const found = await httpRunTargets(spec, path);
  if (!found) {
    fail(t(spec.requestName ? 'http.runNoRequest' : 'http.runNoFile')
      .replace('{name}', spec.requestName || spec.path));
    return;
  }
  if (httpRunStack.indexOf(found.path) >= 0) {
    fail(t('http.runLoop').replace('{file}', found.path));
    return;
  }
  const overrides = Object.keys(spec.overrides || {});
  const saved = httpVarsByPath.get(found.path) || {};
  if (overrides.length) httpVarsByPath.set(found.path, Object.assign({}, saved, spec.overrides));

  if (target) {
    target.className = 'http-response loading';
    target.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span class="http-loading-copy">'
      + escapeHtml(t('http.runningAll', { count: found.requests.length })) + '</span>';
  }
  httpRunStack.push(found.path);
  const outcomes = [];
  try {
    for (let i = 0; i < found.requests.length; i++) {
      const index = httpRequestsByPath.get(found.path).indexOf(found.requests[i]);
      const result = await runHttpRequest(index, found.path, null);
      outcomes.push({ name: found.requests[i].name, ok: Boolean(result && result.ok), status: result && result.status });
    }
  } finally {
    httpRunStack.pop();
    if (overrides.length) httpVarsByPath.set(found.path, saved);
  }
  if (target) renderHttpRunSummary(target, found.path, outcomes);
}

async function runHttpCollection(request, path, reqIndex, target, fail, log, iterations) {
  const outcomes = [];
  if (target) {
    target.className = 'http-response loading';
    target.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span class="http-loading-copy">'
      + escapeHtml(t('http.runningAll', { count: iterations })) + '</span>';
  }
  for (let at = 0; at < iterations; at++) {
    const scope = httpScope(path, reqIndex);
    scope.iteration = at;
    const resolved = await resolveHttpRequest(request, scope);
    if (resolved.error) { fail(resolved.error); return; }
    let result;
    try {
      result = await sendHttp(resolved.request);
    } catch (error) {
      fail(String(error && error.message ? error.message : error));
      return;
    }
    rememberHttpResponse(request, result);
    const handler = await httpScriptSource(request.handler);
    if (handler.text) {
      const outcome = await runHttpScript(handler.text, {
        client: httpClientApi(log),
        request: httpRequestApi(request, scope, path + '#' + reqIndex),
        response: httpResponseApi(result),
        path: path,
      });
      if (!outcome.ok) log.error = outcome.error;
    }
    outcomes.push({
      name: resolved.request.url,
      ok: Boolean(result && result.ok),
      status: result && result.status,
    });
  }
  if (target) renderHttpRunSummary(target, t('http.collection', { count: iterations }), outcomes);
  return outcomes[outcomes.length - 1];
}
