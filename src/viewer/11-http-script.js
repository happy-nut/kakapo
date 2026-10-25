// Pre-request and response-handler scripts: `< {% … %}` before a request, `> {% … %}` or `> ./handler.js`
// after it, running against IntelliJ's HTTP Response Handler API (client / request / response / crypto /
// jsonPath / xpath).
//
// WHERE this runs is the whole security design. The script is JavaScript that came with the repository under
// review, so it runs in the RENDERER — which Electron gives us sandboxed, with contextIsolation and no node
// integration (app-main.ts). There is no `require`, no `fs`, no `process`: the only thing reachable from
// inside is the kakapoHttp bridge, and a script only runs at all because the reviewer pressed Run on a
// request whose text they can read. Running these in main instead would hand a reviewed repo the filesystem.
//
// What is NOT ported, and is reported rather than silently ignored: `={% import … %}` shared modules (they
// need a module loader and a second file to resolve), and `$exampleServer` (IntelliJ bundles a server).

// ---- digests ----------------------------------------------------------------------------------------
// IntelliJ's crypto API is synchronous (crypto.sha256().updateWithText(x).digest().toHex()), and
// window.crypto.subtle is promise-based, so these are implemented rather than delegated. MD5 is here
// because the API offers it, not because anything should choose it.

function httpUtf8Bytes(text) {
  return new TextEncoder().encode(String(text == null ? '' : text));
}

function httpHexBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function httpBase64Bytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function httpBytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function httpBytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function httpConcatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Big-endian length-padded message blocks, shared by SHA-1 and SHA-256 (MD5 pads little-endian and does
// its own).
function httpShaPad(bytes) {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  return padded;
}

function httpSha1Bytes(bytes) {
  const padded = httpShaPad(bytes);
  const view = new DataView(padded.buffer);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const value = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (value << 1) | (value >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d)) : i < 40 ? (b ^ c ^ d) : i < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d);
      const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach(function (word, index) { outView.setInt32(index * 4, word); });
  return out;
}

var HTTP_SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function httpSha256Bytes(bytes) {
  const padded = httpShaPad(bytes);
  const view = new DataView(padded.buffer);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + HTTP_SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

var HTTP_MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function httpMd5Bytes(bytes) {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << HTTP_MD5_S[i]) | (f >>> (32 - HTTP_MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach(function (word, index) { outView.setUint32(index * 4, word, true); });
  return out;
}

function httpHmacBytes(hash, blockSize, key, message) {
  let secret = key.length > blockSize ? hash(key) : key;
  if (secret.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(secret, 0);
    secret = padded;
  }
  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = secret[i] ^ 0x36;
    outer[i] = secret[i] ^ 0x5c;
  }
  return hash(httpConcatBytes(outer, hash(httpConcatBytes(inner, message))));
}

/** The digest builder shape IntelliJ's scripts chain: update…().digest().toHex(). */
function httpDigestBuilder(hash, secret) {
  let message = new Uint8Array(0);
  let key = secret || null;
  const builder = {
    updateWithText: function (text) { message = httpConcatBytes(message, httpUtf8Bytes(text)); return builder; },
    updateWithHex: function (hex) { message = httpConcatBytes(message, httpHexBytes(hex)); return builder; },
    updateWithBase64: function (value) { message = httpConcatBytes(message, httpBase64Bytes(value)); return builder; },
    withTextSecret: function (text) { key = httpUtf8Bytes(text); return builder; },
    withHexSecret: function (hex) { key = httpHexBytes(hex); return builder; },
    withBase64Secret: function (value) { key = httpBase64Bytes(value); return builder; },
    digest: function () {
      const bytes = key ? httpHmacBytes(hash.fn, hash.blockSize, key, message) : hash.fn(message);
      return {
        toHex: function () { return httpBytesToHex(bytes); },
        toBase64: function () { return httpBytesToBase64(bytes); },
        toUint8Array: function () { return bytes; },
      };
    },
  };
  return builder;
}

function httpCryptoApi() {
  const sha1 = { fn: httpSha1Bytes, blockSize: 64 };
  const sha256 = { fn: httpSha256Bytes, blockSize: 64 };
  const md5 = { fn: httpMd5Bytes, blockSize: 64 };
  return {
    sha1: function () { return httpDigestBuilder(sha1); },
    sha256: function () { return httpDigestBuilder(sha256); },
    md5: function () { return httpDigestBuilder(md5); },
    hmac: {
      sha1: function () { return httpDigestBuilder(sha1, new Uint8Array(0)); },
      sha256: function () { return httpDigestBuilder(sha256, new Uint8Array(0)); },
      md5: function () { return httpDigestBuilder(md5, new Uint8Array(0)); },
    },
  };
}

// ---- the script API ---------------------------------------------------------------------------------

/** XPath over an XML response, using the browser's own parser — the one dependency-free way to do it. */
function httpXPath(xml, expression) {
  try {
    const document_ = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
    const result = document_.evaluate(String(expression || ''), document_, null, 0, null);
    if (result.resultType === 1) return result.numberValue;
    if (result.resultType === 2) return result.stringValue;
    if (result.resultType === 3) return result.booleanValue;
    const nodes = [];
    let node = result.iterateNext();
    while (node) { nodes.push(node.textContent); node = result.iterateNext(); }
    return nodes.length === 1 ? nodes[0] : nodes;
  } catch (error) { return undefined; }
}

var HTTP_SCRIPT_EXIT = 'kakapo-http-script-exit';

/**
 * Builds the `client` object. `log` and `tests` are the script's visible output: the response panel renders
 * them, because a handler that quietly asserts nothing is indistinguishable from one that passed.
 */
function httpClientApi(log) {
  return {
    global: {
      set: function (name, value) {
        httpGlobals[String(name)] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        persistSave(httpGlobalsKey, httpGlobals);
      },
      get: function (name) { return httpGlobals[String(name)]; },
      isEmpty: function () { return Object.keys(httpGlobals).length === 0; },
      clear: function (name) { delete httpGlobals[String(name)]; persistSave(httpGlobalsKey, httpGlobals); },
      // Emptied in place, not reassigned: a scope built for an earlier request holds this same object,
      // and swapping it out would leave that request reading variables a script had just cleared.
      clearAll: function () {
        Object.keys(httpGlobals).forEach(function (name) { delete httpGlobals[name]; });
        persistSave(httpGlobalsKey, httpGlobals);
      },
    },
    test: function (name, body) {
      const entry = { name: String(name), ok: true, error: '' };
      try {
        // Called, not type-checked first: client.test() is always given a function, and if it is not, the
        // TypeError is exactly the failure this entry should report.
        body();
      } catch (error) {
        if (error && error.kakapoExit) throw error;
        entry.ok = false;
        entry.error = error && error.message ? String(error.message) : String(error);
      }
      log.tests.push(entry);
      return entry.ok;
    },
    assert: function (condition, message) {
      if (!condition) throw new Error(message ? String(message) : 'Assert failed');
    },
    log: function () {
      log.lines.push(Array.prototype.slice.call(arguments).map(function (value) {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      }).join(' '));
    },
    exit: function () {
      const error = new Error(HTTP_SCRIPT_EXIT);
      error.kakapoExit = true;
      throw error;
    },
  };
}

/** Builds the `request` object a pre-request or handler script reads (and writes variables through). */
function httpRequestApi(request, scope, key) {
  const substituted = function (value) { return applyHttpVars(value, scope, 0); };
  const named = function (name) {
    const wanted = String(name).toLowerCase();
    return (request.headers || []).filter(function (header) { return header.name.toLowerCase() === wanted; })[0];
  };
  const headerApi = function (header) {
    if (!header) return null;
    return {
      name: header.name,
      getRawValue: function () { return header.value; },
      tryGetSubstituted: function () { return substituted(header.value); },
    };
  };
  return {
    method: request.method,
    body: {
      getRaw: function () { return request.body; },
      tryGetSubstituted: function () { return substituted(request.body); },
    },
    url: {
      getRaw: function () { return request.url; },
      tryGetSubstituted: function () { return substituted(request.url); },
    },
    headers: {
      all: function () { return (request.headers || []).map(headerApi); },
      findByName: function (name) { return headerApi(named(name)); },
    },
    environment: {
      get: function (name) {
        const value = scope.env[String(name)];
        return value === undefined ? null : value;
      },
    },
    variables: {
      set: function (name, value) {
        const store = httpRequestVars.get(key) || {};
        store[String(name)] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        httpRequestVars.set(key, store);
        scope.requestVars = store;
      },
      get: function (name) { return (httpRequestVars.get(key) || {})[String(name)]; },
    },
    // Where in a collection this send is. A request whose variable holds a JSON array is sent once per
    // element (runHttpCollection), and a handler that writes per-element results needs to know which.
    iteration: function () { return Number(scope && scope.iteration) || 0; },
    templateValue: function (index) {
      const at = index === undefined ? (Number(scope && scope.iteration) || 0) : Number(index) || 0;
      const collected = httpCollectionElement(request.body, Object.assign({}, scope, { iteration: at }));
      return collected === undefined ? null : collected;
    },
  };
}

/** Builds the `response` object from a send result. */
function httpResponseApi(result) {
  const headers = result.headers || {};
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const parameters = contentType.split(';').slice(1).join(';');
  const charset = /charset\s*=\s*([\w-]+)/i.exec(parameters);
  const text = result.body == null ? '' : String(result.body);
  let body = text;
  if (/json/i.test(contentType) || /^[[{]/.test(text.trim())) {
    try { body = JSON.parse(text); } catch (error) { /* not JSON: the script gets the text, as IntelliJ does */ }
  }
  return {
    status: Number(result.status) || 0,
    body: body,
    contentType: { mimeType: contentType.split(';')[0].trim(), charset: charset ? charset[1] : 'utf-8' },
    headers: {
      valueOf: function (name) {
        const wanted = String(name).toLowerCase();
        const key = Object.keys(headers).filter(function (header) { return header.toLowerCase() === wanted; })[0];
        return key ? headers[key] : null;
      },
      valuesOf: function (name) {
        const single = this.valueOf(name);
        return single == null ? [] : [single];
      },
    },
  };
}

/**
 * Runs one script. Async, so `await sleep(…)` works as it does in IntelliJ, and every failure comes back as
 * a value — a handler that throws must not take the response panel down with it.
 */
/**
 * Resolves a handler's `import` lines into values it can close over.
 *
 * ES module syntax cannot be evaluated inside a Function body, so the imports are LIFTED: each named file
 * is read, run in the same sandbox, and whatever it declares with `export` is captured. The importing
 * script then sees those names as ordinary parameters, which is the same thing the module system would
 * have given it.
 *
 * The depth limit is a module that imports itself; the sandbox is the one every handler runs in, so an
 * imported file has no more reach than the file importing it.
 */
async function loadHttpScriptModules(text, fromPath, depth) {
  const bindings = {};
  const pattern = /^[ \t]*import\s+(?:(\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+)\s+from\s+)?['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
  let match;
  const seen = [];
  while ((match = pattern.exec(text))) seen.push({ clause: match[1] || '', from: match[2] });
  for (const entry of seen) {
    if (depth > 4) return { error: 'a script module imports itself' };
    const resolved = resolveHttpRunPath(fromPath, /\.[a-z]+$/i.test(entry.from) ? entry.from : entry.from + '.js');
    const file = await readHttpFileText(resolved);
    if (!file.ok) return { error: 'cannot read the script module ' + entry.from };
    const exported = await runHttpScriptModule(file.text, resolved, depth + 1);
    if (exported.error) return exported;
    // `import x from …` is the default export; `import * as ns` is the whole namespace; the braced form
    // takes names, with `as` renaming them.
    const clause = entry.clause.trim();
    if (!clause) continue;
    if (clause.charAt(0) === '{') {
      clause.slice(1, -1).split(',').forEach(function (part) {
        const names = part.trim().split(/\s+as\s+/);
        const from = names[0].trim();
        const to = (names[1] || names[0]).trim();
        if (from) bindings[to] = exported.values[from];
      });
    } else if (clause.indexOf('*') === 0) {
      bindings[clause.split(/\s+as\s+/)[1].trim()] = exported.values;
    } else {
      bindings[clause] = exported.values.default;
    }
  }
  return { bindings: bindings, strip: seen.length > 0 };
}

/** Runs one module file and returns what it exported. */
async function runHttpScriptModule(text, path, depth) {
  const nested = await loadHttpScriptModules(text, path, depth);
  if (nested.error) return nested;
  // `export` is removed and the names it marked are collected — the one transformation that turns module
  // syntax into something a Function body accepts, without pretending to be a bundler.
  const names = [];
  // Whether the module HAS a default is known right here, where the rewrite either matched or did not —
  // so the generated body does not need to ask itself at run time. It used to, with a typeof check on
  // the generated name inside the generated string, which test/viewer-slices.test.mjs reads as a guard on
  // a name no slice declares (it cannot see that the code is a string). The flag is both the simpler code
  // and the honest answer to that check.
  let hasDefault = false;
  let body = String(text).replace(/^[ \t]*import\s+[^\n]*$/gm, '');
  body = body.replace(/^[ \t]*export\s+default\s+/gm, function () { hasDefault = true; return 'var __default__ = '; });
  body = body.replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, '');
  const declaration = /(?:^|\n)[ \t]*(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/g;
  let found;
  while ((found = declaration.exec(body))) if (names.indexOf(found[1]) < 0) names.push(found[1]);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const run = new AsyncFunction(
      ...Object.keys(nested.bindings),
      '"use strict";\n' + body + '\nreturn { ' + (hasDefault ? 'default: __default__, ' : '')
        + names.map(function (name) { return JSON.stringify(name) + ': ' + name; }).join(', ') + ' };',
    );
    return { values: await run(...Object.values(nested.bindings)) };
  } catch (error) {
    return { error: 'script module ' + path + ': ' + (error && error.message ? error.message : String(error)) };
  }
}

async function runHttpScript(source, api) {
  const text = String(source || '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, Number(ms) || 0); }); };
  const random = {
    integer: function (from, to) { return Number(httpDynamicValue('$random.integer(' + from + ', ' + to + ')')); },
    float: function (from, to) { return Number(httpDynamicValue('$random.float(' + from + ', ' + to + ')')); },
    alphabetic: function (length) { return httpDynamicValue('$random.alphabetic(' + length + ')'); },
    alphanumeric: function (length) { return httpDynamicValue('$random.alphanumeric(' + length + ')'); },
    hexadecimal: function (length) { return httpDynamicValue('$random.hexadecimal(' + length + ')'); },
  };
  Object.defineProperty(random, 'uuid', { get: function () { return httpDynamicValue('$uuid'); } });
  Object.defineProperty(random, 'email', { get: function () { return httpDynamicValue('$random.email'); } });
  const modules = await loadHttpScriptModules(text, api.path || '', 0);
  if (modules.error) return { ok: false, error: modules.error };
  const moduleNames = Object.keys(modules.bindings);
  // The import lines themselves are removed: their values arrive as parameters instead.
  const source_ = modules.strip ? text.replace(/^[ \t]*import\s+[^\n]*$/gm, '') : text;
  try {
    const body = new AsyncFunction(
      'client', 'request', 'response', 'crypto', 'jsonPath', 'xpath', 'sleep',
      '$uuid', '$timestamp', '$isoTimestamp', '$randomInt', '$random',
      ...moduleNames,
      '"use strict";\n' + source_,
    );
    await body(
      api.client, api.request, api.response || null, httpCryptoApi(),
      function (value, path) { return httpJsonPath(typeof value === 'string' ? JSON.parse(value) : value, path); },
      httpXPath, sleep,
      httpDynamicValue('$uuid'), httpDynamicValue('$timestamp'), httpDynamicValue('$isoTimestamp'),
      Number(httpDynamicValue('$randomInt')), random,
      ...moduleNames.map(function (name) { return modules.bindings[name]; }),
    );
    return { ok: true };
  } catch (error) {
    if (error && error.kakapoExit) return { ok: true, exited: true };
    return { ok: false, error: error && error.message ? String(error.message) : String(error) };
  }
}
