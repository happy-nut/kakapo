// Who gets the keyboard back when an overlay closes.
//
// Chromium drops focus from an element that becomes display:none, and the place it lands is <body>. From
// there the next Tab starts at the top of the document, so a reader who opened a palette over line 400 and
// pressed Escape is returned to the page header — and an assistive technology's cursor goes with them.
//
// Three overlays had already fixed this one at a time, each with its own four lines (the semantic peek's
// comment even says "this is the half of that which was missing"). Four others had not. That is the shape
// this test is written against: not "does Quick Open restore focus", but "does every overlay that takes the
// keyboard give it back", asked once per overlay, so the next one added answers the same question.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const client = readFileSync(new URL("../dist/viewer.client.min.js", import.meta.url), "utf8");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ]));
});
after(cleanupFixtures);

// A control a reader could plausibly be on when they reach for a palette: a real, focusable element that
// lives outside every overlay.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function opener(window) {
  const el = window.document.querySelector("#compare-pill, .change-row, .diff-tool-button, button");
  assert.ok(el, "the page has a focusable control outside the overlays");
  el.focus();
  assert.equal(window.document.activeElement, el, "jsdom honoured the focus");
  return el;
}

test("Quick Open hands the keyboard back to whatever opened it", async () => {
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    const palette = v.window.document.getElementById("quick-open");
    assert.ok(palette && !palette.classList.contains("hidden"), "the palette opened");
    assert.equal(v.window.overlayFocusReturn, from, "the opener went into the slot");
    await tick(); // the palette focuses its input from a setTimeout(0), so the page paints first
    assert.ok(palette.contains(v.window.document.activeElement), "the palette took the keyboard");

    v.window.closeQuickOpen();
    assert.notEqual(v.window.document.activeElement, v.window.document.body,
      "focus did not fall through to <body>");
    assert.equal(v.window.document.activeElement, from, "the control that opened it has the keyboard again");
  } finally {
    v.close();
  }
});

test("a close that was not an interaction leaves the caret where the reader put it", async () => {
  // The other half of the behaviour, and the reason restoreOverlayFocus takes `held`. Overlays get closed
  // by things that are not interactions — a view switch, a re-render, a close() called defensively — and
  // yanking focus on those takes the caret out of the diff for no reason the reader can see.
  //
  // The obvious way to write this — close a palette that was never opened, assert nothing moved — passes
  // with the guard removed, which is how it was first written here. With no slot filled the restore falls
  // through to the reading surface, and jsdom has no layout, so focusing that <div> does nothing and the
  // caret appears not to have moved for the wrong reason. So: open it, fill the slot, then put the caret
  // somewhere else by hand, the way a reader clicking back into the page does. Now a restore that ignores
  // `held` has somewhere wrong to go, and going there is visible.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    assert.equal(v.window.overlayFocusReturn, from, "the slot is loaded");
    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, from, "the interactive close returned the keyboard");

    // Second round: the reader moves on, and something closes the palette without them asking.
    v.window.openQuickOpen("file");
    await tick();
    const elsewhere = v.window.document.querySelectorAll("button")[1];
    assert.ok(elsewhere && elsewhere !== from, "the page has a second control to move to");
    elsewhere.focus();
    assert.equal(v.window.document.activeElement, elsewhere, "the caret is where the reader put it");

    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, elsewhere,
      "a close the reader did not make kept its hands off the caret");
  } finally {
    v.close();
  }
});

test("the opener is remembered from outside the overlay, never from within it", async () => {
  // Re-opening a panel from one of its OWN controls must not make that control the thing to return to:
  // the slot would then point inside an overlay that is about to be hidden, and the restore would focus
  // an element with no layout — which reads, to a reader, exactly like the <body> bug it replaces.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    const palette = v.window.document.getElementById("quick-open");
    assert.ok(palette.contains(v.window.document.activeElement), "focus is inside the palette");

    v.window.openQuickOpen("symbol"); // re-open, from within
    assert.equal(v.window.overlayFocusReturn, from,
      "the slot still holds the outside control, not the palette's own input");
    await tick();
    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, from,
      "the re-open did not overwrite the slot with one of the palette's own controls");
  } finally {
    v.close();
  }
});

// The static half: every overlay closer either restores focus or is one of the renderers that only ever
// hides a decoration. A new closer that hides a focusable surface and stops there fails here, in the file
// it was written in, rather than in a screen reader six months later.
test("every overlay closer in the bundle either returns focus or is a decoration", () => {
  // The shared pair, plus the three that solved it individually before the pair existed.
  const RESTORES = /restoreOverlayFocus|\.focus\(/;
  // Hides something, but nothing in it can hold the keyboard — a stripe, a sticky-line band, a status bar.
  const DECORATIONS = new Set([
    "activateDiffFile", "applySetActive", "revealDiffFile", "showDiffView", "showSourceView",
    "syncSourceTabOverflow", "renderSourceTabs", "openSourceFile", "updateHistoryEmptyChrome",
    "updateHistorySelectBar", "refreshStickyLines", "renderDiffStripe", "renderPatchSetBar",
    "coachHide", "closeHistoryIfOpen",
  ]);
  const names = [...client.matchAll(/function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(names.length > 300, `the bundle's functions are visible (found ${names.length})`);

  const offenders = [];
  for (const [, name] of client.matchAll(/function (\w+)\(/g)) {
    const at = client.indexOf(`function ${name}(`);
    const next = names
      .map((n) => client.indexOf(`function ${n}(`, at + 1))
      .filter((i) => i > at)
      .reduce((a, b) => Math.min(a, b), client.length);
    const body = client.slice(at, next);
    if (!/classList\.add\(["']hidden["']\)/.test(body)) continue;
    if (RESTORES.test(body)) continue;
    if (DECORATIONS.has(name)) continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, [], "an overlay closer that hides a focusable surface and leaves focus nowhere");
});
