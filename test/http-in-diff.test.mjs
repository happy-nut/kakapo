import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "api.http";
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
