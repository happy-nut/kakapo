import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const viewerDir = join(fileURLToPath(new URL("..", import.meta.url)), "src", "viewer");
const slices = readdirSync(viewerDir).filter((name) => name.endsWith(".js"));
const source = new Map(slices.map((name) => [name, readFileSync(join(viewerDir, name), "utf8")]));

test("nothing the viewer paints is inserted into the code's own text", () => {
  const offenders = [];
  for (const [name, text] of source) {
    text.split("\n").forEach((line, index) => {
      if (/\.insertNode\s*\(/.test(line)) offenders.push(`${name}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    "splitting a line's text node moves where the browser wraps it — place the span with placeCaretSpan()");
});

test("the caret is painted by one function, for both views", () => {
  const painters = slices.filter((name) => /\bplaceCaretSpan\s*\(/.test(source.get(name)));
  assert.deepEqual(painters.sort(), ["01-core.js", "06-diff-caret.js", "10-source-view.js"],
    "the diff and the source view share the painter declared in 01-core.js");
  assert.match(source.get("01-core.js"), /function placeCaretSpan/, "which is where it is declared");
});

test("a caret that is placed is taken out of the text flow", () => {
  const css = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "src", "viewer.css"), "utf8");
  assert.match(css, /\.code-cursor-placed\s*\{[^}]*position:\s*absolute/,
    "an in-flow caret is a 2px inline box the line has to make room for");
  assert.match(css, /\.source-code\s*\{[^}]*position:\s*relative/,
    "and it is positioned against the cell it belongs to");
});

test("a wrapped line keeps its own indent", () => {
  const css = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "src", "viewer.css"), "utf8");
  assert.match(css, /line-wrap \.d2h-code-line-ctn\s*\{[^}]*padding-left:\s*var\(--wrap-indent/s,
    "a continuation that starts at the pane's edge reads as lost indentation");
  assert.match(css, /line-wrap \.d2h-code-line-ctn\s*\{[^}]*text-indent:\s*calc\(-1 \* var\(--wrap-indent/s,
    "and the first line is pulled back so only continuations are indented");
  assert.match(source.get("00-diff-layers.js"), /hangWrappedIndent/,
    "the per-row pass is what knows each line's indent");
});
