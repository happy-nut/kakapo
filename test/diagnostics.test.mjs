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
