// Reading a pull request by its link.
//
// The parsing half is pinned here because the input is whatever a reader has in the clipboard: a link
// copied from the address bar with a tab or an anchor on the end, the `owner/repo#12` shorthand, or a
// bare number meaning "this repository". The lookup half is pinned with a fake `gh` runner — the point is
// what the code does with an answer and with each way of not getting one, and a test that needed the real
// gh (and an account, and a network) would be a test nobody runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePullRequestRef, lookupPullRequest, remoteSlug, localRevisionFor } from "../dist/github-pr.js";

const HERE = { owner: "happy-nut", repo: "kakapo" };

test("a link is read whatever is hanging off the end of it", () => {
  const cases = [
    "https://github.com/happy-nut/kakapo/pull/132",
    "https://github.com/happy-nut/kakapo/pull/132/files",
    "https://github.com/happy-nut/kakapo/pull/132#discussion_r1234567",
    "https://github.com/happy-nut/kakapo/pull/132/files?diff=split",
    "github.com/happy-nut/kakapo/pull/132",
    "  https://github.com/happy-nut/kakapo/pull/132  ",
  ];
  for (const input of cases) {
    assert.deepEqual(parsePullRequestRef(input), { ...HERE, number: 132 }, input);
  }
});

test("the shorthands people type are read too, and a bare number needs a repository to belong to", () => {
  assert.deepEqual(parsePullRequestRef("happy-nut/kakapo#132"), { ...HERE, number: 132 });
  assert.deepEqual(parsePullRequestRef("#132", HERE), { ...HERE, number: 132 });
  assert.deepEqual(parsePullRequestRef("132", HERE), { ...HERE, number: 132 });
  assert.equal(parsePullRequestRef("132"), undefined, "without a fallback there is no repository to ask about");
  assert.equal(parsePullRequestRef(""), undefined);
  assert.equal(parsePullRequestRef("https://github.com/happy-nut/kakapo"), undefined, "a repository is not a pull request");
  assert.equal(parsePullRequestRef("https://github.com/happy-nut/kakapo/issues/132"), undefined, "and neither is an issue");
});

test("a link to another repository is read as that repository, not as this one", () => {
  // The whole reason --repo is passed to gh explicitly: a reader can paste a link to a fork, and answering
  // about the checkout they happen to be in would be a different pull request with the same number.
  assert.deepEqual(parsePullRequestRef("https://github.com/someone/fork/pull/7", HERE),
    { owner: "someone", repo: "fork", number: 7 });
});

test("the remote slug is read from either spelling git hands out", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-slug-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q", ".");
    for (const [url, expected] of [
      ["git@github.com:happy-nut/kakapo.git", HERE],
      ["https://github.com/happy-nut/kakapo.git", HERE],
      ["https://github.com/happy-nut/kakapo", HERE],
      ["ssh://git@github.com/happy-nut/kakapo.git", HERE],
    ]) {
      try { git("remote", "remove", "origin"); } catch { /* the first round has none to remove */ }
      git("remote", "add", "origin", url);
      assert.deepEqual(remoteSlug(root), expected, url);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const answer = (stdout, status = 0, error = undefined) => () => ({ status, stdout, stderr: "", error });

test("the branch names come back from gh", () => {
  const got = lookupPullRequest("/tmp", { ...HERE, number: 132 },
    answer(JSON.stringify({ baseRefName: "main", headRefName: "feature/x", title: "A change" })));
  assert.deepEqual(got, { ok: true, details: { base: "main", head: "feature/x", title: "A change" } });
});

test("each way of not getting an answer is its own named refusal", () => {
  // Named, because they want different sentences: one asks the reader to install something, the other is
  // gh's own complaint (not logged in, no such pull request, no network) and is worth repeating verbatim.
  const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  assert.deepEqual(lookupPullRequest("/tmp", { ...HERE, number: 1 }, () => ({ error: enoent, status: null })),
    { ok: false, error: "gh-missing" });

  const failed = lookupPullRequest("/tmp", { ...HERE, number: 1 },
    () => ({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\nmore\n" }));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "gh-failed");
  assert.equal(failed.detail, "gh: Not Found (HTTP 404)", "the first line of gh's own complaint");

  const garbled = lookupPullRequest("/tmp", { ...HERE, number: 1 }, answer("not json"));
  assert.deepEqual(garbled, { ok: false, error: "gh-failed", detail: "unreadable answer" });
  const empty = lookupPullRequest("/tmp", { ...HERE, number: 1 }, answer(JSON.stringify({ title: "x" })));
  assert.deepEqual(empty, { ok: false, error: "gh-failed", detail: "no branch names in the answer" });
});

test("a branch name is resolved to whichever side of it this repository actually has", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-prrefs-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-qb", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", head);
    git("branch", "feature/mine");

    // The base takes the remote-tracking ref when there is one: the pull request is measured against what
    // is on the server, and a local `main` left behind would answer a different question without saying so.
    assert.equal(localRevisionFor(root, "main", "remote"), "origin/main");
    // The head takes the local branch: a reader reading their own pull request is usually sitting on it.
    assert.equal(localRevisionFor(root, "feature/mine", "local"), "feature/mine");
    // And a branch this repository has never seen is not invented — the caller reports it instead of fetching.
    assert.equal(localRevisionFor(root, "someone-elses-branch", "local"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
