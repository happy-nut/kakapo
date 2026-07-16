import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGitLog } from "../dist/git-log.js";

let root;

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commitFile(name, content, message) {
  writeFileSync(join(root, name), content);
  git("add", name);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-git-graph-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Graph Reviewer");
  git("config", "user.email", "graph@example.test");
  commitFile("shared.txt", "root\n", "root");

  git("switch", "-q", "-c", "topic");
  const topic = commitFile("topic.txt", "topic\n", "topic only");
  git("update-ref", "refs/remotes/origin/topic", topic);

  git("switch", "-q", "main");
  commitFile("main.txt", "main\n", "main only");
  git("merge", "-q", "--no-ff", "topic", "-m", "merge topic");
  git("tag", "v2.0");

  git("switch", "-q", "-c", "unmerged");
  commitFile("unmerged.txt", "side\n", "unmerged branch");
  git("switch", "-q", "main");
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("repository history includes all refs in topological order with stable decorations", () => {
  const commits = readGitLog(root, { limit: 100 });
  const subjects = commits.map((commit) => commit.subject);
  assert.ok(subjects.includes("unmerged branch"), "a commit reachable only from another local branch is visible");
  assert.ok(subjects.includes("topic only"), "a remote-decorated branch is visible");

  const merge = commits.find((commit) => commit.subject === "merge topic");
  assert.equal(merge.parents.length, 2, "merge parent topology reaches the renderer");
  assert.match(merge.refs, /tag: refs\/tags\/v2\.0/);
  assert.match(commits.find((commit) => commit.subject === "unmerged branch").refs, /unmerged/);
  assert.match(commits.find((commit) => commit.subject === "topic only").refs, /origin\/topic/);

  const index = new Map(commits.map((commit, position) => [commit.hash, position]));
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (index.has(parent)) assert.ok(index.get(commit.hash) < index.get(parent), "children precede visible parents in topological order");
    }
  }
});
