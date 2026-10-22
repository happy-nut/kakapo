// A .http file in the diff is the same file, and the request on the new side is the one it now says to
// send. It was runnable only from the source view, because the runner read its path out of #source-viewer
// and wrote its response into a row the source table had rendered.
//
// The two things this has to get right beyond "it sends": the run buttons must not go in the table, and
// the response must not desync the panes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "api.http";
// The request sits on a DIFFERENT line on each side — the new version adds a note above it. That is what
// makes "the buttons come from the new side" a testable claim rather than a coincidence: on the old side
// the same line number is the Accept header.
const BEFORE = "@base = https://example.test\n\n### list\nGET {{base}}/items\nAccept: application/json\n";
const AFTER = "@base = https://example.test\n\n# note\n### list every\nGET {{base}}/items\nAccept: application/json\n";

let html;
before(async () => { ({ html } = await makeReviewHtml([{ path: FILE, before: BEFORE, after: AFTER }])); });
after(cleanupFixtures);

async function openHttpDiff() {
  const v = await loadViewer(html);
  const sent = [];
  v.window.kakapoHttp = {
    send: (request) => {
      sent.push(request);
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", durationMs: 7, bytes: 2, headers: {}, body: "{}" });
    },
  };
  // The diff view never needed a file's source before, so the decoration fetches it on first sight. Go
  // through the same loader rather than reaching into the viewer's own maps, which are module-scoped.
  await v.window.loadSourceFile(FILE);
  const wrapper = v.window.diffWrapperByPath(FILE);
  v.window.decorateDiffHttpRuns(wrapper);
  await v.settle(60);
  return { v, sent, wrapper };
}

test("a .http file in the diff gets a run button on the new side, outside the table", async () => {
  const { v, wrapper } = await openHttpDiff();
  try {
    const buttons = wrapper.querySelectorAll(".http-run-diff");
    assert.equal(buttons.length, 1, "one button, for the one request in the file");

    // The line-number cell cannot hold it: four readers take that cell's textContent, one of them parsing
    // it as an integer and two treating "non-empty" as "this is a real code line".
    assert.equal(wrapper.querySelector(".d2h-code-side-linenumber .http-run-diff"), null,
      "the button is not inside a line-number cell");
    assert.ok(buttons[0].closest(".mc-http-runs"), "it lives in the overlay layer instead");

    const newSide = v.window.diffSideTable(wrapper, "new");
    for (const row of v.window.diffRowsOf(newSide)) {
      const cell = row.querySelector(".d2h-code-side-linenumber");
      if (!cell) continue;
      const text = (cell.textContent || "").trim();
      if (text) assert.match(text, /^\d+$/, `a line number stayed a number: "${text}"`);
    }

    // The old side is the request as it WAS, and running that would send something the file no longer
    // says. Asked of the LINE the button was placed for, because the buttons live in an overlay that
    // belongs to neither table — "no button inside the base table" is true however the side is chosen,
    // and an earlier version of this test asserted exactly that and proved nothing.
    assert.equal(buttons[0].dataset.side, "new", "the button was built from the working-tree pane's rows");
    const line = Number(buttons[0].dataset.line);
    const textAt = (side, number) => {
      const row = v.window.diffRowsOf(v.window.diffSideTable(wrapper, side))
        .find((r) => v.window.diffLineNumber(r) === number);
      return row ? (row.querySelector(".d2h-code-line-ctn")?.textContent || "") : "";
    };
    assert.match(textAt("new", line), /GET/, "the button marks the request as the new version has it");
    assert.doesNotMatch(textAt("old", line), /GET/, "that same line is something else on the base side");
  } finally {
    v.close();
  }
});

test("running from the diff sends the request and keeps the two panes in step", async () => {
  const { v, sent, wrapper } = await openHttpDiff();
  try {
    const rowsBefore = {
      next: v.window.diffRowsOf(v.window.diffSideTable(wrapper, "new")).length,
      base: v.window.diffRowsOf(v.window.diffSideTable(wrapper, "old")).length,
    };

    wrapper.querySelector(".http-run-diff").click();
    await v.settle(120);

    assert.equal(sent.length, 1, "the request was sent");
    assert.equal(sent[0].method, "GET");
    assert.equal(sent[0].url, "https://example.test/items", "with its file variables resolved");

    assert.ok(wrapper.querySelector(".mc-http-row .http-response"), "the response has somewhere to land");
    // One row on the side that shows it, one spacer opposite — the panes are separate tables aligned by
    // row position, so a row added to one alone shifts every line below it out of step with its peer.
    assert.equal(wrapper.querySelectorAll(".mc-http-row").length, 1);
    assert.equal(wrapper.querySelectorAll(".mc-comment-spacer-row").length, 1, "and a spacer opposite it");

    const rowsAfter = {
      next: v.window.diffRowsOf(v.window.diffSideTable(wrapper, "new")).length,
      base: v.window.diffRowsOf(v.window.diffSideTable(wrapper, "old")).length,
    };
    assert.deepEqual(rowsAfter, rowsBefore, "neither pane gained a navigable row");
  } finally {
    v.close();
  }
});
