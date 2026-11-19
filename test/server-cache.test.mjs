import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_CACHE_DIRECTORIES,
  SERVER_CACHE_INSIDE_PROJECT,
  SERVER_CACHE_SCOPES,
  SHARED_CACHE_KEY,
  isServerCacheInsideProject,
  markServerCacheUsed,
  reclaimServerCaches,
  reclaimableServerCaches,
  serverCacheDirectory,
} from "../dist/server-cache.js";
import { readUnifiedDiff } from "../dist/diff.js";
import { reviewDiffSignature } from "../dist/review-bodies.js";

const DAY = 86_400_000;
const scratch = [];
function base() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-server-cache-"));
  scratch.push(dir);
  return dir;
}
test.after(() => { while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true }); });

const WHY_THIS_SCOPE = {
  go: ["shared", "go's build and module caches are content-addressed and Go's own default is one cache per machine; a sibling worktree rebuilt the same tree in 0.40s against a shared cache and 4.32s against its own"],
  rust: ["worktree", "two checkouts sharing CARGO_TARGET_DIR read each other's artifacts as current: a worktree with a type error reported zero errors after the sibling compiled"],
  java: ["worktree", "jdtls -data holds workspace state, not content-addressed entries, and its README says it must be unique per project"],
  kotlin: ["worktree", "no published account of what --system-path holds, so it is not shared until someone measures it"],
  ruby: ["worktree", "sorbet keys entries by path##checksum and its docs say a checked-out old branch reuses them, but nobody has measured sharing one cache-dir between two live processes"],
  php: ["worktree", "no published account of what phpactor's XDG dirs hold, so it is not shared until someone measures it"],
};

const SERVERS_WITHOUT_A_CACHE = {
  clang: "clangd 22.1.6 writes one .idx per translation unit under .cache/clangd inside the project being read; --background-index is on by default in this build and --help-list offers no option that moves the directory, so kakapo hides the path instead of placing it",
};

test("every bundled server either takes its cache path from the table or is written down as having none", () => {
  const source = readFileSync(new URL("../src/lsp.ts", import.meta.url), "utf8");
  const start = source.indexOf("function bundledNativeCommand");
  assert.ok(start > 0, "bundledNativeCommand is where a bundled server's cache path is decided");
  const body = source.slice(start);
  const families = [...body.matchAll(/if \(family === "([a-z]+)"\) \{/g)].map((match) => match[1]);
  assert.ok(families.length >= 6, `expected the bundled families, found ${families.join(", ")}`);

  for (let at = 0; at < families.length; at += 1) {
    const family = families[at];
    const from = body.indexOf(`if (family === "${family}")`);
    const to = at + 1 < families.length ? body.indexOf(`if (family === "${families[at + 1]}")`) : body.length;
    const branch = body.slice(from, to);
    const usesTable = branch.includes("serverCacheDirectory(");
    if (SERVERS_WITHOUT_A_CACHE[family]) {
      assert.equal(usesTable, false, `${family} is written down as having no cache, so it must not take one from the table`);
      continue;
    }
    assert.ok(usesTable, `${family} builds a cache path of its own; put it in SERVER_CACHE_DIRECTORIES or write down why it has none`);
    assert.ok(SERVER_CACHE_DIRECTORIES[family], `${family} has no directory row`);
    assert.ok(SERVER_CACHE_SCOPES[family], `${family} has no scope row`);
    assert.ok(WHY_THIS_SCOPE[family], `${family}'s scope has no reason written beside it`);
    assert.equal(SERVER_CACHE_SCOPES[family], WHY_THIS_SCOPE[family][0],
      `${family}'s declared scope and the reason written for it disagree`);
    if (SERVER_CACHE_SCOPES[family] === "worktree") {
      assert.match(branch, /cacheDirectory[:,]/,
        `${family}'s cache is reclaimed by age, so its command must carry cacheDirectory for the sweep to see it opened`);
    }
  }
  assert.ok(!branchLeftOver(body, families), "a family matched outside the scan");

  const starting = source.slice(source.indexOf("private start()"));
  assert.match(starting.slice(0, starting.indexOf("spawn(this.server.command")), /markServerCacheUsed\(this\.server\.cacheDirectory\)/,
    "a cache is reclaimed by age, so opening a server must freshen it before the process starts");
});

function branchLeftOver(body, families) {
  const declared = new Set(families);
  return [...body.matchAll(/if \(family === "([a-z]+)"\)/g)].some((match) => !declared.has(match[1]));
}

test("a shared cache is one directory for every worktree; a worktree cache is one each", () => {
  const home = base();
  const a = join(home, "checkout-a");
  const b = join(home, "checkout-b");

  assert.equal(serverCacheDirectory("go", a, home), serverCacheDirectory("go", b, home),
    "gopls is the measured case: a sibling worktree must reuse the build and module cache");
  assert.ok(serverCacheDirectory("go", a, home).endsWith(join("kakapo-go", SHARED_CACHE_KEY)));

  for (const family of Object.keys(SERVER_CACHE_SCOPES)) {
    if (SERVER_CACHE_SCOPES[family] === "shared") continue;
    assert.notEqual(serverCacheDirectory(family, a, home), serverCacheDirectory(family, b, home),
      `${family} is declared per worktree, so two checkouts must not land on one directory`);
  }
});

test("a family with no row cannot be given a cache by accident", () => {
  assert.throws(() => serverCacheDirectory("clang", "/tmp/anything"), /no language-server cache directory is declared/);
});

test("a cache nothing has opened for a month is reclaimed; a fresh one and the shared one are not", () => {
  const home = base();
  const old = serverCacheDirectory("rust", "/gone/worktree", home);
  const fresh = serverCacheDirectory("java", "/live/worktree", home);
  const shared = serverCacheDirectory("go", "/any/worktree", home);
  for (const directory of [old, fresh, shared]) {
    mkdirSync(join(directory, "inside"), { recursive: true });
    writeFileSync(join(directory, "inside", "artifact.bin"), "x".repeat(1024));
  }
  const longAgo = new Date(Date.now() - 45 * DAY);
  utimesSync(old, longAgo, longAgo);
  utimesSync(shared, longAgo, longAgo);

  assert.deepEqual(reclaimableServerCaches({ base: home }), [old]);
  return reclaimServerCaches({ base: home }).then((reclaimed) => {
    assert.deepEqual(reclaimed, [old]);
    assert.throws(() => statSync(old), /ENOENT/, "the stale cache is gone from disk, not just from the list");
    assert.ok(statSync(fresh).isDirectory(), "a cache used this month survives");
    assert.ok(statSync(shared).isDirectory(), "the shared cache has no worktree to outlive, so age must not reclaim it");
  });
});

test("opening a server freshens its cache, so the next sweep leaves it alone", () => {
  const home = base();
  const directory = serverCacheDirectory("kotlin", "/live/worktree", home);
  mkdirSync(directory, { recursive: true });
  const longAgo = new Date(Date.now() - 45 * DAY);
  utimesSync(directory, longAgo, longAgo);
  assert.deepEqual(reclaimableServerCaches({ base: home }), [directory]);

  markServerCacheUsed(directory);
  assert.deepEqual(reclaimableServerCaches({ base: home }), [],
    "the sweep reads the directory's own mtime, which is why a server start must touch it");
});

test("one sweep cannot spend the whole launch deleting", () => {
  const home = base();
  const longAgo = new Date(Date.now() - 45 * DAY);
  const made = [];
  for (let index = 0; index < 30; index += 1) {
    const directory = serverCacheDirectory("php", `/gone/worktree-${index}`, home);
    mkdirSync(directory, { recursive: true });
    utimesSync(directory, longAgo, longAgo);
    made.push(directory);
  }
  assert.equal(reclaimableServerCaches({ base: home }).length, 24, "the sweep is bounded per launch");
  assert.equal(reclaimableServerCaches({ base: home, limit: 5 }).length, 5);
  assert.equal(made.length, 30);
});

test("a server that writes its cache inside the project declares that path, and only such a server may", () => {
  for (const family of Object.keys(SERVER_CACHE_INSIDE_PROJECT)) {
    assert.ok(SERVERS_WITHOUT_A_CACHE[family],
      `${family} takes a cache path from the table, so it has no business writing one inside the project`);
    assert.ok(SERVERS_WITHOUT_A_CACHE[family].includes(SERVER_CACHE_INSIDE_PROJECT[family]),
      `${family}'s written reason must name the directory it writes, so the two cannot drift apart`);
  }
  assert.ok(isServerCacheInsideProject(".cache/clangd/index/main.c.51B8DF90E4B3D1D7.idx"));
  assert.ok(isServerCacheInsideProject("packages/engine/.cache/clangd/index/a.idx"),
    "a sub-project compiled in place gets its own copy, so the match is on the segment and not on the prefix");
  assert.equal(isServerCacheInsideProject(".cache/clangd"), true);
  assert.equal(isServerCacheInsideProject("src/.cache/other/thing.idx"), false,
    "another tool's .cache is not ours to hide");
  assert.equal(isServerCacheInsideProject("src/cache/clangd/notes.md"), false);
});

test("an index a language server wrote into the reviewed project never reaches the review", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-clangd-"));
  scratch.push(root);
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "ada@kakapo.test"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);

  mkdirSync(join(root, ".cache", "clangd", "index"), { recursive: true });
  writeFileSync(join(root, ".cache", "clangd", "index", "main.c.51B8DF90E4B3D1D7.idx"), "index payload\n");
  writeFileSync(join(root, "helper.c"), "void helper(void) { }\n");

  const diff = readUnifiedDiff({ root, includeUntracked: true, context: 3, staged: false });
  assert.ok(diff.includes("b/helper.c"),
    "an untracked source file is still an addition, so the review has something to lose");
  assert.equal(diff.includes(".cache/clangd"), false,
    "clangd writes its index into the project and kakapo launched it, so the user must not meet it as a diff");
});

test("a server still indexing does not keep rebuilding the review behind the user", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-clangd-watch-"));
  scratch.push(root);
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "ada@kakapo.test"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  const options = { root, includeUntracked: true, staged: false };

  const quiet = reviewDiffSignature(options);
  mkdirSync(join(root, ".cache", "clangd", "index"), { recursive: true });
  writeFileSync(join(root, ".cache", "clangd", "index", "main.c.51B8DF90E4B3D1D7.idx"), "first pass\n");
  assert.equal(reviewDiffSignature(options), quiet,
    "clangd writes an index per translation unit while the window is open; each write must not look like an edit");

  writeFileSync(join(root, ".cache", "clangd", "index", "main.c.51B8DF90E4B3D1D7.idx"), "a longer second pass\n");
  assert.equal(reviewDiffSignature(options), quiet, "nor must rewriting one");

  writeFileSync(join(root, "helper.c"), "void helper(void) { }\n");
  assert.notEqual(reviewDiffSignature(options), quiet,
    "a real untracked file is still what the watch exists for");
});
