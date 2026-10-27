// The .http runner executes a request whose URL, headers and body come from a file in the reviewed
// repository, in the main process, with no CORS and no sandbox. Loopback stays reachable on purpose — running
// a request against your own dev server is the point of the feature — but the destination has to be the one
// written in the file the reviewer ran: a scheme they can read, and not a redirect chain that quietly leads
// somewhere else.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { performHttpRequest } from "../dist/server.js";
import { collectHttpEnvironments } from "../dist/diff.js";
import { cookieHeaderFor, readHttpAttachment, saveCookies, saveHttpResponse } from "../dist/http-files.js";
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
    // A hop that stays on this origin, and an endpoint that reports what it was sent.
    if (req.url === "/to-echo") {
      res.writeHead(302, { location: "/echo-headers" });
      res.end();
      return;
    }
    if (req.url === "/echo-headers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
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
    // A Digest challenge the caller gets to dictate, so one fixture covers every algorithm and qop a
    // server can ask for. The query is the WWW-Authenticate header, verbatim.
    if (req.url?.startsWith("/challenge")) {
      if (!req.headers.authorization) {
        res.writeHead(401, { "www-authenticate": decodeURIComponent(req.url.split("?")[1] ?? "") });
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

// Two directives describe two phases of one request, and `fetch` offers no hook between them. The larger
// is used — never shorter than either was asked for — and the message names the deadline applied, so a
// request that stopped early can be read back to the line that set it.
test("@connection-timeout counts too: the deadline is the larger of the two", async () => {
  const connectOnly = await performHttpRequest({ method: "GET", url: `${origin}/slow`, headers: {}, connectTimeoutMs: 50 });
  assert.equal(connectOnly.ok, false);
  assert.match(connectOnly.error, /timed out after 50 ms/);

  const both = await performHttpRequest({
    method: "GET", url: `${origin}/slow`, headers: {}, timeoutMs: 80, connectTimeoutMs: 40,
  });
  assert.equal(both.ok, false);
  assert.match(both.error, /timed out after 80 ms/, "the shorter phase does not shorten the whole request");

  // And a generous connection timeout is not overridden by the 60s default.
  const generous = await performHttpRequest({ method: "GET", url: `${origin}/ok`, headers: {}, connectTimeoutMs: 120_000 });
  assert.equal(generous.ok, true, generous.error);
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

// ---- a client certificate --------------------------------------------------------------------------
// `fetch` cannot carry one, so this is the one request path that does not go through it. Both halves are
// exercised against a real TLS server: the certificate reaching the server, and a self-signed host being
// refused unless the environment says otherwise.

test("a client certificate is read from the review and presented to the server", async (t) => {
  const { createServer } = await import("node:https");
  const { generateKeyPairSync, X509Certificate, createPrivateKey } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "kakapo-tls-"));
  let server;
  try {
    // openssl is the only thing here that can mint a certificate; without it there is nothing to test.
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost",
        "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"),
      ], { stdio: "pipe" });
    } catch {
      t.skip("openssl is not available to mint a test certificate");
      return;
    }
    const cert = readFileSync(join(root, "cert.pem"));
    const key = readFileSync(join(root, "key.pem"));
    let presented = null;
    server = createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, (request, response) => {
      presented = request.socket.getPeerCertificate?.()?.subject?.CN ?? null;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("over tls");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${server.address().port}/`;

    // Self-signed, so the default (verify) must refuse it — that refusal is the feature working.
    const refused = await performHttpRequest({ method: "GET", url, headers: {}, ssl: { verifyHostCertificate: true, clientCertificate: "cert.pem" } }, { root });
    assert.equal(refused.ok, false, "a self-signed host is not trusted by default");

    const result = await performHttpRequest({
      method: "GET", url, headers: {},
      ssl: { clientCertificate: "cert.pem", clientCertificateKey: "key.pem", verifyHostCertificate: false },
    }, { root });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.body, "over tls");
    assert.equal(presented, "localhost", "the server saw the certificate from the review");
  } finally {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a certificate outside the review, or one needing a passphrase, is refused by name", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-tls-guard-"));
  try {
    const escaped = await performHttpRequest(
      { method: "GET", url: "https://127.0.0.1:1/", headers: {}, ssl: { clientCertificate: "../../etc/ssl/cert.pem", verifyHostCertificate: false } },
      { root },
    );
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /outside the review/);

    const locked = await performHttpRequest(
      { method: "GET", url: "https://127.0.0.1:1/", headers: {}, ssl: { clientCertificate: "cert.pem", hasCertificatePassphrase: true } },
      { root },
    );
    assert.equal(locked.ok, false);
    assert.match(locked.error, /passphrase/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- what travels with a redirect -------------------------------------------------------------------
// The redirect tests above check where a hop LEADS. Nothing checked what it carries, and the answer was
// everything: following redirects manually is what makes each destination checkable, and it also took over
// the one thing `redirect: "follow"` had been doing correctly — fetch drops Authorization when a redirect
// crosses origins. A server named in a .http file could answer `302 Location: http://elsewhere/` and be
// handed the reviewer's password in cleartext.

test("credentials do not follow a redirect to another origin", async () => {
  const collected = [];
  const other = createServer((req, res) => {
    collected.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("collected");
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherOrigin = `http://127.0.0.1:${other.address().port}`;
  const away = createServer((req, res) => {
    res.writeHead(302, { location: `${otherOrigin}/collect` });
    res.end();
  });
  await new Promise((resolve) => away.listen(0, "127.0.0.1", resolve));

  try {
    const result = await performHttpRequest({
      method: "GET",
      url: `http://127.0.0.1:${away.address().port}/api`,
      headers: { Cookie: "session=reviewers-session", Accept: "application/json" },
      auth: { type: "basic", user: "reviewer", password: "hunter2" },
    });
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(collected.length, 1, "the hop was followed");
    const got = collected[0];
    assert.equal(got.authorization, undefined, "the reviewer's password did not go to a host they never named");
    assert.equal(got.cookie, undefined, "nor the session cookie the file set for the other host");
    assert.equal(got.accept, "application/json", "an ordinary header still travels, as it does in a browser");
  } finally {
    other.close();
    away.close();
  }
});

test("a redirect within the same origin still carries them", async () => {
  // The ordinary case — a trailing slash, a login hop — and stripping there would break every one of them.
  const result = await performHttpRequest({
    method: "GET",
    url: `${origin}/to-echo`,
    headers: {},
    auth: { type: "basic", user: "reviewer", password: "hunter2" },
  });
  assert.equal(result.ok, true, result.error ?? "");
  assert.deepEqual(result.redirects, [`${origin}/echo-headers`]);
  assert.equal(JSON.parse(result.body).authorization, `Basic ${Buffer.from("reviewer:hunter2").toString("base64")}`);
});

// ---- the cookie jar's half of RFC 6265 ---------------------------------------------------------------
// The jar is written by hand — IntelliJ's own file format, no dependency — and the tests it had covered
// the round trip: a cookie saved on one request is sent on the next, @no-cookie-jar skips it, a Cookie:
// line in the file wins. All happy paths, all from a server behaving itself. What a hand-written jar
// actually has to get right is the four rules that decide when NOT to send one, and none of them were
// there: a response could claim any host it liked, `Domain=com` matched every .com, `Secure` was not
// parsed at all, and a cookie with no Domain= went to every subdomain of the host that set it.

const jarDirs = [];
function jar() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-jar-root-"));
  const userData = mkdtempSync(join(tmpdir(), "kakapo-jar-data-"));
  jarDirs.push(root, userData);
  return {
    save: (origin, header) => saveCookies(root, userData, new URL(origin), [header]),
    get: (origin) => cookieHeaderFor(root, userData, new URL(origin)),
  };
}
after(() => jarDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a response cannot set a cookie for a host it has nothing to do with", () => {
  const j = jar();
  j.save("http://attacker.test/x", "injected=1; Domain=github.com; Path=/");
  assert.equal(j.get("https://api.github.com/user"), "",
    "Domain= may widen a cookie to a PARENT of the host that set it, and to nothing else");
});

test("a response cannot claim an entire public suffix", () => {
  const j = jar();
  j.save("http://attacker.test/x", "everywhere=2; Domain=com; Path=/");
  assert.equal(j.get("https://example.com/"), "", "`com` is a suffix of every .com host, which is the point");
});

test("a Secure cookie does not go out over plain http", () => {
  const j = jar();
  j.save("https://bank.test/login", "session=3; Path=/; Secure");
  assert.equal(j.get("http://bank.test/"), "", "the whole meaning of the flag");
  assert.equal(j.get("https://bank.test/"), "session=3");
  // Loopback counts as secure, as it does in every browser: a .http file run against your own dev server
  // over http is the feature, not an attack on it.
  j.save("http://localhost:3000/login", "dev=4; Path=/; Secure");
  assert.equal(j.get("http://localhost:3000/me"), "dev=4");
});

test("a cookie with no Domain= belongs to that host, not to everything under it", () => {
  const j = jar();
  j.save("https://example.org/", "hostonly=5; Path=/");
  assert.equal(j.get("https://sub.example.org/"), "", "a subdomain is a host the server never named");
  assert.equal(j.get("https://example.org/"), "hostonly=5");
});

test("and the flows a reviewer actually runs are untouched", () => {
  const j = jar();
  j.save("https://api.example.com/login", "session=abc; Path=/");
  assert.equal(j.get("https://api.example.com/users"), "session=abc");
  // A legitimate parent domain — the single-sign-on shape these files are full of.
  j.save("https://auth.example.com/login", "sso=xyz; Domain=example.com; Path=/");
  assert.equal(j.get("https://api.example.com/users"), "session=abc; sso=xyz");
  j.save("https://paths.test/api/v1", "scoped=2; Path=/api");
  assert.equal(j.get("https://paths.test/api/v1/x"), "scoped=2");
  assert.equal(j.get("https://paths.test/other"), "");
  j.save("https://expiry.test/", "gone=3; Path=/; Max-Age=0");
  assert.equal(j.get("https://expiry.test/"), "");
});

// --- Round 5: the multipart body is assembled by hand, so it inherited none of fetch's checks. ---
// Every assertion below reads the body back through a REAL multipart parser (undici's, the same one a
// server-side framework uses) rather than through a regex of our own, because the question is not what
// bytes went out — it is what a server concludes the reviewer asked for.

/** The fields a real parser extracts from the body that actually went on the wire. */
async function fieldsOnTheWire(result) {
  const echoed = JSON.parse(result.body);
  const form = await new Response(Buffer.from(echoed.body, "base64"), {
    headers: { "content-type": echoed.contentType },
  }).formData();
  return [...form.entries()].map(([name, value]) => [name, typeof value === "string" ? value : value.name]);
}

const upload = (boundary, bodyParts, context = {}) => performHttpRequest({
  method: "POST", url: `${origin}/echo`,
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  boundary, bodyParts,
}, context);

const disposition = (name) => ({ "Content-Disposition": `form-data; name="${name}"` });

/** The shape an encoder actually generates, and the length at which the boundary check never misfires. */
const WEBKIT_BOUNDARY = "----WebKitFormBoundary7MA4YWxkTrZu0gW";

test("a multipart part whose content carries the delimiter is refused", async () => {
  // The content is a {{variable}} away from being the server's own words: a value captured out of an
  // earlier response, or an env value out of the reviewed repository. Two fields were written here.
  const result = await upload("kakapo-boundary", [
    {
      headers: disposition("note"),
      text: 'hi\r\n--kakapo-boundary\r\nContent-Disposition: form-data; name="role"\r\n\r\nadmin',
    },
    { headers: disposition("role"), text: "viewer" },
  ]);
  assert.equal(result.ok, false, "three fields would have arrived, the injected one first");
  assert.match(result.error, /the part named note/);
  assert.match(result.error, /contains the boundary kakapo-boundary/);
});

test("a multipart part whose content contains the bare boundary is refused as well", async () => {
  // RFC 2046 says a delimiter is CRLF + `--boundary`, which would make this harmless. Measured against
  // undici — Node's own `fetch`, and so the server side of most JS dev servers — it is not: the complete
  // boundary string anywhere in a part, with no `--` and nowhere near a line start, makes it reject the
  // whole body. A prefix of the boundary, or the boundary less one character, parses fine. The check can
  // only be as narrow as the most eager parser that will read the body, which is this one.
  const result = await upload(WEBKIT_BOUNDARY, [
    { headers: disposition("note"), text: `see ${WEBKIT_BOUNDARY} for the separator` },
    { headers: disposition("role"), text: "viewer" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /contains the boundary/);
});

test("a multipart upload whose content does not contain the boundary is untouched", async () => {
  // Including a near miss: a prefix of the boundary, which is what the strictness costs and does not.
  const note = "dashes -- and ----WebKitFormBoundary, neither of them the whole thing";
  const result = await upload(WEBKIT_BOUNDARY, [
    { headers: disposition("note"), text: note },
    { headers: disposition("role"), text: "viewer" },
  ]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(await fieldsOnTheWire(result), [["note", note], ["role", "viewer"]]);
});

test("a multipart part reading a file whose bytes carry the delimiter is refused", async () => {
  // The same hole, reached by the path the reviewer is least able to check: a file in the repository
  // under review, whose contents they never read, sent as a field's text.
  const root = mkdtempSync(join(tmpdir(), "kakapo-mp-delim-"));
  try {
    writeFileSync(join(root, "note.txt"), 'hi\r\n--sep\r\nContent-Disposition: form-data; name="role"\r\n\r\nadmin');
    const result = await upload("sep", [
      // A file part's disposition carries `filename=` before `name=`, and the error has to name the field
      // rather than the tail of the filename, or it points the reviewer at the wrong part.
      { headers: { "Content-Disposition": 'form-data; filename="note.txt"; name="note"' }, file: "note.txt" },
      { headers: disposition("role"), text: "viewer" },
    ], { root });
    assert.equal(result.ok, false);
    assert.match(result.error, /^the part named note: /);
    assert.match(result.error, /contains the boundary sep/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a part header with a line break in its value is refused", async () => {
  // `fetch` throws on CRLF in a real header value. Nothing checked these, so the break closed the header
  // block, added a part, and swallowed the reviewer's own value — `note` arrived as `injected`.
  const result = await upload("kakapo-boundary", [
    {
      headers: {
        ...disposition("note"),
        "X-Tag": 'a\r\n\r\ninjected\r\n--kakapo-boundary\r\nContent-Disposition: form-data; name="role"\r\n\r\nadmin',
      },
      text: "hello",
    },
    { headers: disposition("role"), text: "viewer" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /the header X-Tag has a line break/);
});

test("a part header with an ordinary value still goes out", async () => {
  const result = await upload("sep", [
    { headers: { ...disposition("file"), "Content-Type": "application/json; charset=utf-8" }, text: "{}" },
  ]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(await fieldsOnTheWire(result), [["file", "{}"]]);
});

// --- Round 5: Digest named an algorithm in the header and then ignored it. ---

/**
 * Recompute the response the way the server does — from the header's own fields, including the `uri` it
 * claims to have signed — and say which hash it was actually built with.
 */
function digestHashUsed(header, user, password, method) {
  const field = (name) => {
    const match = new RegExp(`${name}=("[^"]*"|[^,]*)`).exec(header);
    return match ? match[1].replace(/^"|"$/g, "") : undefined;
  };
  for (const algorithm of ["md5", "sha256", "sha512-256"]) {
    const hash = (value) => createHash(algorithm).update(value, "utf8").digest("hex");
    let ha1 = hash(`${user}:${field("realm")}:${password}`);
    if (/-sess$/i.test(field("algorithm") ?? "")) ha1 = hash(`${ha1}:${field("nonce")}:${field("cnonce")}`);
    const ha2 = hash(`${method}:${field("uri")}`);
    const qop = field("qop");
    const want = qop
      ? hash(`${ha1}:${field("nonce")}:${field("nc")}:${field("cnonce")}:${qop}:${ha2}`)
      : hash(`${ha1}:${field("nonce")}:${ha2}`);
    if (want === field("response")) return algorithm;
  }
  return "none of them";
}

const challenged = (www) => performHttpRequest({
  method: "GET", url: `${origin}/challenge?${encodeURIComponent(www)}`, headers: {},
  auth: { type: "digest", user: "ada", password: "s3cret" },
});

test("digest with algorithm MD5 answers with an MD5 response", async () => {
  const result = await challenged('Digest realm="k", qop="auth", nonce="abc", algorithm=MD5');
  assert.equal(result.ok, true, result.error);
  assert.match(result.body, /algorithm=MD5,/);
  assert.equal(digestHashUsed(result.body, "ada", "s3cret", "GET"), "md5");
});

test("digest with algorithm SHA-256 answers with a SHA-256 response", async () => {
  // It used to send an MD5 digest labelled `algorithm=SHA-256`: 32 hex characters where 64 were promised.
  const result = await challenged('Digest realm="k", qop="auth", nonce="abc", algorithm=SHA-256');
  assert.equal(result.ok, true, result.error);
  assert.match(result.body, /algorithm=SHA-256,/);
  assert.match(result.body, /response="[0-9a-f]{64}"/);
  assert.equal(digestHashUsed(result.body, "ada", "s3cret", "GET"), "sha256");
});

test("digest with algorithm SHA-512-256 answers with a SHA-512-256 response", async () => {
  const result = await challenged('Digest realm="k", qop="auth", nonce="abc", algorithm=SHA-512-256');
  assert.equal(result.ok, true, result.error);
  assert.equal(digestHashUsed(result.body, "ada", "s3cret", "GET"), "sha512-256");
});

test("digest echoes the algorithm name the server spelled, not an upper-cased copy of it", async () => {
  // RFC 7616 registers `MD5-sess`; a server comparing the token literally rejects `MD5-SESS`.
  const result = await challenged('Digest realm="k", qop="auth", nonce="abc", algorithm=MD5-sess');
  assert.equal(result.ok, true, result.error);
  assert.match(result.body, /algorithm=MD5-sess,/);
  assert.equal(digestHashUsed(result.body, "ada", "s3cret", "GET"), "md5");
});

test("digest refuses an algorithm it cannot compute instead of answering with another one", async () => {
  const result = await challenged('Digest realm="k", qop="auth", nonce="abc", algorithm=SHA3-512');
  assert.equal(result.ok, false);
  assert.match(result.error, /algorithm=SHA3-512, which kakapo cannot compute/);
});

test("digest will not drop to the RFC 2069 form when the server offers only auth-int", async () => {
  // The old fallback sent no cnonce and no nc, which is the replayable 1999 form of the scheme — and the
  // server that asked for auth-int would have rejected it anyway, as a bare 401 with nothing to read.
  const result = await challenged('Digest realm="k", qop="auth-int", nonce="abc"');
  assert.equal(result.ok, false);
  assert.match(result.error, /qop=auth-int only; kakapo implements qop=auth/);
});
