import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteBudgetCache, githubOwnerFromUrl } from "../dist/util.js";

// The GitHub owner parse feeds the workspace badge avatar; pin the remote-URL shapes it must handle,
// extracted from app-main so it's testable without a git repo.
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

// Long-lived caches in the main process are keyed by path and hold whole file bodies. Unbounded, they retain
// everything the process ever indexed — across every worktree the reviewer visits — for as long as the app
// runs, which is heap that only ever grows. This is the ceiling that stops it, and eviction has to be by
// LEAST RECENTLY USED: the workspace being watched right now is exactly the one that must keep its entries.
test("the byte-budget cache evicts oldest-first and keeps what is being used", () => {
  const cache = new ByteBudgetCache(10, (value) => value.length);
  cache.set("a", "1234");
  cache.set("b", "1234");
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 8, limit: 10 });

  cache.get("a");             // a is now the most recently used, b the oldest
  cache.set("c", "1234");     // 12 > 10 -> the oldest goes
  assert.equal(cache.get("b"), undefined, "the least recently used entry was dropped");
  assert.equal(cache.get("a"), "1234", "the one still in use survived");
  assert.equal(cache.get("c"), "1234", "and the new entry is there");
  assert.ok(cache.stats().bytes <= 10, "the budget holds");

  // Re-storing a key must not double-count it, and a value larger than the whole budget is still usable
  // for the caller that just asked for it — it simply arrives alone.
  cache.set("a", "1234");
  assert.equal(cache.stats().bytes, 8, "a replaced entry replaces its bytes too");
  cache.set("big", "x".repeat(50));
  assert.equal(cache.get("big").length, 50, "the entry just stored is never the one evicted");
  assert.equal(cache.stats().entries, 1, "everything else made way for it");
});
