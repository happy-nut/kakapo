import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegexSymbolIndexChunked } from "../dist/analysis-index.js";

async function scan(files) {
  return await buildRegexSymbolIndexChunked(files.map(([path, content]) => ({ path, content })));
}

function declaredLines(index, name) {
  return (index.definitions.get(name) ?? []).map((record) => record.lineIndex + 1).sort((a, b) => a - b);
}

const CALLS = [
  ["test/suite.test.mjs", [
    'test("one thing", async () => {',
    "  const value = 1;",
    "});",
    'test("another thing", () => {',
    "  const other = 2;",
    "});",
  ].join("\n")],
  ["src/timers.js", [
    "function schedule() {",
    "  setTimeout(function () {",
    "    requestAnimationFrame(function () {",
    "      paint();",
    "    });",
    "  }, 0);",
    "}",
  ].join("\n")],
];

const DECLARATIONS = [
  ["src/shapes.ts", [
    "export class Circle {",
    "  radius = 1;",
    "  area(precision: number): number {",
    "    return this.radius * precision;",
    "  }",
    "  onResize(handler: (size: number) => void): void {",
    "    handler(this.radius);",
    "  }",
    "}",
  ].join("\n")],
  ["test/stub.test.mjs", [
    "const fs = {",
    "  existsSync(path) { return path === '/tmp'; },",
    "  spawnSync(command, args, options) { return { status: 0 }; },",
    "};",
  ].join("\n")],
  ["src/analysis-ish.ts", [
    "class Analysis {",
    "  constructor(readonly root: string, options: AnalysisOptions = {}) {",
    "    this.options = options;",
    "  }",
    '  private setStatus(phase: AnalysisPhase, details: Omit<Partial<AnalysisStatus>, "phase"> = {}): void {',
    "    this.status = phase;",
    "  }",
    "  key(name, mods = {}) {",
    "    return name;",
    "  }",
    "}",
  ].join("\n")],
];

test("a call whose last argument is a function is not a declaration of the thing being called", async () => {
  const index = await scan(CALLS);
  for (const name of ["test", "setTimeout", "requestAnimationFrame"]) {
    assert.deepEqual(declaredLines(index, name), [],
      `${name} is called here and declared nowhere, so the index must not offer a declaration of it`);
  }
  assert.deepEqual(declaredLines(index, "schedule"), [1], "the real declaration on the same file is still found");
});

test("a keyword is not a declared name", async () => {
  const index = await scan([
    ["src/callbacks.js", [
      "var pick = function () { return 1; };",
      "function make() {",
      "  return () => {",
      "    return 2;",
      "  };",
      "}",
    ].join("\n")],
  ]);
  assert.deepEqual(declaredLines(index, "function"), [], "`function () {` declares nothing named `function`");
  assert.deepEqual(declaredLines(index, "return"), [], "`return () => {` declares nothing named `return`");
  assert.deepEqual(declaredLines(index, "pick"), [1], "the variable it is assigned to is still found");
  assert.deepEqual(declaredLines(index, "make"), [2], "the function around it is still found");
});

test("`in` and `of` are ordinary identifiers, not keywords the guard may swallow", async () => {
  const index = await scan([
    ["test/windows.test.mjs", ["const of = (count) => count + 1;", "const inside = 2;", "let into = 3;"].join("\n")],
  ]);
  assert.deepEqual(declaredLines(index, "of"), [1],
    "a variable named `of` is declared here; the keyword guard must not reach valid identifiers");
});

test("a method is still a declaration, including one whose parameter is a function type", async () => {
  const index = await scan(DECLARATIONS);
  assert.deepEqual(declaredLines(index, "area"), [3], "a plain method is found");
  assert.deepEqual(declaredLines(index, "onResize"), [6],
    "a parameter may hold a parenthesis when it follows a colon, which is where a function type lives");
  assert.deepEqual(declaredLines(index, "existsSync"), [2], "a stub object really does declare a method of that name");
  assert.deepEqual(declaredLines(index, "spawnSync"), [3], "and so does the one beside it");
});

test("a brace in a parameter list is a default value or a generic, not an argument", async () => {
  const index = await scan(DECLARATIONS);
  assert.deepEqual(declaredLines(index, "constructor"), [2], "`options: AnalysisOptions = {}` is a parameter list");
  assert.deepEqual(declaredLines(index, "setStatus"), [5], "so is one holding a generic with a quoted type argument");
  assert.deepEqual(declaredLines(index, "key"), [8], "and so is `mods = {}`");
});

test("a method named for a type keyword keeps its own name", async () => {
  const index = await scan([
    ["src/registry.ts", ["class Registry {", "  type(value: string): string {", "    return value;", "  }", "}"].join("\n")],
  ]);
  assert.deepEqual(declaredLines(index, "type"), [2],
    "the name is read from the pattern's name group, not from a numbered one the parameter group would shift");
  assert.deepEqual(declaredLines(index, "value"), [], "the parameter is not the declared name");
});

test("the shape of the report: no name is declared twice on adjacent lines of one file", async () => {
  const index = await scan([...CALLS, ...DECLARATIONS, ["src/dock.js", [
    "var bridge = register(",
    "  function () { return locale; },",
    "  function (next) { applyLocale(next); });",
  ].join("\n")]]);
  const adjacent = [];
  for (const [name, records] of index.definitions) {
    const byFile = new Map();
    for (const record of records) {
      if (!byFile.has(record.path)) byFile.set(record.path, []);
      byFile.get(record.path).push(record.lineIndex);
    }
    for (const [path, lines] of byFile) {
      lines.sort((a, b) => a - b);
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i] - lines[i - 1] <= 1) adjacent.push(`${name} ${path}:${lines[i - 1] + 1},${lines[i] + 1}`);
      }
    }
  }
  assert.deepEqual(adjacent, [],
    "two declarations of one name on consecutive lines is what a call recorded as a declaration looks like");
});

test("a declaration is still found when the line holds a string the mask blanks out", async () => {
  const index = await scan([
    ["src/labels.ts", ['export const title = "a(b";', 'function greet(name: string) { return "hi(" + name; }'].join("\n")],
  ]);
  assert.deepEqual(declaredLines(index, "title"), [1], "a paren inside a string does not reach the parameter test");
  assert.deepEqual(declaredLines(index, "greet"), [2], "nor does one in the body");
});
