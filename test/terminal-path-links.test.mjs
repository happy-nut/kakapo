// A path an agent prints in the integrated terminal is clickable, exactly like the URL beside it, and opens
// through the same openPathReference an agent's prose path uses (23-annotations.js / 07-comments.js).
//
// xterm doesn't boot under jsdom, so the provider is driven against a stand-in buffer — which is the part
// worth testing anyway: joining a wrapped row back into one path, and mapping a string offset onto real
// COLUMNS. A path that breaks across two rows is the case that started this, and a Korean line above it is
// the case where offset-as-column silently underlines the wrong thing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export function run() {\n  return 42;\n}\n", after: "export function run() {\n  return 43;\n}\n" },
  ]));
});
after(cleanupFixtures);

/** A stand-in xterm buffer: `rows` are [text, isWrapped]. A row is `cols` wide however short its text is,
 *  and a char outside Latin-1 occupies two columns — the two ways a string offset is not a column. */
function fakeTerm(rows, cols = 40) {
  const cells = rows.map(([text]) => {
    const out = [];
    for (const ch of text) { out.push(ch); if (ch.codePointAt(0) > 0xff) out.push(""); } // wide: second half is empty
    while (out.length < cols) out.push(" ");
    return out;
  });
  const line = (y) => (cells[y] === undefined ? undefined : {
    isWrapped: rows[y][1],
    length: cells[y].length,
    translateToString: () => rows[y][0],
    getCell: (x, cell) => { cell.__chars = cells[y][x] ?? " "; },
  });
  return {
    buffer: { active: { getLine: line, getNullCell: () => ({ getChars() { return this.__chars; }, getWidth() { return this.__chars === "" ? 0 : 1; } }) } },
  };
}
// jsdom objects carry the viewer realm's prototypes, so compare ranges structurally rather than by identity.
const rangeOf = (link) => JSON.stringify(link.range);
const linksOn = (v, term, row) => { let got; v.window.terminalPathLinkProvider(term).provideLinks(row, (l) => { got = l; }); return got || []; };

test("a path printed in the terminal becomes a link that opens it", async () => {
  const v = await loadViewer(html);
  const term = fakeTerm([["see src/app.ts:2 for it", false]]);
  const links = linksOn(v, term, 1);
  assert.equal(links.length, 1, "one link, and not one per word");
  assert.equal(links[0].text, "src/app.ts:2", "the line number travels with the path");
  assert.equal(rangeOf(links[0]), '{"start":{"x":5,"y":1},"end":{"x":16,"y":1}}', "underlined over the path's own columns");

  const opened = [];
  v.window.openPathReference = (ref) => opened.push(ref);
  links[0].activate({ button: 0 }, links[0].text);
  assert.deepEqual([...opened], ["src/app.ts:2"], "a left click opens it through the same path resolver as an agent's prose");
  links[0].activate({ button: 2 }, links[0].text);
  assert.equal(opened.length, 1, "a right click keeps its native meaning");
  v.close();
});

test("a path that wraps across rows links as one whole path, from either row", async () => {
  const v = await loadViewer(html);
  const term = fakeTerm([["open /private/tmp/scratch", false], ["pad/mock/brief-popup.html", true]], 25);
  const whole = "/private/tmp/scratchpad/mock/brief-popup.html";
  for (const row of [1, 2]) {
    const links = linksOn(v, term, row);
    assert.equal(links.length, 1, `row ${row} sees the link`);
    assert.equal(links[0].text, whole, "half a path resolves to nothing, so both rows carry the whole one");
    assert.equal(rangeOf(links[0]), '{"start":{"x":6,"y":1},"end":{"x":25,"y":2}}', "the range spans both rows");
  }
  v.close();
});

test("a wide-glyph line does not shift the underline off the path", async () => {
  const v = await loadViewer(html);
  const term = fakeTerm([["열어줘 src/app.ts", false]]);
  const links = linksOn(v, term, 1);
  assert.equal(links.length, 1);
  // "열어줘 " is 4 characters but 7 columns: offset-as-column would start the underline 3 cells early.
  assert.equal(rangeOf(links[0]), '{"start":{"x":8,"y":1},"end":{"x":17,"y":1}}', "columns, not string offsets");
  v.close();
});

test("things that only look like paths are left alone", async () => {
  const v = await loadViewer(html);
  const term = fakeTerm([["ok https://example.com/a.js done 3.14 ...", false]]);
  assert.deepEqual([...linksOn(v, term, 1).map((l) => l.text)], [], "a URL stays the web-links addon's, and prose is not a path");
  v.close();
});
