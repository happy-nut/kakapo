import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteBudgetCache, githubOwnerFromUrl } from "../dist/util.js";

test("githubOwnerFromUrl handles the common remote URL shapes", () => {
  assert.equal(githubOwnerFromUrl("https://github.com/acme/repo.git"), "acme");
  assert.equal(githubOwnerFromUrl("https://github.com/acme/repo"), "acme");
  assert.equal(githubOwnerFromUrl("git@github.com:acme/repo.git"), "acme");
  assert.equal(githubOwnerFromUrl("ssh://git@github.com/acme/repo"), "acme");
  assert.equal(githubOwnerFromUrl("https://GitHub.com/Acme/Repo"), "Acme", "host match is case-insensitive; owner case is kept");
});

test("githubOwnerFromUrl returns undefined for non-GitHub or unparseable remotes", () => {
  assert.equal(githubOwnerFromUrl("https://gitlab.com/acme/repo.git"), undefined);
  assert.equal(githubOwnerFromUrl(""), undefined);
  assert.equal(githubOwnerFromUrl("not a url"), undefined);
});

test("the byte-budget cache evicts oldest-first and keeps what is being used", () => {
  const cache = new ByteBudgetCache(10, (value) => value.length);
  cache.set("a", "1234");
  cache.set("b", "1234");
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 8, limit: 10 });

  cache.get("a");
  cache.set("c", "1234");
  assert.equal(cache.get("b"), undefined, "the least recently used entry was dropped");
  assert.equal(cache.get("a"), "1234", "the one still in use survived");
  assert.equal(cache.get("c"), "1234", "and the new entry is there");
  assert.ok(cache.stats().bytes <= 10, "the budget holds");

  cache.set("a", "1234");
  assert.equal(cache.stats().bytes, 8, "a replaced entry replaces its bytes too");
  cache.set("big", "x".repeat(50));
  assert.equal(cache.get("big").length, 50, "the entry just stored is never the one evicted");
  assert.equal(cache.stats().entries, 1, "everything else made way for it");
});
