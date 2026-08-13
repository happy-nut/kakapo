// Diff-first startup: the first paint indexes only the changed files, and the FULL project index is
// materialized on demand the first time the renderer pulls it. These pin the main-process IPC wiring —
// that get-project-index and get-source trigger ensureFullIndex — without a running window. The build-side
// behavior (deferFullIndex gating, collectReviewSourceIndex spanning the tree) is covered in build-lazy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerReviewIpc } from "../dist/app-review-ipc.js";
import { readUnifiedDiff, parseUnifiedDiff } from "../dist/diff.js";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal stand-in for Electron's ipcMain: capture each handler so a test can invoke it directly.
function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn), // fire-and-forget channels (e.g. perf-mark); unused here
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
  };
}

function baseState(overrides) {
  return {
    options: { root: "/tmp/kakapo-diff-first", staged: false },
    signature: "sig-first-paint",
    bodyDiffs: [],
    bodyCache: new Map(),
    sourceFiles: new Map(),
    analysis: {},
    perf: { mark() {} },
    fullIndexPending: true,
    ...overrides,
  };
}

test("get-project-index materializes the deferred full index before returning it", async () => {
  const ipc = fakeIpc();
  let ensured = 0;
  const state = baseState({
    sourceFiles: new Map([["src/a.ts", { path: "src/a.ts", changed: true, content: "", size: 1, signature: "a", embedded: true }]]),
  });
  state.ensureFullIndex = async () => {
    ensured += 1;
    // Simulate the on-demand full build (worker) adding the unchanged sibling the first paint omitted.
    state.sourceFiles.set("src/b.ts", { path: "src/b.ts", changed: false, content: "", size: 1, signature: "b", embedded: true });
    state.fullIndexPending = false;
  };
  registerReviewIpc(ipc, () => state);

  const result = await ipc.invoke("kakapo:get-project-index");
  assert.equal(ensured, 1, "the handler triggered the on-demand full-index build");
  assert.deepEqual(
    result.sourceFilesMeta.map((f) => f.path).sort(),
    ["src/a.ts", "src/b.ts"],
    "the returned index includes the newly-materialized unchanged file",
  );
  // The pulled signature must stay the first-paint value the renderer holds (installProjectIndex's guard).
  assert.equal(result.signature, "sig-first-paint", "the pull keeps the first-paint signature");
});

test("get-source falls back to the full index for a path outside the changed set", async () => {
  const ipc = fakeIpc();
  let ensured = 0;
  const state = baseState({ sourceFiles: new Map() }); // changed-only index lacks the requested file
  state.ensureFullIndex = async () => {
    ensured += 1;
    state.sourceFiles.set("src/b.ts", { path: "src/b.ts", changed: false, deferred: false, content: "hi", size: 2, signature: "b", embedded: true });
    state.fullIndexPending = false;
  };
  registerReviewIpc(ipc, () => state);

  const result = await ipc.invoke("kakapo:get-source", { path: "src/b.ts" });
  assert.equal(ensured, 1, "the miss triggered the on-demand full-index build");
  assert.ok(result && result.path === "src/b.ts", "get-source resolved the file after materializing the full index");
});

test("get-source does not build the full index when the changed set already has the file", async () => {
  const ipc = fakeIpc();
  let ensured = 0;
  const state = baseState({
    sourceFiles: new Map([["src/a.ts", { path: "src/a.ts", changed: true, deferred: false, content: "x", size: 1, signature: "a", embedded: true }]]),
  });
  state.ensureFullIndex = async () => { ensured += 1; };
  registerReviewIpc(ipc, () => state);

  const result = await ipc.invoke("kakapo:get-source", { path: "src/a.ts" });
  assert.equal(ensured, 0, "a changed file resolves without the full-index pass");
  assert.equal(result.path, "src/a.ts");
});

// A symlink is a change in its own right, and statSync FOLLOWS it — so an untracked link whose target is
// missing (or lives outside the worktree) threw and the entry was dropped without a trace: git listed it as
// untracked while kakapo said "no changed files", with nothing to explain the disagreement. Git stores a
// symlink as a blob holding its target, so that is what the diff shows.
test("an untracked symlink shows up, even when its target is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-symlink-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "tracked.txt"), "hello\n");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);

    mkdirSync(join(root, "links"), { recursive: true });
    symlinkSync("../does/not/exist.md", join(root, "links", "broken.md"));
    symlinkSync("../tracked.txt", join(root, "links", "good.md"));

    const files = parseUnifiedDiff(readUnifiedDiff({ staged: false, context: 12, includeUntracked: true, root }));
    const paths = files.map((f) => f.displayPath).sort();
    assert.deepEqual(paths, ["links/broken.md", "links/good.md"], "both links are reported, broken or not");

    const broken = files.find((f) => f.displayPath === "links/broken.md");
    assert.equal(broken.status, "added");
    const line = broken.hunks[0].lines.map((l) => l.text).join("");
    assert.match(line, /does\/not\/exist\.md/, "the diff shows what the link points at, the way git stores it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
