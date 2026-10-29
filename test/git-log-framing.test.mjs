// The history panel's records used to be framed on 0x1e, chosen because "git output can't contain it".
// Git output can: a commit message is arbitrary bytes, `git commit -m` passes 0x1e straight through, and
// `git fsck` only warns about far worse. One commit in a reviewed repository could therefore draw extra
// ROWS in the log — hash, author, email, date and subject all of its author's choosing — while the real
// commit it hid in showed a subject truncated at the injection point. For a tool whose job is to tell a
// reviewer what happened, a forged row is the worst kind of bug: it reads as evidence.
//
// `-z` would not have helped (a NUL in a message is emitted verbatim too). A newline is the one separator
// git normalises away: %s is the first paragraph with its line breaks turned into spaces, and a newline in
// an ident makes git print %an/%ae empty instead of leaking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitLog, resolveGitRevision } from "../dist/git-log.js";
import { readPatchSets } from "../dist/patch-sets.js";

const RS = "\x1e";
const FS = "\x1f";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-log-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a commit message cannot add a row to the history panel", () => {
  const r = repo();
  try {
    const forged = [
      "innocent subject", RS,
      "0000000000000000000000000000000000000000", FS, "", FS,
      "Linus Torvalds", FS, "linus@kernel.org", FS, "2026-01-01", FS, "", FS,
      "Merge: audited and approved",
    ].join("");
    writeFileSync(join(r.root, "a.txt"), "two\n");
    r.git("commit", "-qam", forged);

    const rows = readGitLog(r.root, { limit: 50 });
    assert.equal(rows.length, 2, "two commits exist, so two rows");
    assert.deepEqual(rows.map((row) => row.author), ["Test", "Test"], "no row has an author nobody committed as");
    assert.ok(!rows.some((row) => /^0+$/.test(row.hash)), "and none has a hash the forger chose");
    // The whole message is the real commit's subject, separator bytes and all — nothing was truncated to
    // make the framing work.
    assert.ok(rows[0].subject.includes("Merge: audited and approved"), "the forged text stays inside the subject it was written in");
  } finally { r.cleanup(); }
});

test("a subject carrying the field separator shifts nothing", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "a.txt"), "three\n");
    r.git("commit", "-qam", `fix${FS}something${FS}odd`);

    const [head] = readGitLog(r.root, { limit: 10 });
    assert.equal(head.author, "Test");
    assert.equal(head.email, "t@example.test");
    assert.ok(head.date.startsWith("20"), `a real date, got ${JSON.stringify(head.date)}`);

    const resolved = resolveGitRevision(r.root, "HEAD");
    assert.equal(resolved.author, "Test", "and the same for one resolved revision");
    assert.ok(resolved.date.startsWith("20"));
    assert.equal(resolved.subject, `fix${FS}something${FS}odd`, "the subject comes back whole");
  } finally { r.cleanup(); }
});

// The patch-set selector reads the same kind of record, and a forged one there is worse than a forged
// history row: the sha of the row the reviewer picks becomes the diff's BASE, so an invented entry with a
// plausible subject makes them read a change set nobody wrote.
test("a commit message cannot add an entry to the patch-set selector", () => {
  const r = repo();
  try {
    r.git("branch", "-M", "main");
    r.git("checkout", "-qb", "feature");
    writeFileSync(join(r.root, "a.txt"), "work\n");
    r.git("commit", "-qam", `real work${RS}0000000000000000000000000000000000000000${FS}0000000${FS}2026-01-01${FS}fix: security patch`);

    const list = readPatchSets(r.root);
    assert.equal(list.commits.length, 1, "one commit ahead of main, so one patch set");
    assert.ok(!list.commits.some((commit) => /^0+$/.test(commit.sha)), "no entry whose sha the forger chose");
    assert.ok(list.commits[0].date.startsWith("20"), `a real date, got ${JSON.stringify(list.commits[0].date)}`);
    assert.ok(list.commits[0].subject.includes("fix: security patch"), "the forged text stays inside the subject");
  } finally { r.cleanup(); }
});
