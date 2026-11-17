import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let viewer;
before(async () => {
  const { html } = await makeReviewHtml([
    { path: ".github/workflows/release.yml", before: "name: Old\n", after: "name: Release\n" },
  ]);
  viewer = await loadViewer(html);
});
after(() => { viewer?.close(); return cleanupFixtures(); });

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
