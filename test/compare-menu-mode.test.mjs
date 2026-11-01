// Which row the compare menu ticks, derived rather than remembered.
//
// The menu offers two rows — all changes against a branch, and uncommitted — and the review can be in a
// state neither describes: a ⌘9 range, a patch-set pick. Those must tick NOTHING, because a tick on the
// wrong row is a confident answer to the one question a reader opens this menu to ask.
//
// Getting that right broke the commonest launch of all. `kakapo --base main`, which the READMEs document
// as the way to review a feature branch, arrives with an explicit base and — alone among the writers —
// no `baseLabel`, so "an explicit base nobody labelled" read it as a patch-set pick: no tick, and the
// "main 대비" subtitle gone, on exactly the state that row describes.
//
// Driven through the real handler because the derivation is the thing under test, and a test that asserted
// against a hand-built state would agree with whatever the derivation happened to be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReviewIpc } from "../dist/app-review-ipc.js";

function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
  };
}

function harness(options) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kakapo-cmp-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-qb", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  const ipc = fakeIpc();
  const state = {
    options: { root, staged: false, ...options },
    sourceFiles: new Map(), bodyDiffs: [], bodyCache: new Map(), analysis: {}, perf: { mark() {} },
  };
  registerReviewIpc(ipc, () => state);
  return { root, ipc, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const modeOf = async (options, extra) => {
  const h = harness(options);
  try {
    Object.assign(h.state, extra || {});
    return (await h.ipc.invoke("kakapo:compare-menu")).mode;
  } finally { h.cleanup(); }
};

test("the menu ticks the row the review is actually in", async () => {
  const sha = "0000000000000000000000000000000000000001";

  // What the CLI produces. `base` is resolved, and `baseLabel` is the ref the reader typed — the launch
  // this app is mostly used through, and the one the regression hid.
  assert.equal(await modeOf({ base: sha, baseLabel: "main" }), "all",
    "`kakapo --base main` is all-changes-against-a-branch, which is what that row says");
  assert.equal(await modeOf({ base: undefined }, { reviewBase: sha }), "all",
    "and so is an automatically resolved base");

  assert.equal(await modeOf({ base: "HEAD" }), "uncommitted");
  assert.equal(await modeOf({ staged: true }), "uncommitted");

  // A patch-set pick: an explicit base that no branch name stands behind. set-review-base clears the
  // label for exactly this reason, so its absence is the signal — and the signal is only trustworthy
  // because every other writer sets it.
  assert.equal(await modeOf({ base: sha }), "other",
    "a commit picked from the patch-set bar is not either row");
  assert.equal(await modeOf({ base: sha, baseLabel: "main" }, { compareScope: [{ sha }] }), "other",
    "and neither is a ⌘9 range");
  assert.equal(await modeOf({ base: sha, baseLabel: "main", target: sha }), "other",
    "nor an A→B compare with a revision on the right");
});
