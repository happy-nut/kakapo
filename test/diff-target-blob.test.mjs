// A→B compare serves a changed file's source from commit B instead of the working tree, and that second
// read has to answer the same two questions the working-tree read answers — otherwise the same file is
// readable on the left of the compare and refused on the right, which is the shape of the UTF-16 bug the
// BOM decode fixed one layer up.
//
// Two measurements had drifted: the binary sniff scanned the WHOLE decoded text where the working-tree
// path sniffs the first 8KB (git's own heuristic), and both size figures were a JS string's `length`,
// which is a character count and not the byte count the budget is written in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeDeferredSourceFile } from "../dist/diff.js";
import { isLikelyBinary } from "../dist/util.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-blob-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const deferred = (path) => ({
  path, name: path, language: "text", content: "", size: 0,
  changed: true, embedded: true, deferred: true, signature: "x",
});

test("a file the working tree accepts is not refused by the A→B read", () => {
  const r = repo();
  try {
    // No NUL in the first 8KB, one far past it: git's heuristic calls this text, and so must both reads.
    const text = "ok\n".repeat(4000) + "tail\0tail\n";
    writeFileSync(join(r.root, "late-nul.txt"), text);
    r.git("add", "-A");
    r.git("commit", "-qm", "b");

    assert.equal(isLikelyBinary(join(r.root, "late-nul.txt")), false, "the working-tree sniff calls it text");
    const fromB = materializeDeferredSourceFile(r.root, deferred("late-nul.txt"), "HEAD");
    assert.equal(fromB.skippedReason, undefined, "and the A→B read agrees");
    assert.equal(fromB.content, text);
  } finally { r.cleanup(); }
});

test("the A→B read reports a size in bytes, as the budget it is checked against is", () => {
  const r = repo();
  try {
    const text = "가".repeat(100) + "\n"; // 100 characters, 300 UTF-8 bytes
    writeFileSync(join(r.root, "ko.txt"), text);
    r.git("add", "-A");
    r.git("commit", "-qm", "b");

    const fromB = materializeDeferredSourceFile(r.root, deferred("ko.txt"), "HEAD");
    assert.equal(fromB.content, text);
    assert.equal(fromB.size, Buffer.byteLength(text, "utf8"), "bytes, not characters");
  } finally { r.cleanup(); }
});

// "The file is not in this revision" and "that revision is not here any more" look identical to
// `git show`, and reporting them as one blamed every file in the review for something none of them did:
// every source preview read "not in the revision being read", for good, with nothing naming the cause.
//
// It is reachable because the check happens at two different times. A BUILD against a revision that does
// not resolve throws and is reported as a build error; the reads happen later, one per file the reader
// opens. Between the two, the ref can go: a branch deleted or renamed, a `fetch --prune`, a rebase, or a
// session restored onto a compare target that has since disappeared. The diff is already drawn by then,
// so the review looks healthy and only the previews are dead.
test("a revision that has gone is reported as that, not as every file being absent", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "kept.ts"), "export const kept = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "first");

    // Both halves of the distinction, against the SAME file.
    const present = materializeDeferredSourceFile(root, deferred("kept.ts"), "HEAD");
    assert.equal(present.embedded, true, "a file that is in the revision still reads");

    const absent = materializeDeferredSourceFile(root, deferred("never-existed.ts"), "HEAD");
    assert.equal(absent.skippedKind, "missingRevision",
      "a file genuinely not in a revision that EXISTS still says so");

    const gone = materializeDeferredSourceFile(root, deferred("kept.ts"), "origin/branch-that-is-gone");
    assert.equal(gone.skippedKind, "missingTarget", "a revision that does not resolve is its own answer");
    assert.equal(gone.skippedDetail, "origin/branch-that-is-gone",
      "…and names the revision, because that is the part the reader can act on");

    // A sha that is well-formed and simply not here takes the same path as a named ref.
    const deadSha = materializeDeferredSourceFile(root, deferred("kept.ts"), "0".repeat(40));
    assert.equal(deadSha.skippedKind, "missingTarget");
  } finally {
    cleanup();
  }
});
