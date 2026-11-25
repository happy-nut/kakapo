import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commentsFilePath } from "../dist/comments-file.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const store = readFileSync(join(repoRoot, "intellij-plugin/src/main/kotlin/dev/kakapo/comments/CommentStore.kt"), "utf8");
const gitDir = readFileSync(join(repoRoot, "intellij-plugin/src/main/kotlin/dev/kakapo/comments/GitDir.kt"), "utf8");
const action = readFileSync(join(repoRoot, "intellij-plugin/src/main/kotlin/dev/kakapo/comments/AddCommentAction.kt"), "utf8");
const handOff = readFileSync(join(repoRoot, "intellij-plugin/src/main/kotlin/dev/kakapo/comments/HandOffAction.kt"), "utf8");

function worktree() {
  const main = mkdtempSync(join(tmpdir(), "kakapo-wt-main-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  git(main, "init", "-qb", "main");
  git(main, "config", "user.email", "verify@kakapo.test");
  git(main, "config", "user.name", "kakapo verify");
  execFileSync("sh", ["-c", `echo hi > "${main}/a.txt"`]);
  git(main, "add", "-A");
  git(main, "commit", "-qm", "initial");
  const linked = `${main}-linked`;
  git(main, "worktree", "add", "-q", linked, "-b", "side");
  return { main, linked, remove: () => { rmSync(main, { recursive: true, force: true }); rmSync(linked, { recursive: true, force: true }); } };
}

test("a linked worktree keeps .git as a file, which is what the plugin used to refuse", () => {
  const tree = worktree();
  try {
    const dot = join(tree.linked, ".git");
    const pointer = readFileSync(dot, "utf8");
    assert.match(pointer, /^gitdir: /, "this is the shape the plugin has to read");
    assert.ok(commentsFilePath(tree.linked), "and kakapo itself resolves a review file there");
  } finally {
    tree.remove();
  }
});

test("the plugin reads that pointer instead of demanding a directory", () => {
  // Asserted of GitDir, which has no IDE in it precisely so `npm run idea:review` can run this rule
  // against real directories rather than read it here.
  assert.doesNotMatch(gitDir, /import com\.intellij/, "GitDir stays runnable without a sandbox");
  assert.match(gitDir, /startsWith\("gitdir:"\)/,
    "a linked worktree and a submodule both keep .git as a file holding this line");
  assert.match(store, /GitDir\.reviewFile/, "and the store asks it rather than guessing");
});

test("a comment that cannot be stored is said out loud, not dropped", () => {
  assert.match(store, /fun append\(comment: Comment\): Boolean/,
    "append answers whether the comment reached the file");
  assert.match(action, /if \(store\.file\(\) == null\)[\s\S]*?showErrorDialog/,
    "the box is refused before it opens when there is nowhere to write");
  assert.match(action, /if \(stored\) \{[\s\S]*?\} else \{[\s\S]*?showErrorDialog/,
    "and a failed write is shown with the text, so it can be pasted somewhere else");
});

test("where a comment points has one spelling, and the body does not carry it", () => {
  assert.match(store, /fun where\(path: String, line: Int\): String = "@\$path#L\$line"/,
    "the location is spelled once");
  assert.match(action, /text = written,/, "so the stored body is what the writer typed, and nothing else");
  assert.match(handOff, /comment\.where\(\)/, "and the hand-off builds the location from the record");
  assert.doesNotMatch(action, /text = "\$label \$written"/, "which is what the body used to carry");
});

test("the box shows that location while the comment is being written", () => {
  const box = readFileSync(join(repoRoot, "intellij-plugin/src/main/kotlin/dev/kakapo/comments/CommentBox.kt"), "utf8");
  assert.match(box, /JBLabel\(label\)/, "a label, not emptyText: the first keystroke wipes emptyText");
  assert.doesNotMatch(box, /emptyText\.text = "\$label/, "which is where the location used to be");
});
