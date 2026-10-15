// The .http runner executes a request whose URL, headers and body come from a file in the reviewed
// repository, in the main process, with no CORS and no sandbox. Loopback stays reachable on purpose — running
// a request against your own dev server is the point of the feature — but the destination has to be the one
// written in the file the reviewer ran: a scheme they can read, and not a redirect chain that quietly leads
// somewhere else.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performHttpRequest } from "../dist/server.js";

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
