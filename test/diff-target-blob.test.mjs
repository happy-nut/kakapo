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
    const text = "가".repeat(100) + "\n";
    writeFileSync(join(r.root, "ko.txt"), text);
    r.git("add", "-A");
    r.git("commit", "-qm", "b");

    const fromB = materializeDeferredSourceFile(r.root, deferred("ko.txt"), "HEAD");
    assert.equal(fromB.content, text);
    assert.equal(fromB.size, Buffer.byteLength(text, "utf8"), "bytes, not characters");
  } finally { r.cleanup(); }
});

test("a revision that has gone is reported as that, not as every file being absent", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "kept.ts"), "export const kept = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "first");

    const present = materializeDeferredSourceFile(root, deferred("kept.ts"), "HEAD");
    assert.equal(present.embedded, true, "a file that is in the revision still reads");

    const absent = materializeDeferredSourceFile(root, deferred("never-existed.ts"), "HEAD");
    assert.equal(absent.skippedKind, "missingRevision",
      "a file genuinely not in a revision that EXISTS still says so");

    const gone = materializeDeferredSourceFile(root, deferred("kept.ts"), "origin/branch-that-is-gone");
    assert.equal(gone.skippedKind, "missingTarget", "a revision that does not resolve is its own answer");
    assert.equal(gone.skippedDetail, "origin/branch-that-is-gone",
      "…and names the revision, because that is the part the reader can act on");

    const deadSha = materializeDeferredSourceFile(root, deferred("kept.ts"), "0".repeat(40));
    assert.equal(deadSha.skippedKind, "missingTarget");
  } finally {
    cleanup();
  }
});
