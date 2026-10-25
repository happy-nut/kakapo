// The .http file format, as IntelliJ's HTTP Client defines it. A file written for the IDE has to mean the
// same thing here — a request kakapo shows a Run button for is the request the IDE would send — so this
// guards the syntax surface rather than any one feature: names, directives, split URLs, external bodies,
// multipart, GraphQL, scripts, output redirects, and the variable scopes a {{name}} resolves against.
//
// Driven through a loaded viewer because the parser is a viewer global (the slices are one script, not
// modules). Values read back off v.window are compared as primitives or via JSON — assert.deepEqual on a
// cross-realm object fails on its prototype, not on its contents.
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

const plain = (value) => JSON.parse(JSON.stringify(value));

test("requests are split on ### and named by ### text, # @name, or position", async () => {
  const v = await loadViewer(html);
  const parsed = v.window.parseHttpRequests([
    "### list items",
    "GET https://example.test/items",
    "",
    "###",
    "# @name login",
    "POST https://example.test/login",
    "",
    "###",
    "GET https://example.test/third",
    "",
  ].join("\n"));
  const names = plain(parsed.requests).map((request) => request.name);
  assert.deepEqual(names, ["list items", "login", "#3"], "a request with no name is addressable by position");
  v.close();
});

test("a duplicate request name is disambiguated so a response reference means one request", async () => {
  const v = await loadViewer(html);
  const parsed = v.window.parseHttpRequests([
    "### same", "GET https://example.test/1", "",
    "### same", "GET https://example.test/2", "",
  ].join("\n"));
  const names = plain(parsed.requests).map((request) => request.name);
  assert.deepEqual(names, ["same", "same2"]);
  v.close();
});

test("the short form (a bare URL) is a GET, and an HTTP version is not part of the URL", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "https://example.test/short",
    "",
    "###",
    "POST https://example.test/versioned HTTP/1.1",
    "",
  ].join("\n")));
  assert.equal(parsed.requests[0].method, "GET");
  assert.equal(parsed.requests[0].url, "https://example.test/short");
  assert.equal(parsed.requests[1].url, "https://example.test/versioned");
  assert.equal(parsed.requests[1].httpVersion, "HTTP/1.1");
  v.close();
});

test("an indented continuation line joins the URL instead of being read as a header", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "GET https://example.test",
    "    /api/items",
    "    ?page=2",
    "    &size=10",
    "Accept: application/json",
    "",
  ].join("\n")));
  assert.equal(parsed.requests[0].url, "https://example.test/api/items?page=2&size=10");
  assert.deepEqual(parsed.requests[0].headers, [{ name: "Accept", value: "application/json" }],
    "the header after the continuation lines is still a header");
  v.close();
});

test("request directives are parsed, with timeouts in their declared units", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "### directed",
    "# @no-redirect",
    "// @no-cookie-jar",
    "# @no-log",
    "# @no-auto-encoding",
    "# @timeout 600",
    "// @connection-timeout 2 m",
    "GET https://example.test/x",
    "",
  ].join("\n")));
  const directives = parsed.requests[0].directives;
  assert.equal(directives.noRedirect, true);
  assert.equal(directives.noCookieJar, true);
  assert.equal(directives.noLog, true);
  assert.equal(directives.noAutoEncoding, true);
  assert.equal(directives.timeoutMs, 600_000, "a bare number is seconds");
  assert.equal(directives.connectTimeoutMs, 120_000, "`2 m` is two minutes");
  v.close();
});

test("a `< ./file` body is a file reference, and `<@` marks the one whose variables are substituted", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "POST https://example.test/raw",
    "Content-Type: application/json",
    "",
    "< ./body.json",
    "",
    "###",
    "POST https://example.test/substituted",
    "Content-Type: application/json",
    "",
    "<@ ./body.json",
    "",
  ].join("\n")));
  assert.equal(parsed.requests[0].bodyFile.path, "./body.json");
  assert.equal(parsed.requests[0].bodyFile.substitute, false);
  assert.equal(parsed.requests[1].bodyFile.substitute, true, "<@ substitutes, so the renderer reads the file");
  v.close();
});

test("multipart parts keep their headers, and a filename decides bytes-vs-text", async () => {
  const v = await loadViewer(html);
  const parts = plain(v.window.parseHttpMultipart([
    "--boundary",
    'Content-Disposition: form-data; name="field"',
    "",
    "plain value",
    "--boundary",
    'Content-Disposition: form-data; name="upload"; filename="input.png"',
    "Content-Type: image/png",
    "",
    "< ./input.png",
    "--boundary",
    'Content-Disposition: form-data; name="inlined"',
    "",
    "< ./snippet.txt",
    "--boundary--",
  ].join("\n"), "boundary"));
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "plain value");
  assert.equal(parts[1].file, "./input.png", "a part with a filename is sent as the file's bytes");
  assert.equal(parts[1].headers["Content-Type"], "image/png");
  assert.equal(parts[2].fileAsText, "./snippet.txt", "without a filename the file's contents are the field's text");
  v.close();
});

test("a GraphQL body splits into the operation and its trailing JSON variables", async () => {
  const v = await loadViewer(html);
  const split = plain(v.window.splitGraphqlBody([
    "query Author($id: ID!) {",
    "  author(id: $id) { name }",
    "}",
    "",
    '{ "id": "7" }',
  ].join("\n")));
  assert.match(split.query, /^query Author/);
  assert.equal(split.variables.id, "7");

  const noVariables = plain(v.window.splitGraphqlBody("query { me { name } }"));
  assert.equal(noVariables.variables, null, "a body with no trailing JSON object has no variables");
  v.close();
});

test("inline and external scripts attach to the right side of the request", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "### scripted",
    "< {%",
    '  request.variables.set("now", 1);',
    "%}",
    "GET https://example.test/x",
    "",
    "> {%",
    "  client.log(response.status);",
    "%}",
    "",
    "###",
    "GET https://example.test/y",
    "",
    "> ./handler.js",
    ">>! out/latest.json",
    "",
  ].join("\n")));
  assert.match(parsed.requests[0].preScript.text, /request\.variables\.set/);
  assert.match(parsed.requests[0].handler.text, /client\.log/);
  assert.equal(parsed.requests[1].handler.path, "./handler.js");
  assert.equal(parsed.requests[1].output.path, "out/latest.json");
  assert.equal(parsed.requests[1].output.force, true, ">>! overwrites");
  v.close();
});

test("a ### inside a script block is JavaScript, not a request separator", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "GET https://example.test/x",
    "",
    "> {%",
    '  client.log("### not a separator");',
    "%}",
    "",
  ].join("\n")));
  assert.equal(parsed.requests.length, 1, "the file still holds exactly one request");
  v.close();
});

test("GRPC and WEBSOCKET parse but are marked unsupported rather than given a Run button", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests("GRPC localhost:50051/Service/Method\n"));
  assert.equal(parsed.requests[0].kind, "unsupported");
  v.close();
});

test("variables resolve in IntelliJ's order and a dotted name reads into JSON", async () => {
  const v = await loadViewer(html);
  const scope = {
    path: "x.http",
    vars: { host: "https://file.test", client: '{"host":{"url":"https://nested.test"}}' },
    env: { host: "https://env.test", only: "env" },
    dotenv: { SECRET: "from-dotenv" },
    processEnv: { HOME_LIKE: "from-process" },
    globals: {},
    requestVars: {},
    responses: new v.window.Map(),
  };
  assert.equal(v.window.applyHttpVars("{{host}}/a", scope, 0), "https://file.test/a",
    "a file's own @host wins over the environment");
  assert.equal(v.window.applyHttpVars("{{only}}", scope, 0), "env");
  assert.equal(v.window.applyHttpVars("{{$dotenv.SECRET}}", scope, 0), "from-dotenv");
  assert.equal(v.window.applyHttpVars("{{$env.HOME_LIKE}}", scope, 0), "from-process");
  assert.equal(v.window.applyHttpVars("{{client.host.url}}", scope, 0), "https://nested.test");
  assert.equal(v.window.applyHttpVars("{{nope}}", scope, 0), "{{nope}}", "an unknown name is left verbatim");
  assert.equal(v.window.httpUnresolvedVar("{{host}} {{nope}}", scope), "nope");
  v.close();
});

test("a request variable set by a pre-request script outranks every other scope", async () => {
  const v = await loadViewer(html);
  const scope = {
    path: "x.http", vars: { token: "file" }, env: { token: "env" }, dotenv: {}, processEnv: {},
    globals: { token: "global" }, requestVars: { token: "per-request" }, responses: new v.window.Map(),
  };
  assert.equal(v.window.applyHttpVars("{{token}}", scope, 0), "per-request");
  delete scope.requestVars.token;
  assert.equal(v.window.applyHttpVars("{{token}}", scope, 0), "global",
    "client.global comes next, so a handler's value is visible to later requests");
  v.close();
});

test("a variable that references itself stops instead of recursing", async () => {
  const v = await loadViewer(html);
  const scope = {
    path: "x.http", vars: { loop: "{{loop}}" }, env: {}, dotenv: {}, processEnv: {},
    globals: {}, requestVars: {}, responses: new v.window.Map(),
  };
  assert.equal(typeof v.window.applyHttpVars("{{loop}}", scope, 0), "string");
  v.close();
});

test("dynamic variables produce values of the documented shape", async () => {
  const v = await loadViewer(html);
  const value = (name) => v.window.httpDynamicValue(name);
  assert.match(value("$uuid"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(value("$timestamp"), /^\d{10,}$/);
  assert.match(value("$isoTimestamp"), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  const randomInt = Number(value("$randomInt"));
  assert.ok(randomInt >= 0 && randomInt <= 1000, `$randomInt in range (got ${randomInt})`);
  const bounded = Number(value("$random.integer(5, 7)"));
  assert.ok(bounded >= 5 && bounded < 7, "$random.integer's upper bound is exclusive");
  assert.equal(value("$random.alphabetic(12)").length, 12);
  assert.match(value("$random.hexadecimal(8)"), /^[0-9a-f]{8}$/);
  assert.match(value("$random.email"), /@example\.com$/);
  assert.equal(value("$projectRoot"), "", "paths stay repository-relative: only main knows the root");
  assert.equal(value("$historyFolder"), "$historyFolder", "a sentinel main maps to its own user-data mirror");
  assert.equal(value("$random.nothingLikeThis"), undefined, "an unimplemented generator is reported, not faked");
  v.close();
});

test("a response reference reads a named response's body, headers and status", async () => {
  const v = await loadViewer(html);
  const responses = new v.window.Map();
  responses.set("login", {
    status: 201,
    headers: { location: "/users/7" },
    body: '{"token":"abc","user":{"id":7}}',
    json: { token: "abc", user: { id: 7 } },
  });
  const scope = {
    path: "x.http", vars: {}, env: {}, dotenv: {}, processEnv: {}, globals: {}, requestVars: {},
    responses,
  };
  assert.equal(v.window.applyHttpVars("{{login.response.body.$.token}}", scope, 0), "abc");
  assert.equal(v.window.applyHttpVars("{{login.response.body.$.user.id}}", scope, 0), "7");
  assert.equal(v.window.applyHttpVars("{{login.response.headers.Location}}", scope, 0), "/users/7",
    "a header name is matched case-insensitively, as HTTP defines it");
  assert.equal(v.window.applyHttpVars("{{login.response.status}}", scope, 0), "201");
  v.close();
});

test("jsonPath reads the shapes .http files ask for", async () => {
  const v = await loadViewer(html);
  const document_ = { items: [{ id: 1 }, { id: 2 }], "dotted.key": "x", nested: { deep: { id: 9 } } };
  assert.equal(v.window.httpJsonPath(document_, "$.items[1].id"), 2);
  assert.equal(v.window.httpJsonPath(document_, "$['dotted.key']"), "x");
  assert.equal(v.window.httpJsonPath(document_, "$..id"), 1, "`..` finds the shallowest match");
  assert.equal(v.window.httpJsonPath(document_, "$.missing"), undefined);
  v.close();
});

test("`run` and `import` are parsed, with their per-call variable overrides", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "import ./shared.http",
    "",
    "run ./smoke.http",
    "",
    "run #login",
    "",
    "run ./other.http#profile (@host = https://staging.test, @user=ada)",
    "",
    "### an ordinary request still works here",
    "GET https://example.test/x",
    "",
  ].join("\n")));
  assert.deepEqual(parsed.imports, ["./shared.http"], "import makes a file's requests addressable");
  const runs = parsed.requests.filter((request) => request.kind === "run");
  assert.deepEqual(runs.map((request) => [request.runSpec.path, request.runSpec.requestName]), [
    ["./smoke.http", ""],
    ["", "login"],
    ["./other.http", "profile"],
  ]);
  assert.deepEqual(runs[2].runSpec.overrides, { host: "https://staging.test", user: "ada" });
  assert.equal(parsed.requests.filter((request) => request.kind === "http").length, 1,
    "a run line does not swallow the requests around it");
  v.close();
});

test("a line that only looks like `run` is not one", async () => {
  const v = await loadViewer(html);
  const parsed = plain(v.window.parseHttpRequests([
    "### running totals",
    "GET https://example.test/run",
    "X-Run: import something",
    "",
  ].join("\n")));
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].kind, "http");
  assert.deepEqual(parsed.imports, []);
  v.close();
});
