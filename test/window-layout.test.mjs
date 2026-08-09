import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { installWindowSurfaceRecovery } from "../dist/window-layout.js";

test("window surface recovery coalesces resize and maximize repaint requests", async () => {
  class FakeWindow extends EventEmitter {
    destroyed = false;
    invalidations = 0;
    webContents = {
      isDestroyed: () => this.destroyed,
      invalidate: () => { this.invalidations += 1; },
    };
    isDestroyed() { return this.destroyed; }
  }
  const window = new FakeWindow();
  const dispose = installWindowSurfaceRecovery(window, 8);
  window.emit("resize");
  window.emit("resize");
  window.emit("maximize");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(window.invalidations, 1, "one final repaint covers the enlarged native surface");

  window.emit("unmaximize");
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(window.invalidations, 1, "teardown cancels a pending repaint");
});

// The expanded workspace rail is a transient peek that a click back into the review dismisses. Main used to
// infer that click from the view's `focus` event — but the terminal panel lives INSIDE the review view, so
// clicking into a shell (which SHOULD take focus) also closed the rail the user had just opened. The click
// target is only knowable in the renderer, so the renderer reports it and exempts the terminal.
test("only a click in the review content dismisses the expanded rail — not one in the terminal", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");

  assert.match(main, /ipcMain\.on\("kakapo:review-clicked"[\s\S]{0,220}collapseRailFromReview\(\)/,
    "main collapses the rail on the renderer's click report");
  assert.doesNotMatch(main, /on\("focus",[\s\S]{0,160}collapseRailFromReview/,
    "and no longer collapses on the view merely taking focus");
  assert.match(preload, /reviewClicked[\s\S]{0,120}kakapo:review-clicked/, "the bridge exposes it");
  assert.match(core, /closest\('\.terminal-panel'\)[\s\S]{0,260}reviewClicked\(\)/,
    "the renderer reports content clicks only — a click in the terminal is exempt");
});
