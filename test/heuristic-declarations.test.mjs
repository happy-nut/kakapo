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

const RETURN_TYPE_METHODS = [
  ["src/Runner.cs", [
    "class Runner {",
    "  void Run(int which) {",
    "  }",
    "  public void RunAll(int count) {",
    "  }",
    "  private static async Task<int> FetchAsync(string url) {",
    "    return 0;",
    "  }",
    "  public IEnumerable<KeyValuePair<string, int>> Pairs(string[] keys) {",
    "    return null;",
    "  }",
    "  internal byte* Buffer(int size) {",
    "    return null;",
    "  }",
    "}",
  ].join("\n")],
  ["src/Activity.java", [
    "abstract class Activity {",
    "  public List<String> names(Map<String, Integer> counts) {",
    "    return null;",
    "  }",
    "  protected abstract void onCreate(Bundle savedInstanceState);",
    "}",
  ].join("\n")],
];

test("a method whose return type comes before its name is a declaration", async () => {
  const index = await scan(RETURN_TYPE_METHODS);
  assert.deepEqual(declaredLines(index, "Run"), [2], "`void Run(int which) {` declares Run");
  assert.deepEqual(declaredLines(index, "RunAll"), [4], "an access modifier may sit before the return type");
  assert.deepEqual(declaredLines(index, "FetchAsync"), [6], "and so may several, with a generic return type");
  assert.deepEqual(declaredLines(index, "Pairs"), [9], "a return type may hold a nested generic");
  assert.deepEqual(declaredLines(index, "Buffer"), [12], "and a pointer");
  assert.deepEqual(declaredLines(index, "names"), [2], "Java writes the same shape");
  assert.deepEqual(declaredLines(index, "onCreate"), [5],
    "an abstract method ends in a semicolon and is still a declaration");
});

test("a return type is not read as the declared name", async () => {
  const index = await scan(RETURN_TYPE_METHODS);
  for (const name of ["void", "Task", "List", "byte", "IEnumerable"]) {
    assert.deepEqual(declaredLines(index, name), [],
      `${name} is a return type on these lines, not the name being declared`);
  }
});

const RETURN_TYPE_CALLS = [
  ["src/Startup.cs", [
    "class Startup {",
    "  void Configure() {",
    "    Register(handlers, options);",
    "    return Build(services) ;",
    "    throw new InvalidOperationException(message);",
    "  }",
    "}",
  ].join("\n")],
  ["src/StoreTest.java", [
    "class StoreTest {",
    "  void check() {",
    "    assertThat(result).isEqualTo(3);",
    "    assert matches(result);",
    "    Widget widget = build(spec);",
    "  }",
    "}",
  ].join("\n")],
  ["src/Resize.h", [
    "typedef NS_ENUM(NSInteger, ResizeMode) {",
    "  ResizeModeCover = 1,",
    "};",
  ].join("\n")],
  ["src/session.cpp", [
    "Task<void> drain() {",
    "  co_await flush(buffer);",
    "  co_yield next(item);",
    "  co_return build(result);",
    "}",
    "void bump() {",
    "  emit valueChanged(next);",
    "}",
  ].join("\n")],
  ["src/concept.h", [
    "template <typename T>",
    "concept Sized = requires requires(T a) { a.size(); };",
  ].join("\n")],
];

test("a call is not a declaration even where a return type may precede a name", async () => {
  const index = await scan(RETURN_TYPE_CALLS);
  for (const name of ["Register", "Build", "InvalidOperationException", "assertThat", "isEqualTo", "matches", "build"]) {
    assert.deepEqual(declaredLines(index, name), [],
      `${name} is called on these lines and declared on none of them`);
  }
  assert.deepEqual(declaredLines(index, "NS_ENUM"), [],
    "a macro header has the same shape as a method and declares nothing of that name");
  for (const [name, statement] of [["flush", "co_await"], ["next", "co_yield"], ["build", "co_return"], ["valueChanged", "emit"]]) {
    assert.deepEqual(declaredLines(index, name), [],
      `${statement} is a statement keyword, so ${name} is called on that line and declared on none`);
  }
  assert.deepEqual(declaredLines(index, "requires"), [],
    "`requires requires(T a) {` is a requires-expression and declares nothing of that name");
  assert.deepEqual(declaredLines(index, "drain"), [1], "the coroutine around those statements is still found");
  assert.deepEqual(declaredLines(index, "bump"), [6], "and so is the method that emits");
  assert.deepEqual(declaredLines(index, "Configure"), [2], "the method around those calls is still found");
  assert.deepEqual(declaredLines(index, "check"), [2], "and so is the one in the Java file");
});

test("a return type before a name is read only where a language writes one", async () => {
  const shape = ["function wrap() {", "  void bootWindow(state, themeLight);", "}"].join("\n");
  const javascript = await scan([["src/boot.ts", shape]]);
  assert.deepEqual(declaredLines(javascript, "bootWindow"), [],
    "`void expr` is an operator in TypeScript, so this line is a call and not a declaration");
  const csharp = await scan([["src/Boot.cs", shape]]);
  assert.deepEqual(declaredLines(csharp, "bootWindow"), [2],
    "the same text in C# is the one shape this pattern exists to read");
});

test("a statement keyword followed by a parenthesised expression is not a method of that name", async () => {
  const index = await scan([
    ["src/Svc.java", [
      "class Svc {",
      "  Svc(int seed) { this.seed = seed; }",
      "  void run() {",
      "    synchronized (lock) { work(); }",
      "  }",
      "}",
    ].join("\n")],
    ["src/Gate.cs", [
      "class Gate {",
      "  void Run() {",
      "    lock (gate) { Work(); }",
      "    fixed (byte* p = bytes) { Use(p); }",
      "    using (var s = stream) { Read(s); }",
      "    foreach (var x in items) { Use(x); }",
      "  }",
      "}",
    ].join("\n")],
  ]);
  for (const keyword of ["synchronized", "lock", "fixed", "using", "foreach"]) {
    assert.deepEqual(declaredLines(index, keyword), [],
      `${keyword} heads a statement here and declares nothing`);
  }
  assert.deepEqual(declaredLines(index, "Svc"), [1, 2], "the class and its constructor are still found");
  assert.deepEqual(declaredLines(index, "run"), [3], "the method around the statement is still found");
  assert.deepEqual(declaredLines(index, "Run"), [2], "and so is the C# one");
});

test("the statement guard reaches only the languages whose statements those are", async () => {
  const index = await scan([
    ["src/Mutex.ts", [
      "class Mutex {",
      "  lock(resource) {",
      "    return resource;",
      "  }",
      "  synchronized(fn) { return fn(); }",
      "}",
    ].join("\n")],
    ["src/pool.js", ["const lock = new Mutex();", "let fixed = 1;"].join("\n")],
  ]);
  assert.deepEqual(declaredLines(index, "lock"), [1, 2],
    "a TypeScript method named lock is a method, and a variable named lock is a variable");
  assert.deepEqual(declaredLines(index, "synchronized"), [5],
    "nothing in TypeScript makes synchronized a statement head");
  assert.deepEqual(declaredLines(index, "fixed"), [2], "nor fixed in JavaScript");
});
