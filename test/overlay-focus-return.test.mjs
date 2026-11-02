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

test("a close of something that was never open leaves the caret alone", async () => {
  // The claim is unchanged; what counts as "not an interaction" is not. It used to mean "the overlay does
  // not have focus right now", and that turned out to be true of almost every real dismissal — an outside
  // click blurs on mousedown, Quick Open's recent mode blurs on the way IN, following a result closes
  // before navigating — so the restore was skipped exactly when it was wanted, and Escape and a click
  // outside behaved differently for the same dismissal. It now means "the overlay was not up", which is
  // the case this guard was actually written for: a close() called defensively by a view switch.
  //
  // This version is falsifiable where the first was not. The first asserted that focus had not moved
  // after closing an unopened palette, which passed with the guard removed too — the fallback could not
  // focus a <div> with no tabindex, so nothing moved either way and the test could not tell. The
  // fallback stamps the attribute now, so a restore that should not have run is visible.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, from,
      "closing a palette that was never open did not touch the caret");

    v.window.closeUsages();
    assert.equal(v.window.document.activeElement, from, "same for a panel that was never open");
  } finally {
    v.close();
  }
});

test("a palette that blurred to <body> still remembers where the reader came from", async () => {
  // Quick Open's recent and symbol modes blur on the way in, on purpose — the speed-search reads keys at
  // the document. So switching mode while the palette is up came back through rememberOverlayFocus with
  // activeElement === <body>, which wiped the slot: the reader's origin was lost to an action that never
  // left the dialog, and Escape dropped them on the reading surface instead of the row they started on.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    assert.equal(v.window.overlayFocusReturn, from, "the slot holds the opener");

    // What a blurring mode switch looks like from here.
    v.window.document.activeElement.blur();
    assert.equal(v.window.document.activeElement, v.window.document.body, "focus fell to <body>");
    v.window.openQuickOpen("recent");
    assert.equal(v.window.overlayFocusReturn, from, "the slot survived the switch");

    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, from, "and the reader goes back where they started");
  } finally {
    v.close();
  }
});

test("when the opener is gone the keyboard lands on the page, not on <body>", async () => {
  // The fallback half, and the half that was DEAD when it shipped. #source-body and #diff2html-container
  // are plain <div>s with no tabindex, so focus() on them does nothing at all — in Chromium as in the
  // spec — while the function returned true and reported a successful restore. Three other places in
  // this bundle stamp tabIndex = -1 first; the shared helper was factored out of the two that did not.
  //
  // Nothing exercised this path, which is why it shipped: every other test here has a live opener to go
  // back to, so the restore never reaches the fallback. This one takes the opener away.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    assert.equal(v.window.overlayFocusReturn, from, "the slot holds the opener");

    from.remove(); // the sidebar re-rendered under it — the single most ordinary way to lose an opener
    assert.equal(from.isConnected, false, "the opener is gone");

    v.window.closeQuickOpen();
    const landed = v.window.document.activeElement;
    assert.notEqual(landed, v.window.document.body,
      "focus did not fall through to <body> — which is the whole bug this pair exists to prevent");
    assert.match(landed.id, /^(source-body|diff2html-container)$/,
      `the keyboard is on a reading surface (landed on ${landed.id || landed.tagName})`);
  } finally {
    v.close();
  }
});

test("a dismissal restores even though focus has already left the overlay", async () => {
  // The behaviour the predicate change buys, stated as its own claim: a click outside blurs the input
  // before the close runs, so "does it hold focus" is false at exactly the moment it matters.
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    const palette = v.window.document.getElementById("quick-open");
    assert.ok(palette.contains(v.window.document.activeElement), "the palette has the keyboard");

    // What a mousedown outside does before the handler runs.
    v.window.document.activeElement.blur();
    assert.equal(v.window.document.activeElement, v.window.document.body, "focus has already left");

    v.window.closeQuickOpen();
    assert.equal(v.window.document.activeElement, from,
      "the dismissal still returned the keyboard to whoever opened it");
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
//
// It reads the SLICES, not the minified bundle. The first version scanned dist/viewer.client.min.js and
// sliced each function body with `indexOf("function " + name + "(")` — the first occurrence — but
// minification mangles names, so 63 of that bundle's 1213 matches are ambiguous and each was checked at
// some other function's offset. It passed while the Settings sheet, the most focus-aware overlay in the
// app, closed without restoring anything: `function close()` minified to `function d()`, and
// `indexOf("function d(")` found a different `d` 28k characters earlier. A guard that looks in the wrong
// place reports on the wrong code, and reports it green.
test("every overlay closer in the slices either returns focus or is a decoration", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../src/viewer/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  assert.ok(files.length > 30, `the slices are there (found ${files.length})`);

  // Hides something, but nothing in it can hold the keyboard — a stripe, a sticky-line band, a status
  // bar, a hover tooltip. Each of these was read before being listed.
  const DECORATIONS = new Set([
    "activateDiffFile", "applySetActive", "revealDiffFile", "showDiffView", "showSourceView",
    "syncSourceTabOverflow", "renderSourceTabs", "openSourceFile", "updateHistoryEmptyChrome",
    "updateHistorySelectBar", "refreshStickyLines", "renderDiffStripe", "renderPatchSetBar",
    "coachHide", "closeHistoryIfOpen", "closeLightbox",
    // The keyhint tooltip (05-keymap.js). It follows the pointer and is never focused — it has no
    // tabindex and no control inside it — so there is no keyboard to hand back.
    "hide",
  ]);

  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    // At ANY indentation, not just column zero. The first version anchored to the start of the line and
    // so saw only top-level declarations — which missed the Settings sheet's `close`, nested two spaces
    // deep inside setupSettings, i.e. the very overlay this guard was written for. Sliced to the next
    // declaration in the SAME file, so a name that also exists in another slice cannot misdirect it.
    const starts = [...text.matchAll(/^[ \t]*(?:async )?function (\w+)\s*\(/gm)].map((m) => ({ at: m.index, name: m[1] }));
    starts.forEach((decl, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
      const body = text.slice(decl.at, end);
      if (!/classList\.add\(["']hidden["']\)/.test(body)) return;
      scanned += 1;
      // focusReadingSurface() counts: it IS the restore, for the overlays that hand the keyboard to the
      // page rather than to a control. Leaving it out flagged the two overlays that were just routed
      // through it — a guard reporting a fix as the defect it fixes.
      if (/restoreOverlayFocus|focusReadingSurface|\.focus\(/.test(body)) return;
      if (DECORATIONS.has(decl.name)) return;
      offenders.push(`${file}: ${decl.name}()`);
    });
  }
  assert.ok(scanned >= 15, `the scan reached the functions that hide things (scanned ${scanned})`);
  assert.deepEqual(offenders, [], "an overlay closer that hides a focusable surface and leaves focus nowhere");
});
