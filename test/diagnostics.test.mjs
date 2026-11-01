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

test("diagnostics: a weak warning gets its own gutter mark, and loses the line to a real warning", async () => {
  // Its own bridge rather than the shared one above: adding a third diagnostic to that fixture would move
  // every F2 stepping assertion in this file, and those are measuring something else.
  const { html } = await makeReviewHtml([{ path: FILE, before: "const a = 1;\n", after: AFTER }]);
  const v = await loadViewer(html, {
    diagnosticsBridge: (path) => ({
      ok: true,
      generation: 0,
      available: true,
      engine: "lsp",
      diagnostics: path === FILE ? [
        { lineIndex: 3, column: 6, endLineIndex: 3, endColumn: 12, severity: "weak", message: "'unused' is declared but its value is never read", source: "typescript" },
        // Two on one line: the gutter has room for one mark, and it has to be the louder of the two.
        { lineIndex: 1, column: 0, endLineIndex: 1, endColumn: 5, severity: "weak", message: "unreachable code detected", source: "typescript" },
        { lineIndex: 1, column: 6, endLineIndex: 1, endColumn: 12, severity: "warning", message: "shadowed name", source: "typescript" },
      ] : [],
    }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE);
  await v.settle(150);
  const body = v.$("#source-body");

  const weakRow = body.querySelector('.source-row[data-line-index="3"]');
  assert.ok(weakRow.classList.contains("has-diagnostic") && weakRow.classList.contains("diag-weak"),
    "the weak line is marked, and marked as weak");

  const bothRow = body.querySelector('.source-row[data-line-index="1"]');
  assert.ok(bothRow.classList.contains("diag-warning"), "the warning wins the gutter on a line holding both");
  assert.ok(!bothRow.classList.contains("diag-weak"), "and the weak mark does not also sit there");
  v.close();
});

test("diagnostics: Essential Highlighting takes the weak mark off the line it was on", async () => {
  // The repaint runs over the rows it painted last time, so the clear has to know every tier the paint can
  // add. It listed two while the paint added three, and a weak mark stayed in the gutter after the filter
  // that hides weak problems was switched on — a mark for a problem the reader can no longer see.
  const { html } = await makeReviewHtml([{ path: FILE, before: "const a = 1;\n", after: AFTER }]);
  const v = await loadViewer(html, {
    diagnosticsBridge: (path) => ({
      ok: true, generation: 0, available: true, engine: "lsp",
      diagnostics: path === FILE ? [
        { lineIndex: 3, column: 6, endLineIndex: 3, endColumn: 12, severity: "weak", message: "never read", source: "typescript" },
      ] : [],
    }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE);
  await v.settle(150);
  const row = () => v.$('#source-body .source-row[data-line-index="3"]');
  assert.ok(row().classList.contains("diag-weak"), "the weak line is marked before the filter is on");

  v.key("e", { shiftKey: true, altKey: true, code: "KeyE" }); // ⇧⌥E, Essential Highlighting
  await v.settle(60);
  assert.equal(v.window.document.documentElement.getAttribute("data-essential-highlighting"), "on",
    "the filter really went on — otherwise the assertion below proves nothing");
  assert.ok(!row().classList.contains("diag-weak"), "and the mark is gone once weak problems are hidden");
  assert.ok(!row().classList.contains("has-diagnostic"), "the line carries no diagnostic marker at all");
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
    // Not yet. The first answer is empty and may still grow — tsserver's syntactic pass lands before its
    // suggestion pass — so the sentence has not been EARNED, which is what this test is about.
    assert.equal(v.window.gotoDiagnostic(1), true, "F2 answers");
    assert.equal(v.$(".mc-caret-hint").textContent.trim(), v.window.t("diag.pending"),
      "while the answer is provisional, F2 says it is still checking");

    await v.settle(1600); // the one scheduled re-ask settles it
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

// ---- an empty first answer is not "no problems" ------------------------------------------------------
// tsserver publishes its syntactic pass first and its suggestion pass — the whole weak tier — afterwards,
// so the first read of a file is routinely `ok, available, []` and the second one is not. Cached as final,
// that emptiness was permanent: the ⌘6 list, which asks main directly, showed a problem on a line F2 swore
// was clean, in the same file, in the same second.
test("diagnostics: an empty-but-available answer is re-asked once, and the second one stands", async () => {
  const FILE2 = "src/late.ts";
  let asked = 0;
  const lateBridge = (path) => {
    if (path !== FILE2) return { ok: true, generation: 0, available: true, engine: "lsp", diagnostics: [] };
    asked += 1;
    return {
      ok: true, generation: 0, available: true, engine: "lsp",
      // Empty the first time, as a warming server answers; the suggestion pass lands on the second read.
      diagnostics: asked === 1 ? [] : [
        { lineIndex: 2, column: 0, endLineIndex: 2, endColumn: 4, severity: "weak", message: "later", source: "ts" },
      ],
    };
  };
  const { html } = await makeReviewHtml([{ path: FILE2, before: "a\n", after: "a\nb\nc\nd\n" }]);
  const v = await loadViewer(html, {
    diagnosticsBridge: lateBridge,
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE2);
  await v.settle(150);
  assert.equal(asked, 1, "one read, served from cache by anything else that asked");
  const first = v.window.diagnosticsCache.get(FILE2);
  assert.deepEqual([...first.items], [], "the empty answer is cached");
  assert.equal(first.provisional, true, "...but marked as not the last word");

  await v.settle(1600); // DIAGNOSTICS_RETRY_MS
  assert.equal(asked, 2, "exactly one re-ask");
  const second = v.window.diagnosticsCache.get(FILE2);
  assert.equal(second.items.length, 1, "the suggestion pass landed");
  assert.equal(second.provisional, false, "a non-empty answer is final");

  // And a file that really is clean settles instead of re-asking forever.
  await v.settle(1600);
  assert.equal(asked, 2, "no third read");
  v.close();
});

test("diagnostics: a genuinely clean file settles after one re-ask and is then served from cache", async () => {
  const FILE3 = "src/clean.ts";
  let asked = 0;
  const cleanBridge = (path) => {
    if (path === FILE3) asked += 1;
    return { ok: true, generation: 0, available: true, engine: "lsp", diagnostics: [] };
  };
  const { html } = await makeReviewHtml([{ path: FILE3, before: "a\n", after: "a\nb\n" }]);
  const v = await loadViewer(html, {
    diagnosticsBridge: cleanBridge,
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE3);
  await v.settle(150);
  await v.settle(1600);
  const settled = v.window.diagnosticsCache.get(FILE3);
  assert.equal(asked, 2, "asked twice in total, then stopped");
  assert.equal(settled.provisional, false, "the second empty answer IS the answer");
  // The entry being final is what lets fetchDiagnostics serve it from cache instead of re-requesting.
  v.window.fetchDiagnostics(FILE3);
  await v.settle(50);
  assert.equal(asked, 2, "a cached final answer is not re-requested");
  v.close();
});

// The retry is scheduled FOR a signature. It used to re-derive the signature when it fired and carry
// "this is the second read" into what could be the first read of NEW content — so a watch rebuild landing
// in that 1.2 s window left the new content's syntactic-only empty answer cached as the last word on it.
test("diagnostics: a retry that fires after the content changed does not settle the new content", async () => {
  const FILE4 = "src/moved.ts";
  const answers = [];
  const bridge = (path) => {
    if (path !== FILE4) return { ok: true, generation: 0, available: true, engine: "lsp", diagnostics: [] };
    answers.push(1);
    return { ok: true, generation: 0, available: true, engine: "lsp", diagnostics: [] };
  };
  const { html } = await makeReviewHtml([{ path: FILE4, before: "a\n", after: "a\nb\n" }]);
  const v = await loadViewer(html, {
    diagnosticsBridge: bridge,
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openSourceFile(FILE4);
  await v.settle(150);
  assert.equal(v.window.diagnosticsCache.get(FILE4).provisional, true, "the first empty answer is provisional");

  // The content moves while the retry is pending — exactly what a watch rebuild does.
  // `fileSignatureByPath` is a top-level `let`, so it is in the global LEXICAL scope and not on `window`;
  // eval reaches it where a property read cannot. (reference_viewer_globals_let_vs_var)
  v.window.eval(`fileSignatureByPath.set(${JSON.stringify(FILE4)}, "a-different-signature")`);
  await v.settle(1600);

  const after = v.window.diagnosticsCache.get(FILE4);
  if (after) {
    assert.equal(after.provisional, true,
      "the new content's first empty answer is still provisional — the retry belonged to the old one");
  }
  v.close();
});
