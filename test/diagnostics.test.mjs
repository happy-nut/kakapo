// CORE USER FLOW: language-server diagnostics in the source view.
//
// The reviewer opens an AI-touched file; the language server's errors/warnings are drawn as wavy underlines
// (CSS Custom Highlight API — not asserted here because jsdom has no CSS.highlights) plus a gutter dot, and
// F2 / Shift+F2 step between the problems inside the file. This test drives the observable surface: the
// per-line markers, the hover message, and where the caret lands after F2.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

const FILE = "src/app.ts";
// 0-based lines: 1 has an error span, 3 has a warning span, the rest are clean.
const AFTER = [
  "const a = 1;",
  "const broken = ;",
  "const c = 3;",
  "const unused = 9;",
  "const e = 5;",
  "",
].join("\n");

function diagnosticsBridge(path) {
  return {
    ok: true,
    generation: 0,
    available: true,
    engine: "lsp",
    diagnostics: path === FILE ? [
      { lineIndex: 1, column: 6, endLineIndex: 1, endColumn: 12, severity: "error", message: "Expression expected", source: "ts" },
      { lineIndex: 3, column: 6, endLineIndex: 3, endColumn: 12, severity: "warning", message: "'unused' is never read", source: "ts" },
    ] : [],
  };
}

async function openWithDiagnostics() {
  const { html } = await makeReviewHtml([{ path: FILE, before: "const a = 1;\n", after: AFTER }]);
  const v = await loadViewer(html, {
    diagnosticsBridge,
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE);
  await v.settle(150); // diagnostics fetch resolves async, then paints markers
  return v;
}

function cursorLineIndex(v) {
  return v.$("#source-body").querySelector(".source-row.cursor-line")?.dataset.lineIndex;
}

test("diagnostics: error and warning lines get severity-colored gutter markers; clean lines do not", async () => {
  const v = await openWithDiagnostics();
  const body = v.$("#source-body");
  assert.ok(v.window.__diagnosticsRequests.includes(FILE), "the opened file requests diagnostics");

  const errorRow = body.querySelector('.source-row[data-line-index="1"]');
  const warningRow = body.querySelector('.source-row[data-line-index="3"]');
  const cleanRow = body.querySelector('.source-row[data-line-index="0"]');

  assert.ok(errorRow.classList.contains("has-diagnostic") && errorRow.classList.contains("diag-error"), "error line is marked as an error");
  assert.ok(warningRow.classList.contains("has-diagnostic") && warningRow.classList.contains("diag-warning"), "warning line is marked as a warning");
  assert.ok(!cleanRow.classList.contains("has-diagnostic"), "a clean line carries no diagnostic marker");
  v.close();
});

test("diagnostics: resting the pointer on a problem line shows the message in a dwell tooltip; leaving hides it", async () => {
  const v = await openWithDiagnostics();
  const cell = v.$('#source-body .source-row[data-line-index="1"] .source-code');
  cell.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 60 }));
  await v.settle(1100); // the ~1s dwell before the tooltip appears
  const tip = v.$(".diag-tooltip");
  assert.ok(tip && tip.style.display !== "none", "the tooltip appears after the dwell");
  assert.match(tip.textContent, /Expression expected/, "the tooltip shows the diagnostic message");

  const clean = v.$('#source-body .source-row[data-line-index="0"] .source-code');
  clean.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 90 }));
  await v.settle(40);
  assert.equal(v.$(".diag-tooltip").style.display, "none", "the tooltip hides when the pointer leaves the line");
  v.close();
});

test("diagnostics: F2 / Shift+F2 step between problems within the file and wrap", async () => {
  const v = await openWithDiagnostics();
  assert.equal(cursorLineIndex(v), "0", "caret starts at the top of the file");

  v.key("F2");
  await v.settle(60);
  assert.equal(cursorLineIndex(v), "1", "F2 jumps to the first problem");

  v.key("F2");
  await v.settle(60);
  assert.equal(cursorLineIndex(v), "3", "F2 advances to the next problem");

  v.key("F2");
  await v.settle(60);
  assert.equal(cursorLineIndex(v), "1", "F2 wraps back to the first problem");

  v.key("F2", { shiftKey: true });
  await v.settle(60);
  assert.equal(cursorLineIndex(v), "3", "Shift+F2 steps to the previous problem, wrapping to the last");
  v.close();
});

test("diagnostics: the caret line keeps its underline after F2 repatches the row", async () => {
  const v = await openWithDiagnostics();
  v.key("F2");
  await v.settle(80);
  const row = v.$("#source-body").querySelector('.source-row[data-line-index="1"]');
  assert.ok(row.classList.contains("cursor-line"), "F2 landed the caret on the problem line");
  assert.ok(row.classList.contains("has-diagnostic") && row.classList.contains("diag-error"),
    "the diagnostic marker is re-established on the caret line after the in-place caret repaint");
  v.close();
});

test("diagnostics: Opt+Enter on a problem line drafts a change-request comment to fix it", async () => {
  const v = await openWithDiagnostics();
  await v.clickSourceLine(1); // caret on the error line (0-based line 1)
  v.key("Enter", { altKey: true });
  await v.settle(60);
  const fix = v.storedComments().find((c) => c.kind === "c");
  assert.ok(fix, "a change-request comment was created");
  assert.equal(fix.line, 2, "anchored to the 1-based diagnostic line");
  assert.match(fix.text, /Expression expected/, "the fix instruction quotes the diagnostic message");
  // A clean line offers no fix action, so Opt+Enter there creates nothing.
  await v.clickSourceLine(0);
  v.key("Enter", { altKey: true });
  await v.settle(40);
  assert.equal(v.storedComments().filter((c) => c.kind === "c").length, 1, "no comment is drafted on a clean line");
  v.close();
});

// USER_FLOWS Flow 6: a file no language server covers reports `available:false` rather than a misleading
// empty "no problems". analysis.ts has always honoured that; the viewer dropped the field on the way into
// its cache and said the reassuring thing anyway — for CSS, for Markdown, for anything outside a server's
// languages. Three different silences had one sentence, and it was true for exactly one of them.
const UNCOVERED = "styles/app.css";

async function openUncovered() {
  const { html } = await makeReviewHtml([
    { path: UNCOVERED, before: ".a { color: red; }\n", after: ".a { color: blue; }\n" },
  ]);
  const v = await loadViewer(html, {
    // What analysis.ts returns for a path no client claims: ok, but nothing is checking it.
    diagnosticsBridge: () => ({ ok: true, generation: 0, available: false, engine: "index", diagnostics: [] }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(UNCOVERED);
  await v.settle(150);
  return v;
}

test("a file no language server covers is not reported as having no problems", async () => {
  const v = await openUncovered();
  try {
    assert.equal(v.window.gotoDiagnostic(1), true, "F2 still answers the key");
    const hint = v.$(".mc-caret-hint");
    assert.ok(hint, "it says something");
    const said = hint.textContent.trim();
    assert.notEqual(said, v.window.t("diag.none"),
      "it must not be the sentence that means the file was checked and is clean");
    assert.equal(said, v.window.t("diag.unavailable"), "it says nothing is checking this file");
  } finally {
    v.close();
  }
});

test("a file that IS covered and clean still says so", async () => {
  const { html } = await makeReviewHtml([
    { path: FILE, before: "const a = 1;\n", after: "const a = 2;\n" },
  ]);
  const v = await loadViewer(html, {
    // Covered by a server, and it found nothing — the one case "no problems" describes.
    diagnosticsBridge: () => ({ ok: true, generation: 0, available: true, engine: "lsp", diagnostics: [] }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  try {
    await v.openSourceFile(FILE);
    await v.settle(150);
    assert.equal(v.window.gotoDiagnostic(1), true, "F2 answers");
    assert.equal(v.$(".mc-caret-hint").textContent.trim(), v.window.t("diag.none"),
      "a checked, clean file gets the reassuring sentence — it has earned it");
  } finally {
    v.close();
  }
});

// Any scroll called hideDiagnosticTooltip, which clears the pending timer — but left the hover key set,
// so every later mousemove over the SAME line took the "something is already standing" early return and
// scheduled nothing. The message became unreachable for that line until the pointer left the row and came
// back. Scrolling mid-read is not rare: F7, Cmd+L, saving a comment and the wheel all do it.
test("a scroll does not make a problem line's tooltip unreachable", async () => {
  const v = await openWithDiagnostics();
  try {
    const cell = v.$('#source-body .source-row[data-line-index="1"] .source-code');
    const move = (x) => cell.dispatchEvent(new v.window.MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: 10 }));

    move(20);
    assert.notEqual(v.window.diagnosticHoverTimer, 0, "resting on the line arms the dwell timer");

    v.document.dispatchEvent(new v.window.Event("scroll", { bubbles: true }));
    assert.equal(v.window.diagnosticHoverTimer, 0, "a scroll takes the pending tooltip away");

    move(40); // same line, pointer never left
    assert.notEqual(v.window.diagnosticHoverTimer, 0,
      "moving again on the same line arms it again instead of being swallowed by the early return");
  } finally {
    v.close();
  }
});

// A diagnostic message is the longest thing this app puts in a caret hint — measured to 190 characters,
// about nine seconds of reading — and the hint's own default is two. There is no keyboard way to ask for
// it again, so a two-second version is a message you were shown and could not read.
test("F2's message stays up long enough to read", async () => {
  const v = await openWithDiagnostics();
  try {
    v.window.gotoDiagnostic(1);
    const hint = v.$(".mc-caret-hint");
    assert.ok(hint, "F2 says something");
    assert.match(hint.textContent, /Expression expected/, "and it is the diagnostic");
    // The element is never removed — it is shown and hidden by the `show` class — so that is what has to
    // be asserted. Checking the element exists passes either way, which is the difference between a guard
    // and a decoration: this test passed with `sticky` removed until it was asserting the right thing.
    assert.ok(hint.classList.contains("show"), "the hint is up");
    // The hint's own auto-hide is 2s; sticky means no timer was scheduled to take it away.
    await v.settle(2400);
    assert.ok(v.$(".mc-caret-hint").classList.contains("show"),
      "it is still up after the two seconds a non-sticky hint gets");
    assert.match(v.$(".mc-caret-hint").textContent, /Expression expected/, "and still says the same thing");
  } finally {
    v.close();
  }
});
