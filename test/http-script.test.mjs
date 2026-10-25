// Pre-request and response-handler scripts, against IntelliJ's HTTP Response Handler API.
//
// Two things are being guarded. The API surface: client.global / client.test / client.assert / client.log /
// client.exit, response.*, request.variables, jsonPath, xpath. And the digests, which are implemented here
// rather than delegated (IntelliJ's crypto API is synchronous; window.crypto.subtle is not) — so they are
// checked against published vectors, not against themselves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "api.http", before: "GET https://example.test/a\n", after: "GET https://example.test/b\n" },
  ]));
});
after(cleanupFixtures);

/** A viewer plus the pieces a script runs against, so each test says only what it is about. */
async function scriptHost() {
  const v = await loadViewer(html);
  const log = { lines: [], tests: [] };
  const request = {
    method: "POST",
    url: "{{host}}/login",
    body: '{"user":"{{user}}"}',
    headers: [{ name: "X-Trace", value: "{{trace}}" }],
  };
  const scope = {
    path: "api.http", vars: { host: "https://example.test", user: "ada", trace: "t-1" },
    env: { stage: "dev" }, dotenv: {}, processEnv: {}, globals: {}, requestVars: {},
    responses: new v.window.Map(),
  };
  const api = v.window.httpClientApi({ lines: [], tests: [] });
  return {
    v, log, request, scope,
    // Top-level let/const in a classic script are not window properties, so the state is read back
    // through the very API a handler writes it with.
    global: (name) => api.global.get(name),
    requestVar: (name) => v.window.httpRequestApi(request, scope, "api.http#0").variables.get(name),
    run: (source, response) => v.window.runHttpScript(source, {
      client: v.window.httpClientApi(log),
      request: v.window.httpRequestApi(request, scope, "api.http#0"),
      response: response ? v.window.httpResponseApi(response) : null,
    }),
  };
}

test("digests match published vectors", async () => {
  const v = await loadViewer(html);
  const crypto = v.window.httpCryptoApi();
  assert.equal(crypto.md5().updateWithText("abc").digest().toHex(),
    "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(crypto.sha1().updateWithText("abc").digest().toHex(),
    "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(crypto.sha256().updateWithText("abc").digest().toHex(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(crypto.sha256().updateWithText("abc").digest().toBase64(),
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  // An empty input is its own case: the padding block is the only block.
  assert.equal(crypto.sha256().digest().toHex(),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // 200 bytes spans more than one block, which is the only way the chunk loop gets exercised at all.
  assert.equal(crypto.sha256().updateWithText("a".repeat(200)).digest().toHex(),
    "c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
  v.close();
});

test("hmac matches published vectors for each hash", async () => {
  const v = await loadViewer(html);
  const crypto = v.window.httpCryptoApi();
  const message = "The quick brown fox jumps over the lazy dog";
  assert.equal(crypto.hmac.sha256().withTextSecret("key").updateWithText(message).digest().toHex(),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  assert.equal(crypto.hmac.sha1().withTextSecret("key").updateWithText(message).digest().toHex(),
    "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
  assert.equal(crypto.hmac.md5().withTextSecret("key").updateWithText(message).digest().toHex(),
    "80070713463e7749b90c2dc24911e275");
  // A secret longer than the block size is hashed first — a different code path from the padded one.
  assert.equal(crypto.hmac.sha256().withTextSecret("k".repeat(100)).updateWithText("x").digest().toHex(),
    "8c1858bff6cf9cb73708b4b54f43bca6e1b8b4c3380760dc009001b265b64c6f");
  v.close();
});

test("hex and base64 inputs update the same digest as text does", async () => {
  const v = await loadViewer(html);
  const crypto = v.window.httpCryptoApi();
  const fromText = crypto.sha256().updateWithText("abc").digest().toHex();
  assert.equal(crypto.sha256().updateWithHex("616263").digest().toHex(), fromText);
  assert.equal(crypto.sha256().updateWithBase64("YWJj").digest().toHex(), fromText);
  v.close();
});

test("client.test records a pass and a failure with its message", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.test("passes", function () { client.assert(1 === 1, "never"); });',
    'client.test("fails", function () { client.assert(false, "the token was missing"); });',
  ].join("\n"));
  assert.equal(outcome.ok, true, "a failing assertion fails its test, not the script");
  assert.equal(host.log.tests.length, 2);
  assert.equal(host.log.tests[0].ok, true);
  assert.equal(host.log.tests[1].ok, false);
  assert.equal(host.log.tests[1].error, "the token was missing");
  host.v.close();
});

test("client.global values survive into the variable scope a later request resolves against", async () => {
  const host = await scriptHost();
  await host.run('client.global.set("token", "abc123");');
  assert.equal(host.global("token"), "abc123");
  const scope = host.v.window.httpScope("api.http", 1);
  assert.equal(host.v.window.applyHttpVars("Bearer {{token}}", scope, 0), "Bearer abc123");

  await host.run('client.global.clear("token");');
  assert.equal(host.global("token"), undefined);
  await host.run('client.global.set("a", "1"); client.global.clearAll();');
  assert.equal(host.global("a"), undefined);
  host.v.close();
});

test("the response object exposes status, parsed body, content type and headers", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.test("status", function () { client.assert(response.status === 201, "status"); });',
    'client.global.set("id", response.body.id);',
    'client.global.set("mime", response.contentType.mimeType);',
    'client.global.set("charset", response.contentType.charset);',
    'client.global.set("header", response.headers.valueOf("X-Request-Id"));',
    'client.global.set("values", String(response.headers.valuesOf("x-request-id").length));',
  ].join("\n"), {
    ok: true, status: 201, headers: { "content-type": "application/json; charset=utf-8", "x-request-id": "r-9" },
    body: '{"id":"7"}',
  });
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.equal(host.log.tests[0].ok, true);
  assert.equal(host.global("id"), "7", "a JSON body arrives parsed");
  assert.equal(host.global("mime"), "application/json");
  assert.equal(host.global("charset"), "utf-8");
  assert.equal(host.global("header"), "r-9", "a header is found case-insensitively");
  assert.equal(host.global("values"), "1");
  host.v.close();
});

test("a text response body stays text", async () => {
  const host = await scriptHost();
  await host.run('client.global.set("body", response.body);', {
    ok: true, status: 200, headers: { "content-type": "text/plain" }, body: "plain answer",
  });
  assert.equal(host.global("body"), "plain answer");
  host.v.close();
});

test("request exposes the raw and substituted request, and sets per-request variables", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.global.set("rawUrl", request.url.getRaw());',
    'client.global.set("url", request.url.tryGetSubstituted());',
    'client.global.set("body", request.body.tryGetSubstituted());',
    'client.global.set("method", request.method);',
    'client.global.set("trace", request.headers.findByName("x-trace").tryGetSubstituted());',
    'client.global.set("headerCount", String(request.headers.all().length));',
    'client.global.set("env", request.environment.get("stage"));',
    'request.variables.set("nonce", "n-1");',
  ].join("\n"));
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.equal(host.global("rawUrl"), "{{host}}/login");
  assert.equal(host.global("url"), "https://example.test/login");
  assert.equal(host.global("body"), '{"user":"ada"}');
  assert.equal(host.global("method"), "POST");
  assert.equal(host.global("trace"), "t-1");
  assert.equal(host.global("headerCount"), "1");
  assert.equal(host.global("env"), "dev");
  assert.equal(host.requestVar("nonce"), "n-1",
    "request.variables.set is scoped to the one request that follows the script");
  host.v.close();
});

test("jsonPath and xpath are available inside a script", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.global.set("id", String(jsonPath(response.body, "$.items[0].id")));',
    'client.global.set("name", String(xpath("<r><n>kakapo</n></r>", "//n/text()")));',
  ].join("\n"), { ok: true, status: 200, headers: { "content-type": "application/json" }, body: '{"items":[{"id":42}]}' });
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.equal(host.global("id"), "42");
  assert.equal(host.global("name"), "kakapo");
  host.v.close();
});

test("dynamic variables are plain identifiers inside a script", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.global.set("uuid", $uuid);',
    'client.global.set("stamp", String($timestamp));',
    'client.global.set("int", String($randomInt));',
    'client.global.set("hex", $random.hexadecimal(6));',
    'client.global.set("ruuid", $random.uuid);',
  ].join("\n"));
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.match(host.global("uuid"), /^[0-9a-f-]{36}$/);
  assert.match(host.global("stamp"), /^\d{10,}$/);
  assert.match(host.global("hex"), /^[0-9a-f]{6}$/);
  assert.match(host.global("ruuid"), /^[0-9a-f-]{36}$/);
  host.v.close();
});

test("client.exit stops the script without failing it", async () => {
  const host = await scriptHost();
  const outcome = await host.run([
    'client.log("before");',
    "client.exit();",
    'client.log("after");',
  ].join("\n"));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.exited, true);
  assert.deepEqual(host.log.lines, ["before"]);
  host.v.close();
});

test("a throwing script is reported, not swallowed and not fatal", async () => {
  const host = await scriptHost();
  const outcome = await host.run('throw new Error("handler blew up");');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "handler blew up");
  host.v.close();
});

test("await sleep() works, so a handler can pace itself", async () => {
  const host = await scriptHost();
  const outcome = await host.run('await sleep(1); client.log("after sleep");');
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.deepEqual(host.log.lines, ["after sleep"]);
  host.v.close();
});

test("a script has no filesystem, process or module loader to reach for", async () => {
  const host = await scriptHost();
  // The renderer is sandboxed (contextIsolation, no node integration), so these are absent rather than
  // blocked — this asserts the property the design depends on, in the realm a handler actually runs in.
  for (const name of ["require", "process", "module", "global"]) {
    const outcome = await host.run(`client.global.set("probe", typeof ${name});`);
    assert.equal(outcome.ok, true, outcome.error || "");
    assert.equal(host.global("probe"), "undefined", `${name} is not reachable from a handler`);
  }
  // A module that cannot be read says which one, rather than failing as if the script were wrong.
  const imported = await host.run('import { x } from "./nowhere.js";\nclient.log(x);');
  assert.equal(imported.ok, false);
  assert.match(imported.error, /nowhere/);
  host.v.close();
});

test("a handler can import a shared script module, in every ES6 form", async () => {
  const host = await scriptHost();
  const modules = {
    "lib/logger.js": [
      "export const prefix = 'kakapo';",
      "export function shout(text) { return prefix + ': ' + String(text).toUpperCase(); }",
      "export default function () { return 'the default'; }",
    ].join("\n"),
    "lib/chain.js": "import { prefix } from './logger.js';\nexport const doubled = prefix + prefix;",
  };
  host.v.window.kakapoHttp = {
    readFile: (path) => Promise.resolve(
      modules[path.replace(/^\.\//, "")] !== undefined
        ? { ok: true, text: modules[path.replace(/^\.\//, "")] }
        : { ok: false, error: `no such module: ${path}` },
    ),
  };
  const outcome = await host.run([
    "import { shout } from './lib/logger.js';",
    "import * as logger from './lib/logger.js';",
    "import makeDefault from './lib/logger.js';",
    "import { doubled } from './lib/chain.js';",
    "client.global.set('shouted', shout('hi'));",
    "client.global.set('namespaced', logger.prefix);",
    "client.global.set('fromDefault', makeDefault());",
    "client.global.set('nested', doubled);",
  ].join("\n"));
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.equal(host.global("shouted"), "kakapo: HI", "a named import is callable");
  assert.equal(host.global("namespaced"), "kakapo", "a namespace import carries every export");
  assert.equal(host.global("fromDefault"), "the default");
  assert.equal(host.global("nested"), "kakapokakapo", "and a module may import another");
  host.v.close();
});

test("an imported module runs in the same sandbox as the handler", async () => {
  const host = await scriptHost();
  host.v.window.kakapoHttp = {
    readFile: () => Promise.resolve({ ok: true, text: "export const reach = typeof require + '/' + typeof process;" }),
  };
  const outcome = await host.run("import { reach } from './probe.js';\nclient.global.set('reach', reach);");
  assert.equal(outcome.ok, true, outcome.error || "");
  assert.equal(host.global("reach"), "undefined/undefined", "a module is no more privileged than its importer");
  host.v.close();
});
