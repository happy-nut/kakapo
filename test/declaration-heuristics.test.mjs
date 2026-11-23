import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DECLARATION_HEURISTICS } from "../dist/declaration-heuristics.js";
import { isStatementHead, buildRegexSymbolIndex } from "../dist/analysis-index.js";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(() => cleanupFixtures());

const root = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

// The two turns at the same question, one per process.
const INDEX = "src/analysis-index.ts";
const RENDERER = "src/viewer/15-semantic-navigation.js";
const OWNER = "src/declaration-heuristics.ts";

// A word from each fact that appears nowhere else in this repository, so a hit is a second spelling and
// not an unrelated list that happens to share an extension.
const SPELLINGS = {
  "the refused-name list": "instanceof",
  "the not-a-type prefix guard": "co_await",
  "a statement head": "unchecked",
};

test("the owner holds every one of these spellings, so an absence below means something", () => {
  const owner = read(OWNER);
  for (const [fact, word] of Object.entries(SPELLINGS)) {
    assert.ok(owner.includes(word), `${OWNER} does not spell ${word} (${fact}), so this reader is looking at `
      + "the wrong file and the assertions below cannot fail for the right reason");
  }
});

test("neither turn spells the heuristic a second time", () => {
  const copies = [];
  for (const file of [INDEX, RENDERER]) {
    const source = read(file);
    for (const [fact, word] of Object.entries(SPELLINGS)) {
      if (source.includes(word)) copies.push(`${file} spells ${word} (${fact})`);
    }
  }
  assert.deepEqual(copies, [], "the regex guess that answers Cmd+B is asked once per process, and a second "
    + "spelling makes one turn disagree with the other silently — the renderer's turn arrives as a jump "
    + `rather than a list. Read it from DECLARATION_HEURISTICS in ${OWNER} instead.`);
});

test("both turns answer the same about statement heads and return-type languages", async () => {
  const { html } = await makeReviewHtml([{ path: "src/a.ts", before: "export const a = 0;\n", after: "export const a = 1;\n" }]);
  const viewer = await loadViewer(html);
  const window = viewer.window;
  assert.equal(typeof window.isStatementHeadInFile, "function",
    "the renderer's reader is not on window, so this test would be measuring nothing");

  const heads = [
    ["src/A.java", "synchronized", true],
    ["src/A.java", "lock", false],
    ["src/A.cs", "foreach", true],
    ["src/A.cs", "synchronized", false],
    ["src/a.ts", "lock", false],
    ["src/A.kt", "synchronized", true],
  ];
  assert.equal(heads.filter(([, , expected]) => expected).length, 3,
    "the cases must include real refusals, or both readers pass by refusing nothing");
  for (const [path, name, expected] of heads) {
    assert.equal(isStatementHead(path.slice(path.lastIndexOf(".")), name), expected, `the index on ${path} ${name}`);
    assert.equal(window.isStatementHeadInFile(path, name), expected, `the renderer on ${path} ${name}`);
  }

  // The extension lists cannot be told apart by spelling — every word in them is an ordinary extension that
  // other lists also hold — so they are compared by what they accept.
  const scoped = window.RETURN_TYPE_BEFORE_NAME_EXTENSIONS;
  assert.ok(scoped instanceof window.RegExp || scoped instanceof RegExp, "the renderer exposes no scoping regex");
  for (const extension of DECLARATION_HEURISTICS.returnTypeExtensions) {
    assert.ok(scoped.test(`src/File${extension}`), `the renderer refuses ${extension}, which the index scopes to`);
  }
  for (const extension of [".ts", ".js", ".kt", ".py", ".go", ".rs", ".rb"]) {
    assert.ok(!scoped.test(`src/File${extension}`), `the renderer reads a return type in ${extension}, where a `
      + "leading identifier is the void operator applied to a call rather than a method's type");
  }
});

test("the index keeps the records the statement-head refusal is scoped to protect", () => {
  const index = buildRegexSymbolIndex([
    { path: "app.ts", content: "function lock(resource) {\n  return resource;\n}\n" },
  ]);
  const names = index.definitions ? [...index.definitions.keys()] : [];
  assert.ok(names.includes("lock"), "a TypeScript lock() is a declaration; only .cs and .java refuse that "
    + `name. Found: ${JSON.stringify(names)}`);
  assert.deepEqual([...new Set(DECLARATION_HEURISTICS.statementHeads.flatMap((head) => head.extensions))].sort(),
    [".cs", ".java", ".kt"], "a statement head added outside those languages throws away real declarations");
});
