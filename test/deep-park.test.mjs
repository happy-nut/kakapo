// A hidden-but-alive workspace view keeps ~70 MB of GPU IOSurfaces (they survive setVisible(false) AND
// removeChildView — measured, only destroying the webContents returns them) plus a 100-340 MB renderer.
// Deep park closes the view of a workspace hidden 2h with nothing running, keeps it on the rail as a
// `closed` tile (the ride a closed main checkout already takes: click -> kakapo:hub-open -> reopen by
// path), and keeps it in the restore session. The chain worth pinning is the safety conditions and the
// three integration points — tile, restore, un-park.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appMain = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");

test("only a genuinely idle, long-hidden, attached workspace is parked", () => {
  const park = appMain.match(/function parkLongHidden[\s\S]*?\n\}/)?.[0];
  assert.ok(park, "parkLongHidden exists");
  assert.match(park, /isDetached\(\)/, "a detached window is its own surface — never parked");
  assert.match(park, /activeStateId/, "the active workspace — where a switch would land — is never parked");
  assert.match(park, /state\.busy \|\| state\.unread \|\| state\.asking\.length/,
    "output arriving, an unread answer, or a question in flight all block the park");
  assert.match(park, /pane\.running \|\| pane\.busy/, "so does a foreground process in any pane");
  assert.match(park, /PARK_AFTER_MS/, "and nothing parks before the deadline");
  assert.match(park, /webContents\.close\(\)/, "the park IS destroying the webContents — the only thing that returns the GPU memory");
});

test("a parked workspace stays a tile, stays in the restore session, and un-parks on reopen", () => {
  assert.match(appMain, /parkedWorkspaces\.values\(\)[\s\S]{0,400}?closed: true/,
    "renderHub paints a closed tile for it — click reopens by path like a closed main");
  assert.match(appMain, /Deep-parked workspaces are closed views, not closed workspaces/,
    "persistWorkspaceSession keeps it in the next launch's restore");
  assert.match(appMain, /parkedWorkspaces\.delete\(canonicalRoot\)/,
    "openOrFocusWorkspace un-parks, so the closed tile never shadows a live one");
  assert.match(appMain, /state\.hiddenAt = undefined;\s*\n\s*else state\.hiddenAt \?\?= Date\.now\(\)/,
    "the park clock starts when the workspace leaves the screen and resets when it returns");
  assert.match(appMain, /setInterval\(\(\) => \{ watchLspWeight\(\); parkLongHidden\(\); \}, LSP_WATCHDOG_MS\)/,
    "and the sweep is actually armed");
});

test("the ⌘K quick-switcher reopens a parked workspace by path", () => {
  const preload = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
  const views = readFileSync(new URL("../src/viewer/09-views-update.js", import.meta.url), "utf8");
  assert.match(preload, /openWorkspacePath: \(path: string\): void => ipcRenderer\.send\("kakapo:hub-open", path\)/,
    "the bridge sends the path to the same validated hub-open the rail's closed tiles use");
  assert.match(views, /if \(w\.closed && w\.path && typeof bridge\.openWorkspacePath === 'function'\) \{ bridge\.openWorkspacePath\(w\.path\); return; \}/,
    "a closed item routes by path instead of a dead negative id");
});
