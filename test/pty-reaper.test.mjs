// CORE USER FLOW: quitting the app must not pop a macOS crash dialog.
//
// Kakapo crashed on quit (three SIGABRT reports, all the same stack): a pty is killed as its window tears
// down, node-pty reaps it on a native thread and delivers the exit through N-API, and if that lands after
// Electron has begun tearing the Node environment down (node::FreeEnvironment -> uv_run) the call fails and
// the addon escalates it into an uncatchable C++ throw. The reaper makes quit wait for those deliveries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtyReaper } from "../dist/util.js";

const fakePty = () => { const p = { killed: false, kill() { p.killed = true; } }; return p; };

test("drain resolves only once every killed pty has reported its exit", async () => {
  const reaper = createPtyReaper();
  const slow = fakePty();
  const fast = fakePty();
  reaper.kill(slow);
  reaper.kill(fast);
  assert.equal(slow.killed && fast.killed, true, "kill still kills");

  let done = false;
  const drained = reaper.drain(1000).then((clean) => { done = clean; });
  reaper.settle(fast);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(done, false, "still waiting on the pty that hasn't reported");
  reaper.settle(slow);
  await drained;
  assert.equal(done, true, "drained cleanly");
});

test("drain gives up rather than hanging quit on a wedged pty", async () => {
  const reaper = createPtyReaper();
  reaper.kill(fakePty()); // never settles
  const started = Date.now();
  assert.equal(await reaper.drain(120), false, "reports the timeout");
  assert.ok(Date.now() - started >= 100, "waited for the cap before quitting anyway");
  assert.equal(await reaper.drain(120), true, "a wedged pty doesn't stall the next drain");
});

test("a pty that already exited is not waited for", async () => {
  const reaper = createPtyReaper();
  reaper.kill({ kill() { throw new Error("ESRCH"); } });
  assert.equal(await reaper.drain(5000), true, "resolves immediately, no pending delivery to wait for");
});
