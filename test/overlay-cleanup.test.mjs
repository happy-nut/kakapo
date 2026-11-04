// What an overlay leaves behind when it closes.
//
// The sibling guard (overlay-focus-return.test.mjs) asks whether a closing overlay hands the keyboard
// back. This one asks the question that only shows up over time: does it hand back everything ELSE —
// the document listeners it installed, the intervals it started, the nodes it appended.
//
// A single reading cannot answer that. One listener too many is invisible; the same listener installed on
// every open is a reader's session getting slower all afternoon, and then a window that will not let go.
// This repo has already paid for that once: test/helpers/dom.mjs carries the note that ONE unclosed jsdom
// window held the viewer's 6-hour update interval, so `npm test` finished its last test and then sat
// there until GitHub cancelled the job at the 6-hour ceiling, with no failing test to point at.
//
// The shape is a RETURN, not a size. Measure, cycle once to absorb the lazy one-time installs that are
// legitimately permanent, measure again, cycle five more times, and require the second delta to be zero.
// That warm-up is the whole design: it is the only thing that tells "installs once, on first open" apart
// from "installs on every open".
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

/**
 * Count what an overlay can leave behind, by wrapping the four places it accumulates.
 *
 * Wrapped AFTER the viewer has booted, on purpose: everything installed during boot is permanent by
 * design and belongs to no overlay, so counting it would only add a constant to both sides.
 */
function instrument(window) {
  // Live listeners by identity, not a call tally.
  //
  // A tally counts removeEventListener calls, so it reads a teardown that takes off the WRONG listener as
  // a removal — the planted control for that showed up as "listeners 0→-30", caught but backwards. Worse,
  // a teardown that passes the wrong CAPTURE flag (`remove(type, fn)` against `add(type, fn, true)`, a
  // real and quiet bug) nets to zero and would be missed outright. Keying on the triple the DOM itself
  // keys on means only a removal that actually detaches something counts.
  const listeners = new Map();
  const key = (target, type, fn, options) => {
    const capture = typeof options === "object" && options !== null ? !!options.capture : !!options;
    return [target === window ? "window" : "document", type, capture].join("|");
  };
  const handlers = new Map(); // key -> Set of handler functions still attached

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

// Each pair is driven the way the keymap drives it. `open` may decline (an overlay with nothing to show
// is allowed to do nothing) — a pair that never opens is reported, not silently skipped, because a guard
// that quietly measures nothing is the failure mode this repo keeps rediscovering.
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
    // The one with hand-written teardown: showCustomDropdown installs keydown and mousedown on the
    // document with capture and takes both off in its own close(). Two of the viewer's six
    // removeEventListener calls are these, so this pair is the positive example the rest are measured
    // against — and the one that would regress if that close() ever stopped being called.
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

// One window per pair, not one window for the table.
//
// The first version drove every pair in a single window and reported "Recent Locations: nodes 1508→1505".
// Driven on its own that overlay is flat across seven cycles (1428 nodes, every time): the delta was the
// residue of the pairs measured BEFORE it, cleaned up during its own render. A shared window makes each
// measurement a function of the sweep order, which is the one thing a count must not depend on. A window
// costs about a second; a number nobody can attribute costs more than that.
for (const pair of PAIRS) {
  test(`${pair.name} leaves nothing behind when it closes`, async () => {
    const v = await loadViewer(html);
    try {
      const read = instrument(v.window);

      // Warm-up cycle: absorbs whatever this overlay builds once and keeps.
      let opened = false;
      for (let i = 0; i < WARMUP; i += 1) {
        try { pair.open(v.window); opened = true; } catch { /* declined */ }
        await tick();
        try { pair.close(v.window); } catch { /* already closed */ }
        await tick();
      }
      // Reported, never silently skipped: a guard that quietly measures nothing is the failure mode this
      // repo keeps rediscovering.
      assert.ok(opened, "the overlay opened at all");

      const before = read();
      for (let i = 0; i < CYCLES; i += 1) {
        try { pair.open(v.window); } catch { /* declined */ }
        await tick();
        try { pair.close(v.window); } catch { /* already closed */ }
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
