// Two ways a real change used to go missing from a review.
//
// 1. Several ordinary changes produce no hunks — a 100%-similarity rename, `chmod +x`, an added empty file —
//    and the parser dropped every file that had none. `git mv` plus `chmod +x` painted "No diff to review",
//    which reads as "the agent did nothing".
// 2. git C-quotes a path containing `"`, `\`, a tab or a newline whatever core.quotePath says. Left raw, the
//    leading quote hid the `b/` prefix, the file read as absent from the working tree, and because that is
//    the exact string commentFileIsKnownMissing matches, every comment on it was deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnifiedDiff, parseUnifiedDiff, computeChangeSet, collectSourceFiles } from "../dist/diff.js";
import { unquoteGitPath, stripDiffPath } from "../dist/util.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-edge-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function parse(root) {
  return parseUnifiedDiff(readUnifiedDiff({ root, base: "HEAD", context: 3 }));
}

test("a rename, a mode-only change and an added empty file are all in the review", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(r.root, "m.sh"), "#!/bin/sh\necho hi\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");

    r.git("mv", "a.ts", "b.ts");
    chmodSync(join(r.root, "m.sh"), 0o755);
    writeFileSync(join(r.root, "empty.txt"), "");
    r.git("add", "-A");

    const files = parse(r.root);
    const byPath = new Map(files.map((file) => [file.displayPath, file]));
    assert.deepEqual([...byPath.keys()].sort(), ["b.ts", "empty.txt", "m.sh"]);
    assert.equal(byPath.get("b.ts").status, "renamed", "the rename is a rename, not a vanished file");
    assert.equal(byPath.get("b.ts").hunks.length, 0, "and it still has no hunks — that was never the test");
    assert.equal(byPath.get("m.sh").modeChanged, true, "a mode-only change says so");
    assert.equal(byPath.get("empty.txt").status, "added");

    const { changed } = computeChangeSet(files);
    assert.deepEqual([...changed].sort(), ["b.ts", "empty.txt", "m.sh"], "all three reach the changed set");
  } finally {
    r.cleanup();
  }
});

test("a path git had to quote is read back as its real name", () => {
  const r = repo();
  try {
    const name = 'quo"te.ts';
    writeFileSync(join(r.root, name), "export const a = 1;\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(join(r.root, name), "export const a = 2;\n");

    const [file] = parse(r.root);
    assert.equal(file.displayPath, name, "no phantom directory, no stray quote");
    assert.equal(file.oldPath, name);
    assert.equal(file.newPath, name);

    // The point of the fix: the record resolves on disk, so it is not reported missing — which is what
    // caused comments on it to be deleted.
    const sources = collectSourceFiles(parse(r.root), r.root);
    const record = sources.find((entry) => entry.path === name);
    assert.ok(record, "the file is in the source index under its real name");
    assert.notEqual(record.skippedReason, "file is not present in the working tree");
  } finally {
    r.cleanup();
  }
});

test("git's C-quoting is decoded, including multi-byte escapes", () => {
  assert.equal(unquoteGitPath('"quo\\"te.ts"'), 'quo"te.ts');
  assert.equal(unquoteGitPath('"tab\\there.ts"'), "tab\there.ts");
  assert.equal(unquoteGitPath('"back\\\\slash.ts"'), "back\\slash.ts");
  // One escape per BYTE: decoding them individually would mangle every multi-byte character.
  assert.equal(unquoteGitPath('"\\354\\225\\210\\353\\202\\264.md"'), "안내.md");
  assert.equal(unquoteGitPath('"mixed \\354\\225\\210 and \\"quote\\".md"'), 'mixed 안 and "quote".md');
  assert.equal(unquoteGitPath("plain.ts"), "plain.ts", "an unquoted path is left exactly as it is");
  assert.equal(unquoteGitPath('"unterminated'), '"unterminated', "and so is anything not actually quoted");
  assert.equal(stripDiffPath('"b/quo\\"te.ts"'), 'quo"te.ts', "the b/ prefix is behind the quote, not in front");
  assert.equal(stripDiffPath("/dev/null"), "/dev/null");
});

// 3. A path with a SPACE in it is not quoted — git has no reason to — but its `---`/`+++` header lines carry
//    a trailing TAB, git's column separator, which it omits for a quoted path because the quotes already
//    delimit it. Left on, the tab was part of the path and travelled out through every map keyed by one: the
//    file rendered in the diff and then reported "file is not present in the working tree" when opened, the
//    language server was asked about a path that does not exist, and because the `diff --git` line spells it
//    correctly while `+++` did not, the SAME file appeared twice in Quick Open and twice in the tree.
//
//    Driven through a real repository rather than a hand-written patch: the tab is git's doing, and a
//    fixture written here would be a restatement of what this test exists to pin down.
test("a path with a space keeps git's column tab out of its name", () => {
  const r = repo();
  try {
    const name = "src dir/plain space.txt";
    mkdirSync(join(r.root, "src dir"), { recursive: true });
    writeFileSync(join(r.root, name), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(join(r.root, name), "one\ntwo\n");

    const [file] = parse(r.root);
    assert.equal(file.displayPath, name, "the name is the name — no trailing tab");
    assert.equal(file.oldPath, name, "`---` agrees with it");
    assert.equal(file.newPath, name, "and so does `+++`");
    // The duplicate rows came from the two spellings disagreeing, so that is asserted as the one fact it is.
    assert.equal(new Set([file.displayPath, file.oldPath, file.newPath]).size, 1,
      "one file, one spelling: two of them is what listed it twice");

    const { changed } = computeChangeSet([file]);
    assert.deepEqual([...changed], [name], "and the changed set is keyed by the real path");
  } finally {
    r.cleanup();
  }
});

test("stripDiffPath cuts the column tab, and only that", () => {
  assert.equal(stripDiffPath("a/plain space.txt\t"), "plain space.txt");
  assert.equal(stripDiffPath("b/plain space.txt\t"), "plain space.txt");
  // Unified diffs may print a timestamp after the separator; it is not part of the name either.
  assert.equal(stripDiffPath("a/x y.txt\t2026-11-01 12:00:00.000000000 +0900"), "x y.txt");
  assert.equal(stripDiffPath("a/no-space.txt"), "no-space.txt", "nothing to cut, nothing cut");
  // Cut BEFORE unquoting, or the closing quote is no longer last and the value comes back raw.
  assert.equal(stripDiffPath('"b/quo\\"te.ts"\t'), 'quo"te.ts');
  assert.equal(stripDiffPath("/dev/null"), "/dev/null");
});
