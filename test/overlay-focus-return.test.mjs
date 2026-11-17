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
    await tick();
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
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    assert.equal(v.window.overlayFocusReturn, from, "the slot holds the opener");

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
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    assert.equal(v.window.overlayFocusReturn, from, "the slot holds the opener");

    from.remove();
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
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    const palette = v.window.document.getElementById("quick-open");
    assert.ok(palette.contains(v.window.document.activeElement), "the palette has the keyboard");

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
  const v = await loadViewer(html);
  try {
    const from = opener(v.window);
    v.window.openQuickOpen("file");
    await tick();
    const palette = v.window.document.getElementById("quick-open");
    assert.ok(palette.contains(v.window.document.activeElement), "focus is inside the palette");

    v.window.openQuickOpen("symbol");
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

test("every overlay closer in the slices either returns focus or is a decoration", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../src/viewer/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  assert.ok(files.length > 30, `the slices are there (found ${files.length})`);

  const DECORATIONS = new Set([
    "activateDiffFile", "applySetActive", "revealDiffFile", "showDiffView", "showSourceView",
    "syncSourceTabOverflow", "renderSourceTabs", "openSourceFile", "updateHistoryEmptyChrome",
    "updateHistorySelectBar", "refreshStickyLines", "renderDiffStripe", "renderPatchSetBar",
    "coachHide", "closeHistoryIfOpen", "closeLightbox",
    "hide",
  ]);

  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const starts = [...text.matchAll(/^[ \t]*(?:async )?function (\w+)\s*\(/gm)].map((m) => ({ at: m.index, name: m[1] }));
    starts.forEach((decl, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
      const body = text.slice(decl.at, end);
      if (!/classList\.add\(["']hidden["']\)/.test(body)) return;
      scanned += 1;
      if (/restoreOverlayFocus|focusReadingSurface|\.focus\(/.test(body)) return;
      if (DECORATIONS.has(decl.name)) return;
      offenders.push(`${file}: ${decl.name}()`);
    });
  }
  assert.ok(scanned >= 15, `the scan reached the functions that hide things (scanned ${scanned})`);
  assert.deepEqual(offenders, [], "an overlay closer that hides a focusable surface and leaves focus nowhere");
});
