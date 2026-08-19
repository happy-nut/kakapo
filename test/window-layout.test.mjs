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
  const keymap = readFileSync(new URL("../src/viewer/05-keymap.js", import.meta.url), "utf8");

  assert.match(main, /ipcMain\.on\("kakapo:review-clicked"[\s\S]{0,220}collapseRailFromReview\(\)/,
    "main collapses the rail on the renderer's click report");
  assert.doesNotMatch(main, /on\("focus",[\s\S]{0,160}collapseRailFromReview/,
    "and no longer collapses on the view merely taking focus");
  // WHICH bridge, not just the name. This guard used to check for the name alone, and the call site was
  // spelled window.kakapoApp.reviewClicked() while the function lived on kakapoMenu — so the typeof guard
  // around it turned a wrong receiver into silence, and clicking the review dismissed nothing for as long as
  // that stood. A name is not a wiring check.
  const bridgeOf = (name) => {
    const at = preload.indexOf(`exposeInMainWorld("${name}"`);
    return at < 0 ? "" : preload.slice(at, preload.indexOf("\n});", at));
  };
  assert.match(bridgeOf("kakapoMenu"), /railStandDown[\s\S]{0,200}kakapo:review-clicked/, "the menu bridge exposes it");
  for (const [file, where] of [[core, "a content click"], [keymap, "⌘0 / ⌘1"]]) {
    assert.match(file, /window\.kakapoMenu\.railStandDown\(\)/, `${where} asks the bridge that defines it`);
    assert.doesNotMatch(file, /window\.kakapoApp\.railStandDown/, `${where} does not ask a bridge that does not`);
  }
  assert.match(core, /closest\('\.terminal-panel'\)[\s\S]{0,320}railStandDown\(\)/,
    "the renderer reports content clicks only — a click in the terminal is exempt");
  // The rail force-collapses the in-view tree while it is open, so a shortcut meaning "take me to that tree"
  // has to put the rail away first or it moves nothing at all.
  assert.match(keymap, /function standDownRailForViewSwitch[\s\S]{0,300}railPushedCollapse/,
    "and it only asks while the rail is actually holding the tree shut");
  for (const view of ["activateChangesView", "activateFilesView"]) {
    assert.match(keymap, new RegExp(`function ${view}\\([^)]*\\) \\{[\\s\\S]{0,200}standDownRailForViewSwitch\\(\\)`),
      `${view} stands the rail down before it tries to reveal anything`);
  }
});

// Choosing a workspace from the expanded rail — a click or Enter on a tile — is the rail's whole purpose, so
// it collapses once the choice is made. This is deliberately NOT the same trigger as the review view taking
// focus: that one has to leave the rail alone, or clicking into a terminal pane would dismiss it.
test("picking a workspace from the rail collapses it", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  for (const channel of ["kakapo:hub-activate", "kakapo:hub-activate-index", "kakapo:hub-open"]) {
    const handler = main.slice(main.indexOf(`ipcMain.on("${channel}"`));
    assert.match(handler.slice(0, 420), /collapseRailFromReview\(\)/, `${channel} collapses the rail`);
  }
});
