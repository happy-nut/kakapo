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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
