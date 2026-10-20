// Two views in this app render a <table>, and they had each other's semantics.
//
// CSV is the one that genuinely IS a table — a delimited file's first record names its columns — and it
// shipped with no <thead>, no scope on any <th>, and its gutter cell as a plain <td> sitting among the
// header cells. So the single thing a data table exists for, announcing "name: widget, qty: 3" instead of
// "widget, 3", was the thing it could not do.
//
// Rendered Markdown is the one that is NOT: its rows exist so a comment can be anchored to the block it is
// about (USER_FLOWS Flow 4), a layout device. Declared as a real table, a screen reader walks a README as
// a two-column grid, announcing a row and column position for every paragraph in it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "README.md", before: "# One\n", after: "# One\n\nA paragraph.\n\n- a list item\n" },
  ]));
});
after(cleanupFixtures);

test("a delimited file is a table that can name its columns", async () => {
  const v = await loadViewer(html);
  try {
    const dom = v.window.document.createElement("div");
    dom.innerHTML = v.window.renderCsvRows("name,qty\nwidget,3\ngizmo,7\n", "data.csv");

    const thead = dom.querySelector("thead");
    assert.ok(thead, "the record that names the columns is a header");
    assert.equal(dom.querySelectorAll("thead tr").length, 1, "and it is the only one");
    assert.equal(dom.querySelectorAll("tbody tr").length, 2, "the data records are the body");

    const headers = [...thead.querySelectorAll("th")];
    assert.ok(headers.length >= 3, `every header cell is a th, the gutter included (${headers.length})`);
    for (const th of headers) {
      assert.equal(th.getAttribute("scope"), "col",
        `"${th.textContent}" says which cells it names`);
    }
    assert.equal(thead.querySelectorAll("td").length, 0, "nothing in the header row is a plain cell");
  } finally {
    v.close();
  }
});

// A ragged record makes the table wider than its header row, which manufactures header cells for columns
// that have no name. Announcing an empty name on every row below is worse than announcing none.
test("a column the header never named does not get an empty name", async () => {
  const v = await loadViewer(html);
  try {
    const dom = v.window.document.createElement("div");
    dom.innerHTML = v.window.renderCsvRows("name,qty\nwidget,3,extra\n", "data.csv");
    const headers = [...dom.querySelectorAll("thead th")];
    const named = headers.filter((th) => th.getAttribute("scope") === "col");
    const blank = headers.filter((th) => !th.textContent.trim());
    assert.ok(blank.length >= 1, "the ragged record widened the table past its header");
    for (const th of blank) {
      assert.equal(th.getAttribute("scope"), null, "a nameless column does not claim to name anything");
    }
    assert.ok(named.length >= 2, "the columns that DO have names keep them");
  } finally {
    v.close();
  }
});

test("rendered Markdown is not announced as a data table", async () => {
  const v = await loadViewer(html);
  try {
    await v.openSourceFile("README.md");
    await v.settle(120);
    const table = v.$("#source-body table.md-doc");
    assert.ok(table, "the rendered document is laid out in a table");
    assert.equal(table.getAttribute("role"), "presentation",
      "but it is a layout device, so it does not claim to be a grid of data");
    // The rows still have to be there — they are what a comment anchors to.
    assert.ok(table.querySelectorAll("tr.md-row").length > 0, "the per-block rows survive");
  } finally {
    v.close();
  }
});
