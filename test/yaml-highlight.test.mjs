// YAML in the source view's own tokenizer.
//
// The diff view runs highlight.js, which has always known YAML; the source view runs the hand-written
// tokenizer in 11-render-http.js, which is built for keyword languages — and YAML has no keywords, it has
// keys. So a .yml file opened in the source view came out plain apart from its `#` comments, in every
// theme. That is the bug these guard.
//
// The expected ROLES come from the shipped dracula-theme VS Code package, scope by scope: a key is
// entity.name.tag.yaml (the type colour), the `:` and the `-` are punctuation (the keyword colour), a
// scalar is `string` whether or not it is quoted, numbers and booleans are `constant`, an anchor is
// entity.name.type and an alias is variable.other.alias. The assertions below are about which class a
// token gets, not about a hex value — the class is what carries the theme.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

// One hook, not two: a second top-level `before` that reads what the first one assigned is a race this
// runner does not promise to win.
let viewer;
before(async () => {
  const { html } = await makeReviewHtml([
    { path: ".github/workflows/release.yml", before: "name: Old\n", after: "name: Release\n" },
  ]);
  viewer = await loadViewer(html);
});
after(() => { viewer?.close(); return cleanupFixtures(); });

/** The tokens of one YAML line, as [class, text] — the plain stretches included, as ["", text]. */
function tokens(line) {
  const host = viewer.document.createElement("div");
  host.innerHTML = viewer.window.highlightLine(line, "yaml");
  return Array.from(host.childNodes)
    .map((node) => [node.nodeType === 1 ? node.className : "", node.textContent])
    .filter(([, text]) => text.trim().length > 0);
}
const classes = (line) => tokens(line).map(([name]) => name);
const text = (line) => tokens(line).map(([, value]) => value).join("");

test("a key is the key colour and its colon is punctuation", () => {
  assert.deepEqual(tokens("name: Release"), [
    ["tok-type", "name"],
    ["tok-keyword", ":"],
    ["tok-string", "Release"],
  ]);
});

test("a plain scalar is a string, exactly as a quoted one is", () => {
  // Dracula paints both from the `string` scope, and a reviewer scanning a workflow file reads the values
  // as one column — colouring the quoted half and not the other breaks that column in two.
  assert.deepEqual(classes("runs-on: ubuntu-latest"), ["tok-type", "tok-keyword", "tok-string"]);
  assert.deepEqual(classes('runs-on: "ubuntu-latest"'), ["tok-type", "tok-keyword", "tok-string"]);
});

test("numbers, booleans and null are constants, in any of YAML's spellings", () => {
  assert.deepEqual(classes("timeout-minutes: 30"), ["tok-type", "tok-keyword", "tok-number"]);
  assert.deepEqual(classes("fail-fast: false"), ["tok-type", "tok-keyword", "tok-literal"]);
  assert.deepEqual(classes("cache: TRUE"), ["tok-type", "tok-keyword", "tok-literal"]);
  assert.deepEqual(classes("shell: off"), ["tok-type", "tok-keyword", "tok-literal"]);
  assert.deepEqual(classes("value: null"), ["tok-type", "tok-keyword", "tok-literal"]);
  assert.deepEqual(classes("value: ~"), ["tok-type", "tok-keyword", "tok-literal"]);
  // …and a word that merely contains one of them is a scalar.
  assert.deepEqual(classes("name: nofail"), ["tok-type", "tok-keyword", "tok-string"]);
});

test("a list bullet is punctuation and the item beside it is a value", () => {
  assert.deepEqual(tokens("  - ubuntu-latest"), [["tok-keyword", "-"], ["tok-string", "ubuntu-latest"]]);
  assert.deepEqual(classes("  - name: Build"), ["tok-keyword", "tok-type", "tok-keyword", "tok-string"]);
  assert.deepEqual(classes("  - - nested"), ["tok-keyword", "tok-keyword", "tok-string"]);
});

test("a comment is a comment, and a `#` inside a value is not one", () => {
  assert.deepEqual(tokens("# the release workflow"), [["tok-comment", "# the release workflow"]]);
  assert.deepEqual(tokens("timeout: 30 # minutes"), [
    ["tok-type", "timeout"],
    ["tok-keyword", ":"],
    ["tok-number", "30"],
    ["tok-comment", "# minutes"],
  ]);
  // The case a line-local indexOf('#') gets wrong. A fragment in a URL is not a comment.
  assert.deepEqual(tokens('url: "https://example.test/#anchor"'), [
    ["tok-type", "url"],
    ["tok-keyword", ":"],
    ["tok-string", '"https://example.test/#anchor"'],
  ]);
  assert.deepEqual(classes("key: a#b"), ["tok-type", "tok-keyword", "tok-string"],
    "YAML starts a comment only at a `#` that follows whitespace");
});

test("a key keeps its value when the value itself holds a colon", () => {
  assert.deepEqual(tokens("url: http://example.test/path"), [
    ["tok-type", "url"],
    ["tok-keyword", ":"],
    ["tok-string", "http://example.test/path"],
  ]);
});

test("an anchor and an alias are told apart", () => {
  assert.deepEqual(tokens("base: &defaults"), [
    ["tok-type", "base"],
    ["tok-keyword", ":"],
    ["tok-anchor", "&defaults"],
  ]);
  assert.deepEqual(tokens("job: *defaults"), [
    ["tok-type", "job"],
    ["tok-keyword", ":"],
    ["tok-alias", "*defaults"],
  ]);
});

test("the document marker and the block scalar indicators are punctuation", () => {
  assert.deepEqual(tokens("---"), [["tok-keyword", "---"]]);
  assert.deepEqual(classes("run: |"), ["tok-type", "tok-keyword", "tok-keyword"]);
  assert.deepEqual(classes("script: >-"), ["tok-type", "tok-keyword", "tok-keyword"]);
});

test("a flow sequence keeps its punctuation plain and colours what is in it", () => {
  assert.deepEqual(tokens("branches: [main, develop]"), [
    ["tok-type", "branches"],
    ["tok-keyword", ":"],
    // The spaces travel with the punctuation, not inside a coloured span — a trailing space painted as a
    // scalar shows up as a yellow block the moment the line is selected.
    ["", " ["],
    ["tok-string", "main"],
    ["", ", "],
    ["tok-string", "develop"],
    ["", "]"],
  ]);
});

test("nothing is lost or invented: the tokens spell the line back", () => {
  for (const line of [
    "name: Release",
    "  - uses: actions/checkout@v4",
    "    with:",
    "      fetch-depth: 0",
    "on:",
    "  push:",
    "    branches: [main]",
    "env:",
    '  NODE_OPTIONS: "--max-old-space-size=4096"',
    "jobs: &base",
    "  build: *base",
    "timeout-minutes: 30 # generous",
    "---",
    "",
    "      ",
  ]) {
    const host = viewer.document.createElement("div");
    host.innerHTML = viewer.window.highlightLine(line, "yaml");
    assert.equal(host.textContent, line, `round-trips: ${JSON.stringify(line)}`);
  }
});

test("a `<` in a value cannot become markup", () => {
  const host = viewer.document.createElement("div");
  host.innerHTML = viewer.window.highlightLine('run: echo "<script>alert(1)</script>"', "yaml");
  assert.equal(host.querySelector("script"), null, "the value is escaped, not parsed");
  assert.match(host.textContent, /<script>alert\(1\)<\/script>/);
});
