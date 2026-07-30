// Diff-first startup: the first paint indexes only the changed files, and the FULL project index is
// materialized on demand the first time the renderer pulls it. These pin the main-process IPC wiring —
// that get-project-index and get-source trigger ensureFullIndex — without a running window. The build-side
// behavior (deferFullIndex gating, collectReviewSourceIndex spanning the tree) is covered in build-lazy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerReviewIpc } from "../dist/app-review-ipc.js";

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
