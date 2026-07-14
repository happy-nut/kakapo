import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMarkdownMemo, canonicalWorktreePath, markdownMemoFile } from "../dist/memos.js";

let root;
let worktree;
let userData;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  const base = mkdtempSync(join(tmpdir(), "monacori-memos-"));
  root = join(base, "repo");
  worktree = join(base, "feature-worktree");
  userData = join(base, "app-data");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Monacori Test"]);
  git(root, ["config", "user.email", "test@monacori.local"]);
  writeFileSync(join(root, "README.md"), "# Test\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["worktree", "add", "-b", "feature", worktree]);
});

after(() => {
  if (root) rmSync(join(root, ".."), { recursive: true, force: true });
});

test("the single memo persists in app data and survives a new store instance", () => {
  const store = new ProjectMarkdownMemo(userData);
  const saved = store.write(root, "# Evidence\n\nKeep this.");
  const file = markdownMemoFile(userData, root);
  assert.ok(existsSync(file), "the memo is stored below userData");
  assert.equal(file.startsWith(userData), true);
  assert.equal(existsSync(join(root, ".monacori", "memos.json")), false, "no memo artifact is written into the source tree");

  assert.match(saved.body, /Evidence/);
  store.write(root, "changed");
  const reopened = new ProjectMarkdownMemo(userData).read(root);
  assert.equal(reopened.body, "changed", "a fresh process/store can restore the memo");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).worktreePath, canonicalWorktreePath(root));

  assert.equal(store.remove(root), true);
  assert.equal(new ProjectMarkdownMemo(userData).read(root).body, "");
  assert.equal(git(root, ["status", "--porcelain"]), "", "memo CRUD leaves the repository clean");
});

test("the same repository's separate worktrees receive isolated memo stores", () => {
  const store = new ProjectMarkdownMemo(userData);
  store.write(root, "main");
  store.write(worktree, "feature");
  assert.notEqual(markdownMemoFile(userData, root), markdownMemoFile(userData, worktree));
  assert.equal(store.read(root).body, "main");
  assert.equal(store.read(worktree).body, "feature");

  const nested = join(root, "src", "nested");
  mkdirSync(nested, { recursive: true });
  assert.equal(canonicalWorktreePath(nested), canonicalWorktreePath(root), "subdirectories resolve to their worktree top level");
  assert.equal(store.read(nested).body, "main");
});

test("corrupt app data is surfaced and never overwritten as an empty notebook", () => {
  const store = new ProjectMarkdownMemo(userData);
  const file = markdownMemoFile(userData, worktree);
  const corrupt = "{ definitely-not-valid-json\n";
  writeFileSync(file, corrupt);

  assert.throws(() => store.read(worktree), SyntaxError);
  assert.throws(() => store.write(worktree, "Must not overwrite"), SyntaxError);
  assert.equal(readFileSync(file, "utf8"), corrupt);
});
