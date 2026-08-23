// Unit coverage for the rail easing pulled out of app-main. It was a pure function trapped in the Electron
// orchestrator (no test seam); pin its contract — endpoints, monotonicity, and the ease-out shape that keeps
// the rail push in lockstep with the CSS transition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cubicBezierEase, easeRail } from "../dist/rail-animation.js";

test("easeRail pins the endpoints exactly", () => {
  assert.equal(easeRail(0), 0);
  assert.ok(Math.abs(easeRail(1) - 1) < 1e-9, `easeRail(1) ~= 1 (got ${easeRail(1)})`);
});

test("easeRail is monotonic non-decreasing across the range", () => {
  let prev = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const y = easeRail(i / 20);
    assert.ok(y >= prev - 1e-9, `non-decreasing at p=${i / 20} (got ${y}, prev ${prev})`);
    prev = y;
  }
});

test("easeRail eases OUT — past its midpoint well before halfway", () => {
  // cubic-bezier(.2,.8,.2,1) front-loads: at p=0.5 the eased value is already well above 0.5.
  assert.ok(easeRail(0.5) > 0.75, `fast start (got ${easeRail(0.5)})`);
});

test("cubicBezierEase(0,0,1,1) is the identity (linear)", () => {
  const linear = cubicBezierEase(0, 0, 1, 1);
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(linear(p) - p) < 1e-6, `linear(${p}) ~= ${p} (got ${linear(p)})`);
  }
});

// `x` is the rail's width, so every frame of the expand/collapse re-bound every workspace view — and a view
// resize is a full relayout in that renderer. On a big review (1,352 file wrappers, ~17k nodes) twelve frames
// times N workspaces is seconds of work: the animation drops frames, the review lags behind the rail, and the
// terminal panel inside it appears to sit ON the expanded rail because its view has not moved yet.
test("only the view being looked at follows the rail animation", () => {
  const src = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const layout = src.match(/function layoutWorkspaceViews\([\s\S]*?\n\}/)?.[0];
  assert.ok(layout, "layoutWorkspaceViews exists");
  assert.match(layout, /options\?: \{ activeOnly\?: boolean \}/, "it can be asked for the active view alone");
  assert.match(layout, /if \(options\?\.activeOnly && state\.win\.webContents\.id !== activeStateId\) continue/,
    "and that is what skips the hidden ones");

  const animate = src.match(/function animateHubWidth\([\s\S]*?\n\}/)?.[0];
  assert.ok(animate, "animateHubWidth exists");
  assert.match(animate, /hubWidth = target;\s*\n\s*layoutWorkspaceViews\(\);/,
    "hidden views take the final width once, before the slide starts");
  assert.match(animate, /layoutWorkspaceViews\(\{ activeOnly: true \}\)/, "the per-frame pass is the active view only");
  assert.match(animate, /clearInterval\(hubAnimTimer\);\s*\n\s*hubAnimTimer = undefined;\s*\n\s*layoutWorkspaceViews\(\);/,
    "and one settled pass at the end, so nothing keeps a mid-animation width");
});
