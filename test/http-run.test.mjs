// Running a .http file end to end in the viewer: what leaves kakapo for each shape of request, and what
// the reviewer is shown when it comes back.
//
// Driven through the real review HTML and the real source view (the run buttons are rendered by the same
// table a reviewer reads), with only the main-process bridge stubbed — that boundary is where the network
// and the filesystem are, and it is the one thing jsdom cannot provide.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "requests/api.http";

const HTTP_FILE = [
  "@base = https://example.test",
  "@suffix = 9",
  "@token = t-{{suffix}}",
  "",
  "### login",
  "POST {{base}}/login",
  "Content-Type: application/json",
  "",
  '{"user": "ada"}',
  "",
  "> {%",
  '  client.global.set("auth", response.body.token);',
  '  client.test("a token came back", function () { client.assert(response.body.token, "no token"); });',
  "%}",
  "",
  "### profile",
  "GET {{base}}/me",
  "Authorization: Bearer {{auth}}",
  "",
  "### referenced",
  "GET {{base}}/users/{{login.response.body.$.id}}",
  "",
  "### upload",
  "POST {{base}}/upload",
  "Content-Type: multipart/form-data; boundary=sep",
  "",
  "--sep",
  'Content-Disposition: form-data; name="meta"',
  "",
  '{"k":"{{token}}"}',
  "--sep",
  'Content-Disposition: form-data; name="file"; filename="input.bin"',
  "Content-Type: application/octet-stream",
  "",
  "< ./input.bin",
  "--sep--",
  "",
  "### external",
  "POST {{base}}/external",
  "Content-Type: application/json",
  "",
  "<@ ./payload.json",
  "",
  "### raw-external",
  "POST {{base}}/raw",
  "Content-Type: application/octet-stream",
  "",
  "< ./input.bin",
  "",
  "### graph",
  "GRAPHQL {{base}}/graphql",
  "",
  "query Hero { hero { name } }",
  "",
  '{"episode": "JEDI"}',
  "",
  "### careful",
  "# @no-redirect",
  "# @no-cookie-jar",
  "# @no-log",
  "# @timeout 5",
  "GET {{base}}/careful",
  "",
  "### saved",
  "GET {{base}}/report",
  "",
  ">>! out/report.json",
  "",
  "### from-env",
  "GET {{host}}/env",
  "X-Shared: {{shared-key}}",
  "",
  "### broken",
  "GET {{base}}/{{nothing-defines-this}}",
  "",
  "### authed",
  "GET {{base}}/private",
  "Authorization: Basic ada secret",
  "",
  "### encoded",
  "GET {{base}}/search?q={{phrase}}",
  "",
].join("\n");

const REQUESTS = {
  login: 0, profile: 1, referenced: 2, upload: 3, external: 4, rawExternal: 5,
  graph: 6, careful: 7, saved: 8, fromEnv: 9, broken: 10, authed: 11, encoded: 12,
};

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "GET https://example.test/old\n", after: HTTP_FILE },
    { path: "requests/payload.json", after: '{"user": "{{token}}"}\n' },
    { path: "requests/input.bin", after: "binary-ish\n" },
    {
      path: "http-client.env.json",
      after: JSON.stringify({
        $shared: { "shared-key": "from-shared", phrase: "two words" },
        dev: { host: "https://dev.example.test" },
      }, null, 2) + "\n",
    },
  ]));
});
after(cleanupFixtures);

/** Opens the .http file in the source view with the main-process bridge stubbed. */
async function openHttpFile(responder) {
  const v = await loadViewer(html);
  const sent = [];
  const reads = [];
  const saves = [];
  const clipboard = [];
  v.window.kakapoHttp = {
    send: (request) => {
      sent.push(request);
      const answer = responder ? responder(request) : null;
      return Promise.resolve(answer || {
        ok: true, status: 200, statusText: "OK", durationMs: 3, bytes: 2,
        headers: { "content-type": "application/json" }, body: "{}",
      });
    },
    readFile: (path) => {
      reads.push(path);
      if (path === "./payload.json" || path === "payload.json") {
        return Promise.resolve({ ok: true, text: '{"user": "{{token}}"}' });
      }
      return Promise.resolve({ ok: false, error: `no such file: ${path}` });
    },
    saveResponse: (request) => {
      saves.push(request);
      return Promise.resolve({ ok: true, path: request.path });
    },
  };
  v.window.kakapoClipboard = { write: (text) => clipboard.push(text) };
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return { v, sent, reads, saves, clipboard };
}

/** Clicks the gutter Run button for a request index and waits for the response to be rendered. */
async function run(host, index) {
  const button = host.v.$(`#source-body .http-run[data-req="${index}"]`);
  assert.ok(button, `request ${index} has a Run button`);
  button.click();
  await host.v.settle(60);
  return host.v.$(`#http-resp-${index}`);
}

test("every request in the file gets exactly one Run button, in file order", async () => {
  const host = await openHttpFile();
  const buttons = host.v.$all("#source-body .http-run");
  assert.equal(buttons.length, Object.keys(REQUESTS).length);
  assert.equal(buttons[0].dataset.req, "0");
  assert.match(buttons[0].getAttribute("aria-label"), /login/,
    "a button names its request, so twenty requests are twenty distinguishable buttons");
  host.v.close();
});

test("an inline body is sent with the file's own variables substituted", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.login);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0].method, "POST");
  assert.equal(host.sent[0].url, "https://example.test/login");
  assert.equal(host.sent[0].headers["Content-Type"], "application/json");
  assert.equal(host.sent[0].body, '{"user": "ada"}');
  host.v.close();
});

test("a response handler's global reaches the next request, and its tests are shown", async () => {
  const host = await openHttpFile((request) => (request.url.endsWith("/login")
    ? {
      ok: true, status: 200, statusText: "OK", durationMs: 4, bytes: 30,
      headers: { "content-type": "application/json" }, body: '{"token":"abc123","id":"7"}',
    }
    : null));
  const panel = await run(host, REQUESTS.login);
  assert.match(panel.textContent, /1 tests passed/, "a handler that asserted says so");

  await run(host, REQUESTS.profile);
  assert.equal(host.sent[1].headers.Authorization, "Bearer abc123",
    "client.global.set in the handler is what {{auth}} resolves to");

  await run(host, REQUESTS.referenced);
  assert.equal(host.sent[2].url, "https://example.test/users/7",
    "{{login.response.body.$.id}} reads the earlier response");
  host.v.close();
});

test("a failing assertion is reported as a failed test, not as a failed request", async () => {
  const host = await openHttpFile((request) => (request.url.endsWith("/login")
    ? {
      ok: true, status: 200, statusText: "OK", durationMs: 4, bytes: 2,
      headers: { "content-type": "application/json" }, body: "{}",
    }
    : null));
  const panel = await run(host, REQUESTS.login);
  assert.match(panel.textContent, /1 of 1 tests failed/);
  assert.match(panel.textContent, /no token/, "the assertion's own message is what explains it");
  assert.match(panel.textContent, /200/, "the response itself is still shown");
  host.v.close();
});

test("multipart parts go out separately: a named file by reference, the rest as text", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.upload);
  const request = host.sent[0];
  assert.equal(request.boundary, "sep");
  assert.equal(request.bodyParts.length, 2);
  assert.equal(request.bodyParts[0].text, '{"k":"t-9"}', "a part's text is substituted too");
  assert.equal(request.bodyParts[1].file, "./input.bin",
    "a part with a filename is named for main to read — its bytes never pass through a JS string");
  assert.equal(request.bodyParts[1].text, undefined);
  host.v.close();
});

test("`<@ file` is read and substituted here; `< file` is named for main to read", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.external);
  assert.deepEqual(host.reads, ["./payload.json"]);
  assert.equal(host.sent[0].body, '{"user": "t-9"}');
  assert.equal(host.sent[0].bodyFile, undefined);

  await run(host, REQUESTS.rawExternal);
  assert.equal(host.sent[1].bodyFile, "./input.bin");
  assert.equal(host.sent[1].body, undefined);
  assert.deepEqual(host.reads, ["./payload.json"], "a raw body is not read by the renderer at all");
  host.v.close();
});

test("a GRAPHQL request is posted as {query, variables}", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.graph);
  assert.equal(host.sent[0].method, "POST");
  assert.equal(host.sent[0].headers["Content-Type"], "application/json");
  const body = JSON.parse(host.sent[0].body);
  assert.match(body.query, /^query Hero/);
  assert.equal(body.variables.episode, "JEDI");
  host.v.close();
});

test("directives are carried on the request, and @no-log keeps it out of the response store", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.careful);
  assert.equal(host.sent[0].noRedirect, true);
  assert.equal(host.sent[0].noCookieJar, true);
  assert.equal(host.sent[0].timeoutMs, 5000);
  const scope = host.v.window.httpScope(FILE, 0);
  assert.equal(host.v.window.applyHttpVars("{{careful.response.status}}", scope, 0),
    "{{careful.response.status}}", "@no-log means the response is not referable");
  host.v.close();
});

test("`>>!` hands the body to main with the overwrite flag, and the panel says where it went", async () => {
  const host = await openHttpFile();
  const panel = await run(host, REQUESTS.saved);
  assert.equal(host.saves.length, 1);
  assert.equal(host.saves[0].path, "out/report.json");
  assert.equal(host.saves[0].force, true);
  assert.match(panel.textContent, /out\/report\.json/);
  host.v.close();
});

test("$shared and the selected environment both resolve", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.fromEnv);
  assert.equal(host.sent[0].url, "https://dev.example.test/env", "the environment supplies {{host}}");
  assert.equal(host.sent[0].headers["X-Shared"], "from-shared",
    "$shared is the base every environment sits on top of");
  host.v.close();
});

test("the environment dropdown offers environments only — never the $shared/$dotenv scopes", async () => {
  const host = await openHttpFile();
  const options = Array.from(host.v.$("#http-env-select").options).map((option) => option.value);
  assert.deepEqual(options, ["", "dev"]);
  host.v.close();
});

test("an undefined variable stops the request and names the variable", async () => {
  const host = await openHttpFile();
  const panel = await run(host, REQUESTS.broken);
  assert.equal(host.sent.length, 0, "nothing is sent with an unresolved placeholder in the URL");
  assert.match(panel.textContent, /nothing-defines-this/);
  host.v.close();
});

test("`Authorization: Basic user pass` is split out instead of sent as a header value", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.authed);
  assert.equal(host.sent[0].headers.Authorization, undefined,
    "`Basic ada secret` is not a valid header value — main encodes it");
  // JSON, not deepEqual: the object was built in the viewer's realm, where deepEqual compares prototypes
  // and fails on an object whose contents are right.
  assert.deepEqual(JSON.parse(JSON.stringify(host.sent[0].auth)),
    { type: "basic", user: "ada", password: "secret" });
  host.v.close();
});

test("a substituted value with a space is percent-encoded, as IntelliJ does by default", async () => {
  const host = await openHttpFile();
  await run(host, REQUESTS.encoded);
  assert.equal(host.sent[0].url, "https://example.test/search?q=two%20words");
  host.v.close();
});

test("⌘⇧Enter runs the whole file in order, one request at a time", async () => {
  // The login answer is supplied because the file is a SEQUENCE: without an id in it, the request that
  // reads {{login.response.body.$.id}} has nothing to resolve and correctly never leaves.
  const host = await openHttpFile((request) => (request.url.endsWith("/login")
    ? {
      ok: true, status: 200, statusText: "OK", durationMs: 4, bytes: 30,
      headers: { "content-type": "application/json" }, body: '{"token":"abc123","id":"7"}',
    }
    : null));
  await host.v.window.runHttpFile();
  await host.v.settle(80);
  // Every request except the one with the unresolved variable, which never reaches the sender.
  assert.equal(host.sent.length, Object.keys(REQUESTS).length - 1);
  assert.ok(host.sent[0].url.endsWith("/login"), "file order, so a login still comes before what needs it");
  host.v.close();
});

test("a request can be copied as a cURL command without being sent", async () => {
  const host = await openHttpFile();
  await host.v.window.copyHttpAsCurl(REQUESTS.login, FILE);
  await host.v.settle(20);
  assert.equal(host.sent.length, 0, "copying is not running");
  assert.equal(host.clipboard.length, 1);
  const command = host.clipboard[0];
  assert.match(command, /^curl -X POST 'https:\/\/example\.test\/login'/);
  assert.match(command, /-H 'Content-Type: application\/json'/);
  assert.match(command, /--data-raw '\{"user": "ada"\}'/);
  host.v.close();
});

test("cURL for an authenticated multipart request uses -u and -F", async () => {
  const host = await openHttpFile();
  await host.v.window.copyHttpAsCurl(REQUESTS.upload, FILE);
  await host.v.window.copyHttpAsCurl(REQUESTS.authed, FILE);
  await host.v.settle(20);
  assert.match(host.clipboard[0], /-F 'meta=\{"k":"t-9"\}'/);
  assert.match(host.clipboard[0], /-F 'file=@\.\/input\.bin'/);
  assert.match(host.clipboard[1], /--basic -u 'ada:secret'/);
  host.v.close();
});

test("GRPC and WEBSOCKET requests get no Run button", async () => {
  const { html: other } = await makeReviewHtml([
    { path: "stream.http", after: "GRPC localhost:50051/S/M\n\n###\nWEBSOCKET ws://localhost:8080/ws\n" },
  ]);
  const v = await loadViewer(other);
  v.window.openSourceFile("stream.http");
  await v.settle(40);
  // The lines are still parsed and coloured — they are simply not runnable, which is the honest answer.
  assert.equal(v.$all("#source-body .http-run").length, 2, "the buttons are rendered…");
  v.$('#source-body .http-run[data-req="0"]').click();
  await v.settle(40);
  assert.match(v.$("#http-resp-0").textContent, /not supported/, "…and say why they cannot send");
  v.close();
});
