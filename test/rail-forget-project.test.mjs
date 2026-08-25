// A workspace you close is not a workspace you are rid of.
//
// The rail's pinned tiles come from knownProjectRoots(), which reads the recent-projects list. Closing a
// workspace removes it from kakapo-open-workspaces and leaves it in that list, so the next launch rebuilds it
// as a closed tile — and a closed tile is kind "main", which is never offered Delete, and used to get no
// context menu at all (`if (card.dataset.closed === 'true') return`). Closing it again did nothing. Forever.
//
// Observed: repositories added by the MCP spawn bug were closed, confirmed gone from kakapo-open-workspaces,
// and were back in the rail after a restart, still with no way to remove them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tileMenuHtml } from "../dist/shell-pages.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const actions = (html) => [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]);
const t = (key) => key;

test("a closed project tile offers the two things it can actually honour", () => {
  const closed = actions(tileMenuHtml(false, false, false, t, true));
  assert.deepEqual(closed, ["open", "forget"]);
  // Its id is a synthetic negative, so every workspace action would act on nothing — that is why the menu is
  // not simply the ordinary one with extra items.
  for (const action of ["activate", "rename", "memo", "detach", "close", "delete"]) {
    assert.ok(!closed.includes(action), `${action} cannot work on a tile with no window`);
  }
});

test("an open workspace's menu is unchanged", () => {
  assert.deepEqual(actions(tileMenuHtml(true, true, false, t, false)),
    ["activate", "resume", "rename", "memo", "detach", "close", "delete"]);
  // …and a main checkout still cannot be deleted, only closed.
  assert.ok(!actions(tileMenuHtml(false, false, false, t, false)).includes("delete"));
});

test("removing from the rail forgets the project, which is the only thing that makes it stay gone", () => {
  const main = read("src/app-main.ts");
  const handler = main.match(/ipcMain\.on\("kakapo:hub-forget"[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler, "one handler removes a project from the rail");
  assert.match(handler, /preferences\.forgetRecentProject\(path\)/, "it forgets the project…");
  assert.match(handler, /hubMainTilesCache = undefined/, "…invalidates the pinned-tile cache…");
  assert.match(handler, /renderHub\(\)/, "…and repaints, so the tile goes now rather than next launch");

  const shell = read("src/shell-pages.ts");
  assert.match(shell, /if\(action==='forget'\)\{window\.kakapoHub\.forgetProject\(d\.path\|\|''\)/, "the menu action reaches it");
  assert.match(read("src/hub-preload.cts"), /forgetProject: \(path: string\) => ipcRenderer\.send\("kakapo:hub-forget", path\)/,
    "and the bridge exposes it");

  // The right-click must reach a closed tile at all — this is the line that used to swallow it.
  const ctx = shell.split("\n").find((l) => l.includes("addEventListener('contextmenu'"));
  assert.ok(ctx, "the rail has a context-menu handler");
  assert.ok(!ctx.includes("if(card.dataset.closed==='true')return"), "a closed tile is no longer skipped");
  assert.match(ctx, /closed:card\.dataset\.closed==='true'/, "and the menu is told which kind of tile it is");
  assert.match(ctx, /path:decodeURIComponent\(card\.dataset\.path\|\|''\)/, "with the path the action needs");
});
