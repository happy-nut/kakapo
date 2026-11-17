import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitLog, readGitReflog, readGitStashes, resolveGitRevision } from "../dist/git-log.js";

let root;
const subjects = (commits) => commits.map((commit) => commit.subject);

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-gitread-"));
  const git = (args, env = {}) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, ...env } });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "ada@kakapo.test"]);
  git(["config", "user.name", "Ada Lovelace"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(root, "a.txt"), "needle in the haystack\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "first: add a"], { GIT_AUTHOR_DATE: "2020-01-02T10:00:00+0000", GIT_COMMITTER_DATE: "2020-01-02T10:00:00+0000" });

  writeFileSync(join(root, "b.txt"), "beta\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "second: add b", "--author=Grace Hopper <grace@kakapo.test>"],
    { GIT_COMMITTER_DATE: "2021-06-01T10:00:00+0000", GIT_AUTHOR_DATE: "2021-06-01T10:00:00+0000" });

  git(["mv", "a.txt", "renamed.txt"]);
  git(["commit", "-qm", "third: rename a to renamed"]);

  git(["checkout", "-qb", "side"]);
  writeFileSync(join(root, "side.txt"), "side\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "fourth: only on side"]);
  git(["checkout", "-q", "main"]);

  writeFileSync(join(root, "b.txt"), "beta, edited\n");
  git(["stash", "push", "-qm", "work in progress"]);
  git(["tag", "v1.0"]);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("the log walks every branch by default and only HEAD when asked", () => {
  assert.ok(subjects(readGitLog(root)).includes("fourth: only on side"), "--all sees the other branch");
  assert.ok(!subjects(readGitLog(root, { currentBranchOnly: true })).includes("fourth: only on side"),
    "current branch only walks HEAD");
});

test("a named branch is walked on its own", () => {
  const onSide = subjects(readGitLog(root, { branch: "side" }));
  assert.ok(onSide.includes("fourth: only on side"));
  assert.ok(onSide.includes("first: add a"), "and its ancestors come with it");
});

test("the author filter is applied by git, not by hiding rows", () => {
  assert.deepEqual(subjects(readGitLog(root, { author: "Grace" })), ["second: add b"]);
  assert.deepEqual(readGitLog(root, { author: "nobody at all" }), [],
    "an author with no commits is an empty answer, not an unfiltered page");
});

test("the message filter matches a substring, case-insensitively, and is not read as a regex", () => {
  assert.deepEqual(subjects(readGitLog(root, { text: "SECOND" })), ["second: add b"]);
  assert.deepEqual(readGitLog(root, { text: "second: [" }), []);
});

test("the path filter narrows to what touched it, and `follow` carries a file through its rename", () => {
  assert.deepEqual(subjects(readGitLog(root, { path: "b.txt" })), ["second: add b"]);
  const followed = subjects(readGitLog(root, { path: "renamed.txt", follow: true }));
  assert.ok(followed.includes("third: rename a to renamed"));
  assert.ok(followed.includes("first: add a"), "the file's story does not begin at its current name");
  const unfollowed = subjects(readGitLog(root, { path: "renamed.txt" }));
  assert.ok(!unfollowed.includes("first: add a"), "without --follow it begins at the rename");
});

test("the content filter finds the commit that introduced a string", () => {
  assert.deepEqual(subjects(readGitLog(root, { content: "needle" })), ["first: add a"]);
});

test("the date filters bound the range", () => {
  assert.deepEqual(subjects(readGitLog(root, { until: "2020-12-31" })), ["first: add a"]);
  assert.ok(!subjects(readGitLog(root, { since: "2021-01-01" })).includes("first: add a"));
});

test("filters combine", () => {
  assert.deepEqual(readGitLog(root, { author: "Grace", path: "a.txt" }), [],
    "Grace never touched a.txt, and both filters are applied");
  assert.deepEqual(subjects(readGitLog(root, { author: "Grace", text: "second" })), ["second: add b"]);
});

test("the reflog says where HEAD has been, with each entry's selector and action", () => {
  const entries = readGitReflog(root, { limit: 50 });
  assert.ok(entries.length >= 4, `the reflog has entries (got ${entries.length})`);
  assert.match(entries[0].selector, /^HEAD@\{\d+\}$/);
  assert.ok(entries.some((entry) => /checkout|commit|reset/.test(entry.action)),
    "the action is what git recorded, not the commit subject");
  assert.ok(entries.every((entry) => /^[0-9a-f]{40,64}$/.test(entry.hash)), "every entry is a real commit");
  assert.ok(entries.every((entry) => entry.extra === undefined),
    "the raw trailing fields do not leak out of the reader");
});

test("the stash list is read, and each entry is a commit the review surface can open", () => {
  const stashes = readGitStashes(root);
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].selector, "stash@{0}");
  assert.match(stashes[0].subject, /work in progress/);
  assert.match(stashes[0].hash, /^[0-9a-f]{40,64}$/);
  const firstParent = execFileSync("git", ["rev-parse", `${stashes[0].hash}^1`], { cwd: root, stdio: "pipe" }).toString().trim();
  assert.equal(stashes[0].parents[0], firstParent, "the base its diff is read against comes with it");
});

test("a hash, a branch, a tag and HEAD~1 all resolve to the commit they name", () => {
  const head = resolveGitRevision(root, "HEAD");
  assert.ok(head, "HEAD resolves");
  assert.match(head.hash, /^[0-9a-f]{40,64}$/);
  assert.equal(head.subject, "third: rename a to renamed");

  assert.equal(resolveGitRevision(root, head.hash.slice(0, 8))?.hash, head.hash, "an abbreviated hash resolves");
  assert.equal(resolveGitRevision(root, "v1.0")?.hash, head.hash, "a tag resolves");
  assert.equal(resolveGitRevision(root, "side")?.subject, "fourth: only on side", "a branch resolves");
  assert.equal(resolveGitRevision(root, "HEAD~1")?.subject, "second: add b");
  assert.match(resolveGitRevision(root, "main")?.refs ?? "", /main/, "the decoration comes with it");
});

test("ordinary words resolve to nothing, which is how the search box stays a text filter", () => {
  for (const query of ["second", "add b", "", "   ", "not-a-ref-at-all"]) {
    assert.equal(resolveGitRevision(root, query), null, `${JSON.stringify(query)} names no commit`);
  }
});

test("a filter value cannot turn into another git option", () => {
  assert.deepEqual(readGitLog(root, { author: "--all" }), []);
  assert.deepEqual(readGitLog(root, { text: "--pretty=format:%H" }), []);
  assert.deepEqual(readGitLog(root, { content: "--output=/tmp/kakapo-should-not-exist" }), []);
});

test("a ref or a path that is not one is dropped rather than passed through", () => {
  const all = subjects(readGitLog(root));
  for (const branch of ["--all", "-n1", "../escape", "main..side", "a b", "main;ls"]) {
    assert.deepEqual(subjects(readGitLog(root, { branch })), all,
      `${branch} is not a ref name — the log falls back to every branch`);
  }
  for (const path of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
    assert.deepEqual(subjects(readGitLog(root, { path })), all,
      `${path} cannot leave the repository — it is dropped, not resolved`);
  }
  assert.deepEqual(subjects(readGitLog(root, { since: "yesterday; rm -rf /" })), all);
});

test("the page size is bounded whatever is asked for", () => {
  assert.ok(readGitLog(root, { limit: 1 }).length === 1);
  assert.ok(readGitLog(root, { limit: 10 ** 9 }).length <= 2000);
  assert.ok(readGitReflog(root, { limit: 10 ** 9 }).length <= 1000);
});
