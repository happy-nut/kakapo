import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSymbolCache } from "../dist/analysis-cache.js";
import { buildProjectIndex } from "../dist/analysis-index.js";
import { repositorySymbolCacheFile, workspaceSymbolCacheFile } from "../dist/workspace-data.js";

const scratch = [];
test.after(() => { while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true }); });

const USER_DATA = "/tmp/kakapo-user-data";

function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-worktree-cache-"));
  scratch.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@kakapo.local");
  git("config", "user.name", "kakapo test");
  git("config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git("add", "-A");
  git("commit", "-qm", "first");
  return root;
}

const SOURCE = {
  "src/orders.ts": [
    "export class OrderBook {",
    "  place(order: string): void {}",
    "}",
    "export function settle(book: OrderBook) { return book; }",
  ].join("\n"),
  "src/prices.ts": "export const basePrice = 10;\nexport type Currency = string;\n",
};

test("a worktree and the checkout it came from read and write one symbol cache", () => {
  const main = repository(SOURCE);
  const sibling = join(main, "..", `${main.split("/").pop()}-sibling`);
  scratch.push(sibling);
  execFileSync("git", ["worktree", "add", "--detach", "-q", sibling, "HEAD"], { cwd: main, stdio: "pipe" });

  assert.equal(repositorySymbolCacheFile(USER_DATA, sibling), repositorySymbolCacheFile(USER_DATA, main),
    "a sibling worktree must land on the main checkout's cache file, or every worktree re-scans from nothing");
  assert.equal(repositorySymbolCacheFile(USER_DATA, main), workspaceSymbolCacheFile(USER_DATA, main),
    "and the shared file is the main checkout's own, so nothing moves when a worktree is added or removed");
});

test("another repository does not share that cache", () => {
  const one = repository(SOURCE);
  const other = repository(SOURCE);
  assert.notEqual(repositorySymbolCacheFile(USER_DATA, one), repositorySymbolCacheFile(USER_DATA, other));
});

test("a directory that is not a repository still resolves to a cache of its own", () => {
  const loose = mkdtempSync(join(tmpdir(), "kakapo-loose-"));
  scratch.push(loose);
  assert.equal(repositorySymbolCacheFile(USER_DATA, loose), workspaceSymbolCacheFile(USER_DATA, loose));
});

test("what one worktree scanned, the next one is served without scanning", async () => {
  const main = repository(SOURCE);
  const sibling = join(main, "..", `${main.split("/").pop()}-served`);
  scratch.push(sibling);
  execFileSync("git", ["worktree", "add", "--detach", "-q", sibling, "HEAD"], { cwd: main, stdio: "pipe" });
  const file = join(mkdtempSync(join(tmpdir(), "kakapo-cachefile-")), "symbols", "index.json");
  scratch.push(join(file, "..", ".."));

  const cold = openSymbolCache(file);
  const first = await buildProjectIndex(main, cold);
  assert.ok(first.symbols.length >= 4, `the fixture should index, got ${first.symbols.length}`);
  assert.equal(cold.stats().hits, 0);
  assert.equal(cold.stats().misses, first.files.size);

  const warm = openSymbolCache(file);
  const second = await buildProjectIndex(sibling, warm);
  assert.equal(warm.stats().misses, 0, "the sibling holds the same text, so nothing may be scanned again");
  assert.equal(warm.stats().hits, second.files.size);

  const shape = (index) => [...index.symbols]
    .map((record) => `${record.path}:${record.lineIndex}:${record.name}:${record.symbolKind}:${record.declaration}`)
    .sort();
  assert.deepEqual(shape(second), shape(first), "a served index must be the scanned one, declaration text included");
});

test("a file the sibling changed is the only one scanned again", async () => {
  const main = repository(SOURCE);
  const sibling = join(main, "..", `${main.split("/").pop()}-edited`);
  scratch.push(sibling);
  execFileSync("git", ["worktree", "add", "--detach", "-q", sibling, "HEAD"], { cwd: main, stdio: "pipe" });
  const file = join(mkdtempSync(join(tmpdir(), "kakapo-cachefile-")), "symbols", "index.json");
  scratch.push(join(file, "..", ".."));

  const first = await buildProjectIndex(main, openSymbolCache(file));
  writeFileSync(join(sibling, "src/prices.ts"), "export const basePrice = 11;\nexport type Currency = string;\n");

  const warm = openSymbolCache(file);
  const second = await buildProjectIndex(sibling, warm);
  assert.deepEqual(warm.stats(), { hits: first.files.size - 1, misses: 1 },
    "one edited file is one miss; a cache that missed on the rest is not keyed by content");
  assert.ok(second.definitions.has("basePrice"));
});
