// `kakapo:existing-project-paths` is how the renderer decides a commented-on file is gone, and a `false`
// there DELETES the comment and saves it away. So the question has to be asked of the review's right side.
//
// When that side is a revision — an A→B compare, or a clean checkout behind its upstream, where the review is
// "what the remote has and you don't" — a file added on that side does not exist in the working tree and
// still reads perfectly well, because collectSourceFiles serves it from the blob. Answering from existsSync
// alone deleted every comment on such a file the first time the comments dock was opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProjectPathIpc } from "../dist/app-path-ipc.js";

const noShell = { showItemInFolder() {}, openExternal() {}, openPath() {} };

// A repo whose HEAD~1 is the working tree's state and whose HEAD adds `only-upstream.ts` — the shape of
// reviewing an upstream commit the checkout has not merged.
function repoBehindUpstream() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-target-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "here.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(root, "only-upstream.ts"), "export const b = 2;\n");
  git("add", "-A");
  git("commit", "-qm", "upstream adds a file");
  const upstream = git("rev-parse", "HEAD");
  git("reset", "-q", "--hard", "HEAD~1"); // the working tree no longer has only-upstream.ts

  // `ask` builds the handler against a state with whatever right side the test is about.
  const ask = (paths, reviewTarget) => {
    const handlers = new Map();
    const ipc = { handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => handlers.set(channel, fn) };
    registerProjectPathIpc(ipc, noShell, () => ({ options: { root }, reviewTarget }));
    return handlers.get("kakapo:existing-project-paths")({}, { paths });
  };
  return { root, upstream, ask, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a file added in the review's target revision counts as present", () => {
  const r = repoBehindUpstream();
  try {
    const answer = r.ask(["here.ts", "only-upstream.ts", "never.ts"], r.upstream);
    assert.equal(answer["here.ts"], true, "a file in the working tree is present");
    assert.equal(answer["only-upstream.ts"], true, "and so is one the reviewed revision adds");
    assert.equal(answer["never.ts"], false, "a file in neither place is genuinely gone");
  } finally {
    r.cleanup();
  }
});

test("with the working tree as the right side, the working tree is the whole answer", () => {
  const r = repoBehindUpstream();
  try {
    for (const target of ["worktree", undefined]) {
      const answer = r.ask(["here.ts", "only-upstream.ts"], target);
      assert.equal(answer["here.ts"], true);
      assert.equal(answer["only-upstream.ts"], false, `target=${target}: nothing claims this file is here`);
    }
  } finally {
    r.cleanup();
  }
});

test("a genuinely deleted file is still reported missing, so the prune keeps working", () => {
  const r = repoBehindUpstream();
  try {
    unlinkSync(join(r.root, "here.ts"));
    assert.equal(r.ask(["here.ts"], "worktree")["here.ts"], false);
    // Even with a revision as the right side: the file is in neither the tree nor that commit… except it IS
    // in that commit, so this asserts the opposite — which is the point. A comment on it is still valid.
    assert.equal(r.ask(["here.ts"], r.upstream)["here.ts"], true, "deleted locally but present in the reviewed revision");
  } finally {
    r.cleanup();
  }
});

test("a path escaping the root is never reported present", () => {
  const r = repoBehindUpstream();
  try {
    for (const target of ["worktree", r.upstream]) {
      const answer = r.ask(["../../../etc/passwd", "/etc/passwd"], target);
      assert.equal(answer["../../../etc/passwd"], false);
      assert.equal(answer["/etc/passwd"], false);
    }
  } finally {
    r.cleanup();
  }
});

test("a ref that does not resolve answers no rather than throwing", () => {
  const r = repoBehindUpstream();
  try {
    assert.equal(r.ask(["only-upstream.ts"], "refs/heads/does-not-exist")["only-upstream.ts"], false);
  } finally {
    r.cleanup();
  }
});
