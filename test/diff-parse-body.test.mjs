// A hunk's CONTENT used to be read as the file's METADATA, because the parser had no notion of being inside
// a hunk and tried the header patterns against every line.
//
// Git prefixes a deleted line with `-`, so a deleted `-- note` — an ordinary comment in SQL, Lua, Haskell or
// Ada, and the `-- ` signature delimiter — arrives as `--- note` and was taken for the `--- a/path` header:
// the deletion disappeared from the hunk, every old line number after it shifted up by one, and oldPath
// became the comment's text. diff2html, which renders the same text with its own parser, kept the line — so
// what the reviewer saw and what kakapo believed about it drifted apart from that line on.
//
// An added `++ b/…` line reached `+++ b/…` the same way, and that one picks the file's displayPath — which
// collectSourceFiles joins to the review root and reads. One line of a reviewed file could therefore name
// the file the index went and read.
//
// Both go through real git rather than a hand-written diff: the point is what git actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnifiedDiff, parseUnifiedDiff, collectSourceFiles, computeChangeSet } from "../dist/diff.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-body-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const parse = (root) => parseUnifiedDiff(readUnifiedDiff({ root, base: "HEAD", context: 3, staged: false, includeUntracked: false }));

test("a deleted `-- comment` line stays in its hunk and does not become the file's path", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "schema.sql"), "-- old comment\nCREATE TABLE t (id INT);\nkeep\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(join(r.root, "schema.sql"), "CREATE TABLE t (id INT);\nkeep\n");

    const [file] = parse(r.root);
    assert.equal(file.displayPath, "schema.sql");
    assert.equal(file.oldPath, "schema.sql", "the comment's text must not become the old path");
    const lines = file.hunks[0].lines;
    assert.deepEqual(
      lines.map((line) => [line.kind, line.oldLine ?? null, line.text]),
      [
        ["delete", 1, "-- old comment"],
        ["context", 2, "CREATE TABLE t (id INT);"],
        ["context", 3, "keep"],
      ],
      "the deletion is a line of the hunk, and the lines after it keep their old numbers",
    );
  } finally { r.cleanup(); }
});

test("an added `++ b/…` line cannot point the source index outside the review root", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "notes.md"), "line one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(join(r.root, "notes.md"), "line one\n++ b/../escaped.txt\n");
    writeFileSync(join(r.root, "..", "escaped.txt"), "secret\n");

    const [file] = parse(r.root);
    assert.equal(file.displayPath, "notes.md", "the file under review is still notes.md");
    assert.deepEqual(
      file.hunks[0].lines.filter((line) => line.kind === "add").map((line) => line.text),
      ["++ b/../escaped.txt"],
      "and the line is an addition, not a header",
    );
    const escaped = collectSourceFiles(parse(r.root), r.root, {}).filter((source) => source.path.includes(".."));
    assert.deepEqual(escaped, [], "nothing from outside the root is indexed");
  } finally {
    rmSync(join(r.root, "..", "escaped.txt"), { force: true });
    r.cleanup();
  }
});

// `diff --git a/<path> b/<path>` with a space in the path is ambiguous to a greedy pattern, and a path may
// contain the substring ` b/` outright. A text file is corrected by its `---`/`+++` pair and a rename by its
// `rename from`/`rename to` lines, but a changed BINARY has neither: it was listed at a path that does not
// exist, so the Changes list grew a phantom row and the real image appeared nowhere.
test("a changed binary under a path containing ` b/` is listed at its real path", () => {
  const r = repo();
  try {
    mkdirSync(join(r.root, "docs", "plan b"), { recursive: true });
    const image = join(r.root, "docs", "plan b", "diagram.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x09]));

    const [file] = parse(r.root);
    assert.equal(file.binary, true);
    assert.equal(file.displayPath, "docs/plan b/diagram.png");
    assert.equal(file.oldPath, "docs/plan b/diagram.png");
  } finally { r.cleanup(); }
});

// The restructure moved the content dispatch ahead of the header patterns, so the one line git writes inside
// a hunk that is neither content nor a header has to keep occupying no line on either side.
test("`\\ No newline at end of file` still counts for nothing", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\ntwo");
    r.git("add", "-A");
    r.git("commit", "-qm", "init");
    writeFileSync(join(r.root, "a.txt"), "one\ntwo\n");

    const [file] = parse(r.root);
    const kinds = file.hunks[0].lines.map((line) => line.kind);
    assert.deepEqual(kinds, ["context", "delete", "add"]);
    assert.equal(file.hunks[0].lines[2].newLine, 2, "the added line is new line 2, not 3");
  } finally { r.cleanup(); }
});

// The boundary itself, asked directly. With the parser fixed nothing produces an escaping path any more, so
// this is the only thing that can still fail if the check is removed — and a check nothing can fail is
// furniture. computeChangeSet is where a diff path becomes a path the index joins to the root and reads.
test("the change set drops a path that leaves the review root", () => {
  const poisoned = ["../escaped.txt", "/etc/passwd", "a/../../escaped.txt", "C:/Windows/win.ini"]
    .map((displayPath) => ({ oldPath: displayPath, newPath: displayPath, displayPath, status: "added", binary: false, hunks: [] }));
  const good = { oldPath: "src/a.ts", newPath: "src/a.ts", displayPath: "src/a.ts", status: "modified", binary: false, hunks: [] };
  const { changed } = computeChangeSet([...poisoned, good]);
  assert.deepEqual([...changed], ["src/a.ts"]);
});
