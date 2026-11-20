import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePullRequestRef, lookupPullRequest, remoteSlug, localRevisionFor, pullRequestRemote, pullRequestRefPrefix, fetchPullRequest } from "../dist/github-pr.js";

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
      try { git("remote", "remove", "origin"); } catch { }
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

    assert.equal(localRevisionFor(root, "main", "remote"), "origin/main");
    assert.equal(localRevisionFor(root, "feature/mine", "local"), "feature/mine");
    assert.equal(localRevisionFor(root, "someone-elses-branch", "local"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function gitIn(dir) {
  return (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
}

function pullRequestWorld() {
  const home = mkdtempSync(join(tmpdir(), "kakapo-pr-world-"));
  const origin = join(home, "acme", "widgets.git");
  mkdirSync(join(home, "acme"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });

  const author = join(home, "author");
  execFileSync("git", ["clone", "-q", origin, author], { stdio: "pipe" });
  const git = gitIn(author);
  git("config", "user.email", "test@kakapo.local");
  git("config", "user.name", "kakapo test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(author, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-qm", "the commit the pull request was cut from");
  const cutFrom = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  git("checkout", "-qb", "feature");
  writeFileSync(join(author, "b.txt"), "two\n");
  git("add", "-A"); git("commit", "-qm", "what the pull request changes");
  const head = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/pull/7/head");

  git("checkout", "-q", "main");
  writeFileSync(join(author, "c.txt"), "three\n");
  git("add", "-A"); git("commit", "-qm", "what landed on main afterwards");
  const baseTip = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  const reader = join(home, "reader");
  execFileSync("git", ["clone", "-q", origin, reader], { stdio: "pipe" });
  return { home, reader, cutFrom, head, baseTip };
}

test("a pull request is fetched into the reader's checkout, merge base and all", async () => {
  const world = pullRequestWorld();
  try {
    const ref = { owner: "acme", repo: "widgets", number: 7 };
    assert.equal(pullRequestRemote(world.reader, ref), "origin",
      "the checkout already points at that repository, so its own remote is the one to ask");

    const got = await fetchPullRequest(world.reader, ref, { base: "main", head: "feature", title: "" });
    assert.equal(got.ok, true, got.ok ? "" : `${got.error} ${got.detail || ""}`);
    assert.equal(got.head, world.head, "refs/pull/<n>/head is the tip, and no branch of that name exists here");
    assert.equal(got.base, world.cutFrom,
      "the base is the merge base, so what landed on main after the pull request was cut is on neither side");
    assert.notEqual(got.base, world.baseTip);

    const prefix = pullRequestRefPrefix(ref);
    const read = gitIn(world.reader);
    assert.equal(read("rev-parse", `${prefix}/head`), world.head,
      "the commits stay reachable through a ref of our own, so a rebuild and a gc do not lose them");
    assert.equal(read("branch", "--list"), "* main",
      "the fetched commits show up in no branch list, and nothing was checked out");
  } finally {
    rmSync(world.home, { recursive: true, force: true });
  }
});

test("a fork's pull request needs no branch here, and a hostile owner reaches no command line", async () => {
  const world = pullRequestWorld();
  try {
    const has = (ref) => {
      try { gitIn(world.reader)("rev-parse", "--verify", ref); return true; } catch { return false; }
    };
    assert.equal(has("refs/heads/feature"), false,
      "this is the case a reader cannot resolve by hand: a pull request from a fork has no branch here");
    assert.equal(has("refs/remotes/origin/feature"), false, "and no remote-tracking branch either");

    assert.equal(pullRequestRemote(world.reader, { owner: "other", repo: "widgets", number: 7 }),
      "https://github.com/other/widgets.git", "a pull request somewhere else is fetched from there");
    for (const owner of ["--upload-pack=touch /tmp/pwned", "-o", "a/b", ""]) {
      assert.equal(pullRequestRemote(world.reader, { owner, repo: "widgets", number: 7 }), undefined,
        "git reads a leading dash as an option, and this name came out of pasted text");
    }
    const refused = await fetchPullRequest(world.reader, { owner: "acme", repo: "widgets", number: 7 },
      { base: "main; touch /tmp/pwned", head: "feature", title: "" });
    assert.deepEqual(refused, { ok: false, error: "pr-remote-unreadable" });
  } finally {
    rmSync(world.home, { recursive: true, force: true });
  }
});
