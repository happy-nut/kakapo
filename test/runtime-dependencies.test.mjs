import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The CLI carries a runtime dependency only for a validation or review reason, and the reason is here
// rather than in prose that cannot be checked. "The CLI should have no runtime dependencies" stood in
// AGENTS.md while seven were declared, which is a convention nobody could have followed.
const DECLARED = {
  "@vscode/ripgrep": "project search is ripgrep; reimplementing it in node is slower by orders of magnitude",
  "diff2html": "the diff's own rendering, and the only place a hunk becomes rows",
  "electron": "the window itself — this is a desktop app, not a server",
  "highlight.js": "the diff view's spelling-only highlighter, layered under the server's semantic tokens",
  "pyright": "a bundled language server, pinned so a review's navigation does not depend on the user's python",
  "typescript": "tsc builds this repository, and typescript-language-server loads its tsserver at runtime",
  "typescript-language-server": "a bundled language server, same pinning reason as pyright",
};

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));

test("the manifest declares dependencies for this reader to read", () => {
  assert.ok(Object.keys(manifest.dependencies || {}).length >= 5,
    "package.json declares almost no dependencies, so this reader is looking at the wrong field");
});

test("every runtime dependency has a reason written down", () => {
  const unexplained = Object.keys(manifest.dependencies || {}).filter((name) => !DECLARED[name]);
  assert.deepEqual(unexplained, [], "a runtime dependency was added with no reason. The CLI takes one only "
    + "for a validation or review reason — write that reason in DECLARED in this test, or do without it.");
});

test("a dependency that was dropped does not keep its reason", () => {
  const stale = Object.keys(DECLARED).filter((name) => !(manifest.dependencies || {})[name]);
  assert.deepEqual(stale, [], "this list still explains a dependency the manifest no longer has.");
});

test("a bundled language server is pinned to an exact version", () => {
  const pinned = ["pyright", "@vscode/ripgrep", "electron"];
  const loose = pinned.filter((name) => !/^\d/.test(String(manifest.dependencies[name] || "")));
  assert.deepEqual(loose, [], "a review's navigation and search must not change under the user because a "
    + "caret range let a new version in.");
});
