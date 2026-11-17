import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
    { path: "docs/readme.md", before: "# one\n", after: "# two\n" },
  ]));
});
after(cleanupFixtures);

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function instrument(window) {
  const listeners = new Map();
  const key = (target, type, fn, options) => {
    const capture = typeof options === "object" && options !== null ? !!options.capture : !!options;
    return [target === window ? "window" : "document", type, capture].join("|");
  };
  const handlers = new Map();

  for (const target of [window.document, window]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = function (type, fn, options) {
      const k = key(target, type, fn, options);
      if (!handlers.has(k)) handlers.set(k, new Set());
      handlers.get(k).add(fn);
      listeners.set(k, handlers.get(k).size);
      return add(type, fn, options);
    };
    target.removeEventListener = function (type, fn, options) {
      const k = key(target, type, fn, options);
      const set = handlers.get(k);
      if (set) { set.delete(fn); listeners.set(k, set.size); }
      return remove(type, fn, options);
    };
  }

  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  const liveIntervals = new Set();
  window.setInterval = function (...args) { const id = setInterval(...args); liveIntervals.add(id); return id; };
  window.clearInterval = function (id) { liveIntervals.delete(id); return clearInterval(id); };

  return () => ({
    listeners: [...listeners.values()].reduce((sum, n) => sum + n, 0),
    intervals: liveIntervals.size,
    nodes: window.document.querySelectorAll("*").length,
  });
}

const PAIRS = [
  { name: "Quick Open (files)", open: (w) => w.openQuickOpen("file"), close: (w) => w.closeQuickOpen() },
  { name: "Quick Open (symbols)", open: (w) => w.openQuickOpen("symbol"), close: (w) => w.closeQuickOpen() },
  { name: "Find in Files", open: (w) => w.openFileFind(), close: (w) => w.closeFileFind() },
  { name: "Find Action", open: (w) => w.openFindAction(), close: (w) => w.closeQuickOpen() },
  { name: "Problems", open: (w) => w.openProblemsView(), close: (w) => w.closeQuickOpen() },
  { name: "Recent Locations", open: (w) => w.openRecentLocations(), close: (w) => w.closeQuickOpen() },
  { name: "Bookmarks", open: (w) => w.openBookmarks(), close: (w) => w.closeQuickOpen() },
  { name: "File Structure", open: (w) => w.openFileStructure(), close: (w) => w.closeQuickOpen() },
  { name: "Compare menu", open: (w) => w.openCompareMenu(), close: (w) => w.closeCompareMenu() },
  { name: "History", open: (w) => w.openHistory(), close: (w) => w.closeHistory() },
  {
    name: "custom dropdown",
    open: (w) => {
      const trigger = w.document.querySelector("button");
      w.showCustomDropdown(10, 10, [{ label: "one", onPick() {} }, { label: "two", onPick() {} }],
        false, undefined, trigger);
    },
    close: (w) => {
      const dd = w.document.querySelector(".custom-dropdown, .source-tab-overflow-menu, [role=menu]");
      if (dd) w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    },
  },
];

const WARMUP = 1;
const CYCLES = 5;

for (const pair of PAIRS) {
  test(`${pair.name} leaves nothing behind when it closes`, async () => {
    const v = await loadViewer(html);
    try {
      await v.until(() => !v.window.document.getElementById("boot-overlay"));
      assert.equal(v.window.document.getElementById("boot-overlay"), null,
        "the boot overlay is down before the first count — otherwise its three nodes land on this overlay");

      const read = instrument(v.window);

      let opened = false;
      for (let i = 0; i < WARMUP; i += 1) {
        try { pair.open(v.window); opened = true; } catch { }
        await tick();
        try { pair.close(v.window); } catch { }
        await tick();
      }
      assert.ok(opened, "the overlay opened at all");

      const before = read();
      for (let i = 0; i < CYCLES; i += 1) {
        try { pair.open(v.window); } catch { }
        await tick();
        try { pair.close(v.window); } catch { }
        await tick();
      }
      const after = read();

      const moved = ["listeners", "intervals", "nodes"]
        .filter((k) => after[k] !== before[k])
        .map((k) => `${k} ${before[k]}\u2192${after[k]} (${after[k] - before[k] > 0 ? "+" : ""}${after[k] - before[k]} over ${CYCLES} cycles)`);
      assert.deepEqual(moved, [], "the overlay accumulates or destroys something on every open");
    } finally {
      v.close();
    }
  });
}
