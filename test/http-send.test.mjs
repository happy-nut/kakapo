// The .http runner executes a request whose URL, headers and body come from a file in the reviewed
// repository, in the main process, with no CORS and no sandbox. Loopback stays reachable on purpose — running
// a request against your own dev server is the point of the feature — but the destination has to be the one
// written in the file the reviewer ran: a scheme they can read, and not a redirect chain that quietly leads
// somewhere else.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performHttpRequest } from "../dist/server.js";
import { collectHttpEnvironments } from "../dist/diff.js";
import { readHttpAttachment, saveHttpResponse } from "../dist/http-files.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

let server;
let origin;
const hits = [];

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain answer");
      return;
    }
    if (req.url === "/to-file") {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
      return;
    }
    if (req.url === "/to-ok") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/loop")) {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    // Echoes back what arrived, so a test can assert on the request rather than on the response.
    if (req.url === "/echo") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          method: req.method,
          authorization: req.headers.authorization ?? null,
          cookie: req.headers.cookie ?? null,
          contentType: req.headers["content-type"] ?? null,
          body: Buffer.concat(chunks).toString("base64"),
        }));
      });
      return;
    }
    if (req.url === "/digest") {
      if (!req.headers.authorization) {
        res.writeHead(401, {
          "www-authenticate": 'Digest realm="kakapo", qop="auth", nonce="abc123", opaque="op"',
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.headers.authorization);
      return;
    }
    if (req.url === "/set-cookie") {
      res.writeHead(200, { "set-cookie": ["session=s-1; Path=/", "theme=dark; Path=/"], "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => { res.writeHead(200); res.end("late"); }, 400).unref?.();
      return;
    }
    if (req.url === "/png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("a plain request against a dev server still works", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/ok`, headers: {} });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, 200);
  assert.equal(result.body, "plain answer");
  assert.equal(result.headers["content-type"], "text/plain");
});

test("an ordinary redirect is still followed", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/to-ok`, headers: {} });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.body, "plain answer", "the hop landed and its body came back");
});

test("a redirect out of http(s) is refused instead of followed", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/to-file`, headers: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /non-http\(s\)/, "the refusal names what it refused");
  assert.doesNotMatch(String(result.body ?? ""), /root:/, "and nothing from the filesystem came back");
});

test("a redirect loop ends with an error rather than spinning in main", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/loop`, headers: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /too many redirects/);
});

test("a URL that is not http(s) never reaches the network", async () => {
  for (const url of ["file:///etc/passwd", "data:text/plain,hi", "chrome://settings", "not a url", ""]) {
    const result = await performHttpRequest({ method: "GET", url, headers: {} });
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.match(result.error, /unsupported URL scheme/);
  }
});

// Where the .http runner looks for its environments.
//
// They were read only from the repository root, and that is not where they live: a project keeps its
// requests in a folder with the env file next to them. So every {{variable}} stayed a literal, the request
// went out as "{{host}}/get", and the sender answered "unsupported URL scheme: {{host}}/get" — naming the
// symptom and hiding the cause.
test("environment files are found beside the .http files, not only at the repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-httpenv-"));
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "http-client.env.json"), JSON.stringify({ dev: { host: "https://root.test", shared: "yes" } }));
    writeFileSync(join(root, "api", "http-client.env.json"), JSON.stringify({ dev: { host: "https://beside.test", only: "here" } }));

    const beside = collectHttpEnvironments(root, ["api/calls.http"]);
    assert.equal(beside.dev.only, "here", "the file beside the requests is read at all");
    assert.equal(beside.dev.host, "https://beside.test", "and the nearer value wins the key it shares");
    assert.equal(beside.dev.shared, "yes", "while the root still supplies what it alone defines");

    const rootOnly = collectHttpEnvironments(root, []);
    assert.equal(rootOnly.dev.host, "https://root.test", "with no .http files, the root is still read");
    assert.equal(rootOnly.dev.only, undefined, "and nothing is pulled in from folders nothing points at");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The paths come from the review's own file list, so they are repository-relative — but a reader of this
// function cannot see that, and it opens files by path.
test("an environment lookup cannot be walked out of the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-httpenv-"));
  const outside = mkdtempSync(join(tmpdir(), "kakapo-outside-"));
  try {
    writeFileSync(join(root, "http-client.env.json"), JSON.stringify({ dev: { host: "https://root.test" } }));
    writeFileSync(join(outside, "http-client.env.json"), JSON.stringify({ dev: { host: "https://outside.test" } }));
    const escaped = collectHttpEnvironments(root, ["../" + basename(outside) + "/calls.http", "/etc/calls.http"]);
    assert.equal(escaped.dev.host, "https://root.test", "only the root's own value survived");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- what the request carries ----------------------------------------------------------------------
// `Authorization: Basic user pass` is IntelliJ's spelling and NOT a valid header value, so the renderer
// splits it out and main is the side that encodes it. Same for Digest, which cannot be encoded at all
// until the server has handed out a nonce.

const echo = async (request, context = {}) => {
  const result = await performHttpRequest({ headers: {}, ...request, url: `${origin}/echo` }, context);
  assert.equal(result.ok, true, result.error);
  return JSON.parse(result.body);
};

test("Basic credentials are encoded by main, never sent as the literal header", async () => {
  const seen = await echo({ method: "GET", auth: { type: "basic", user: "ada", password: "s3cret" } });
  assert.equal(seen.authorization, `Basic ${Buffer.from("ada:s3cret").toString("base64")}`);
});

test("Digest answers the server's challenge and retries once", async () => {
  const result = await performHttpRequest({
    method: "GET", url: `${origin}/digest`, headers: {},
    auth: { type: "digest", user: "ada", password: "s3cret" },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, 200, "the 401 is part of the scheme, not the answer");
  assert.match(result.body, /^Digest /);
  assert.match(result.body, /realm="kakapo"/);
  assert.match(result.body, /nonce="abc123"/);
  assert.match(result.body, /qop=auth/, "the server offered qop, so the response is computed with it");
  assert.match(result.body, /response="[0-9a-f]{32}"/);
  assert.match(result.body, /opaque="op"/, "an opaque value is echoed back verbatim, as the RFC requires");
});

test("a `< ./file` body is read by main, so its bytes are not laundered through a string", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-httpbody-"));
  try {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42]);
    writeFileSync(join(root, "body.bin"), bytes);
    const seen = await echo({ method: "POST", bodyFile: "body.bin" }, { root });
    assert.equal(seen.body, bytes.toString("base64"), "every byte arrived unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multipart parts are assembled by main, with a file part's bytes read from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-httpmultipart-"));
  try {
    writeFileSync(join(root, "input.bin"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const result = await performHttpRequest({
      method: "POST", url: `${origin}/echo`,
      headers: { "Content-Type": "multipart/form-data; boundary=sep" },
      boundary: "sep",
      bodyParts: [
        { headers: { "Content-Disposition": 'form-data; name="meta"' }, text: '{"k":"v"}' },
        { headers: { "Content-Disposition": 'form-data; name="file"; filename="input.bin"' }, file: "input.bin" },
      ],
    }, { root });
    assert.equal(result.ok, true, result.error);
    const body = Buffer.from(JSON.parse(result.body).body, "base64");
    assert.match(body.toString("latin1"), /^--sep\r\nContent-Disposition: form-data; name="meta"\r\n\r\n\{"k":"v"\}\r\n/);
    assert.ok(body.includes(Buffer.from([0xde, 0xad, 0xbe, 0xef])), "the file part went out as bytes");
    assert.ok(body.toString("latin1").endsWith("--sep--\r\n"), "and the body is closed off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multipart file part outside the review is refused rather than read", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-httpescape-"));
  try {
    const result = await performHttpRequest({
      method: "POST", url: `${origin}/echo`, headers: {}, boundary: "sep",
      bodyParts: [{ headers: {}, file: "../../../etc/passwd" }],
    }, { root });
    assert.equal(result.ok, false);
    assert.match(result.error, /outside the review/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("@no-redirect hands back the 3xx instead of following it", async () => {
  const followed = await performHttpRequest({ method: "GET", url: `${origin}/to-ok`, headers: {} });
  assert.equal(followed.body, "plain answer");
  const stopped = await performHttpRequest({ method: "GET", url: `${origin}/to-ok`, headers: {}, noRedirect: true });
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(stopped.status, 302, "the redirect itself is the response the reviewer asked to see");
  assert.deepEqual(stopped.redirects, []);
});

test("a followed redirect is reported, so where a request ended up is readable", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/to-ok`, headers: {} });
  assert.deepEqual(result.redirects, [`${origin}/ok`]);
});

test("@timeout gives up instead of hanging, and says so", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/slow`, headers: {}, timeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 60 ms/);
});

test("a non-text response comes back as bytes with its size, not as mojibake", async () => {
  const result = await performHttpRequest({ method: "GET", url: `${origin}/png`, headers: {} });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.body, undefined, "a PNG is not text");
  assert.equal(result.bytes, 8);
  assert.equal(Buffer.from(result.bodyBase64, "base64")[1], 0x50);
});

// ---- the cookie jar ---------------------------------------------------------------------------------
// Kept in kakapo's own user-data mirror, never in the reviewed project (AGENTS.md), in IntelliJ's own
// readable `# domain path name value date` format.

test("cookies are saved on one request and sent on the next", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-cookie-repo-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-cookie-data-"));
  try {
    const first = await performHttpRequest({ method: "GET", url: `${origin}/set-cookie`, headers: {} }, { root, userData });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.cookies.length, 2);

    const second = await performHttpRequest({ method: "GET", url: `${origin}/echo`, headers: {} }, { root, userData });
    const seen = JSON.parse(second.body);
    assert.match(seen.cookie, /session=s-1/);
    assert.match(seen.cookie, /theme=dark/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("@no-cookie-jar keeps a response's cookies out of the jar", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-cookie-repo-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-cookie-data-"));
  try {
    await performHttpRequest({ method: "GET", url: `${origin}/set-cookie`, headers: {}, noCookieJar: true }, { root, userData });
    const next = await performHttpRequest({ method: "GET", url: `${origin}/echo`, headers: {} }, { root, userData });
    assert.equal(JSON.parse(next.body).cookie, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a Cookie: line written in the .http file wins outright over the jar", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-cookie-repo-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-cookie-data-"));
  try {
    await performHttpRequest({ method: "GET", url: `${origin}/set-cookie`, headers: {} }, { root, userData });
    const explicit = await performHttpRequest(
      { method: "GET", url: `${origin}/echo`, headers: { Cookie: "session=mine" } }, { root, userData });
    assert.equal(JSON.parse(explicit.body).cookie, "session=mine",
      "appending to a request the reviewer can read would change what they ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---- reading and writing files the .http file names -------------------------------------------------

test("an attachment read is confined to the review, canonically", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-attach-"));
  const outside = mkdtempSync(join(tmpdir(), "kakapo-attach-out-"));
  try {
    writeFileSync(join(root, "payload.json"), '{"ok":true}');
    writeFileSync(join(outside, "secret.txt"), "shh");
    // A tracked symlink keeps the LINK inside the root while its target is not, which a lexical check misses.
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));

    assert.equal(readHttpAttachment(root, "payload.json").text, '{"ok":true}');
    assert.equal(readHttpAttachment(root, "./payload.json").text, '{"ok":true}');
    assert.equal(readHttpAttachment(root, "../secret.txt").ok, false);
    assert.equal(readHttpAttachment(root, "/etc/passwd").ok, false);
    assert.equal(readHttpAttachment(root, "leak.txt").ok, false, "a symlink out of the review is not a way in");
    assert.equal(readHttpAttachment(root, "missing.json").ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test(">> writes beside an existing file, >>! overwrites it", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-save-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-save-data-"));
  try {
    mkdirSync(join(root, "out"), { recursive: true });
    const first = saveHttpResponse(root, userData, { path: "out/report.json", body: "one" });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.path, join("out", "report.json"));

    const second = saveHttpResponse(root, userData, { path: "out/report.json", body: "two" });
    assert.equal(second.path, join("out", "report-1.json"), "an existing file is kept");
    assert.equal(readFileSync(join(root, "out", "report.json"), "utf8"), "one");

    const forced = saveHttpResponse(root, userData, { path: "out/report.json", body: "three", force: true });
    assert.equal(forced.path, join("out", "report.json"));
    assert.equal(readFileSync(join(root, "out", "report.json"), "utf8"), "three");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("{{$historyFolder}} writes into kakapo's user-data mirror, never into the reviewed project", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-history-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-history-data-"));
  try {
    const saved = saveHttpResponse(root, userData, { path: "$historyFolder/latest.json", body: "{}" });
    assert.equal(saved.ok, true, saved.error);
    assert.ok(saved.path.startsWith(userData), `saved under user data (got ${saved.path})`);
    assert.equal(readFileSync(saved.path, "utf8"), "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a response save cannot be aimed out of the review", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-save-escape-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-save-escape-data-"));
  try {
    for (const path of ["../escaped.json", "/tmp/escaped.json", "out/../../escaped.json", ""]) {
      const result = saveHttpResponse(root, userData, { path, body: "x" });
      assert.equal(result.ok, false, `${path} must be refused`);
    }
    // And a folder that does not exist is not created inside someone's repository.
    assert.equal(saveHttpResponse(root, userData, { path: "nope/out.json", body: "x" }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---- the variable scopes that ride in with the environments ------------------------------------------

test("$shared, .env and the referenced process variables arrive as their own scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-scopes-"));
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "http-client.env.json"), JSON.stringify({
      $shared: { "api-version": "v2" },
      dev: { host: "https://dev.test", "api-version": "v3" },
      prod: { host: "https://prod.test" },
    }));
    writeFileSync(join(root, "http-client.private.env.json"), JSON.stringify({ dev: { token: "private" } }));
    writeFileSync(join(root, ".env"), "# a comment\nexport TOKEN=\"from-dotenv\"\nPLAIN=2\n");

    const scopes = collectHttpEnvironments(root, ["api/calls.http"]);
    assert.equal(scopes.$shared["api-version"], "v2", "$shared is its own scope, not an environment");
    assert.equal(scopes.dev["api-version"], "v3", "and an environment overrides it");
    assert.equal(scopes.dev.token, "private", "the private file's values join the environment");
    assert.equal(scopes.$dotenv.TOKEN, "from-dotenv", "quotes and `export` are stripped");
    assert.equal(scopes.$dotenv.PLAIN, "2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an environment's SSLConfiguration block is not offered as a variable", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-ssl-"));
  try {
    writeFileSync(join(root, "http-client.env.json"), JSON.stringify({
      dev: { host: "https://dev.test", SSLConfiguration: { verifyHostCertificate: false } },
    }));
    const scopes = collectHttpEnvironments(root, []);
    assert.equal(scopes.dev.host, "https://dev.test");
    assert.equal(scopes.dev.SSLConfiguration, undefined, "{{SSLConfiguration}} would resolve to [object Object]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
