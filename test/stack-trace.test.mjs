import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const ORACLE = JSON.parse(readFileSync(new URL("./fixtures/stack-trace-oracle.json", import.meta.url), "utf8"));
const SAMPLES = JSON.parse(readFileSync(new URL("./fixtures/stack-trace-samples.json", import.meta.url), "utf8"));
const DIR = "/tmp/kakapo-sample";

const FILES = [
  { path: "src/main/java/com/foo/Bar.java", before: "", after: "package com.foo;\n\nclass Bar {\n  void baz() {\n    throw new RuntimeException(\"boom\");\n  }\n}\n" },
  { path: "src/main/java/com/qux/Bar.java", before: "", after: "package com.qux;\n\nclass Bar {\n}\n" },
  { path: "src/app/handler.ts", before: "", after: "export function handle() {\n  return 1;\n}\n" },
  { path: "lib/vendor/handler.ts", before: "", after: "export const vendored = true;\n" },
  { path: "src/aaa/Dup.java", before: "", after: "class Dup {}\n" },
  { path: "src/bbb/Dup.java", before: "class Dup {}\n", after: "class Dup {}\n" },
];

let html;
let shared;
before(async () => {
  ({ html } = await makeReviewHtml(FILES));
  shared = await loadViewer(html);
});
after(() => {
  shared.close();
  cleanupFixtures();
});

const sampleText = (runtime) => {
  const sample = SAMPLES.find((one) => one.runtime === runtime);
  assert.ok(sample && sample.text, `the capture fixture carries ${runtime} — run npm run stack:samples`);
  return sample.text.replaceAll("<DIR>", DIR);
};
const framesOf = (window, text) => Array.from(window.parseStackTrace(text)).filter((one) => one.kind === "frame");
const proseOf = (window, text) => Array.from(window.parseStackTrace(text)).filter((one) => one.kind === "text").map((one) => one.text);
const located = (frames) => Array.from(frames).map((one) => `${one.fileName}:${one.line}`);
const frameCount = (window, text) => Array.from(window.readStackTraceLines(text)).filter((one) => one.kind === "frame").length;

test("the JVM reader answers IntelliJ's own corpus exactly as IntelliJ does", () => {
  const w = shared.window;
  const frames = ORACLE.filter((row) => row.frame).length;
  assert.ok(frames >= 30, `the fixture carries frames to recognise (${frames})`);
  assert.ok(ORACLE.length - frames >= 20, `and lines that are not frames (${ORACLE.length - frames})`);

  const mismatches = [];
  for (const row of ORACLE) {
    const got = w.parseJvmStackLine(row.line);
    const want = row.frame
      ? { frame: true, fileName: row.fileName, line: row.lineNumber, classFqn: row.classFqn.text, method: row.method.text }
      : { frame: false };
    const mine = got
      ? { frame: true, fileName: got.fileName, line: got.line, classFqn: got.classFqn, method: got.method }
      : { frame: false };
    if (JSON.stringify(want) !== JSON.stringify(mine)) {
      mismatches.push(`${JSON.stringify(row.line)}\n    IntelliJ ${JSON.stringify(want)}\n    kakapo   ${JSON.stringify(mine)}`);
    }
  }
  assert.deepEqual(mismatches, [], `the port disagrees with the parser it is a port of:\n  ${mismatches.join("\n  ")}`);
});

test("the readers are tried in one order, and v8 before jvm is what keeps a node frame off the wrong line", () => {
  const w = shared.window;
  assert.equal(Array.from(w.STACK_TRACE_READERS).map((one) => one.name).join(" "),
    "v8 jvm python go ruby rust dotnet",
    "the table's order is the feature's behaviour, not an accident of declaration");

  const line = "\tat Object.foo (/p/a.js:1:2)";
  const jvm = w.parseJvmStackLine(line);
  assert.equal(jvm.fileName, "/p/a.js:1", "IntelliJ's reader claims this line and reads the column as the line");
  assert.equal(jvm.line, 2);

  const chosen = framesOf(w, line)[0];
  assert.equal(chosen.reader, "v8", "so the v8 reader has to get there first");
  assert.equal(chosen.fileName, "/p/a.js");
  assert.equal(chosen.line, 1);
  assert.equal(chosen.column, 2);
});

test("a frame can name no line at all, and :0 is a line rather than that absence", () => {
  const w = shared.window;
  const ordinary = framesOf(w, "\tat com.foo.Bar.baz(Bar.java:42)")[0];
  assert.equal(ordinary.line, 42, "the case that works, asserted before the two that name nothing");

  for (const text of ["\tat com.foo.Bar.baz(Native Method)", "\tat com.foo.Bar.baz(Unknown Source)"]) {
    const frame = framesOf(w, text)[0];
    assert.ok(frame, `${text} is still a frame — it renders`);
    assert.equal(frame.fileName, null, "with no file");
    assert.equal(frame.line, -1, "and -1 for 'this frame names no line'");
    assert.equal(w.resolveStackFrame(frame), null, "so it cannot be opened");
  }

  const zero = framesOf(w, "\tat com.foo.Bar.baz(Bar.java:0)")[0];
  assert.equal(zero.line, 0, ":0 is an ordinary line number, not the sentinel");
  assert.equal(w.resolveStackFrame(zero).lineIndex, 0, "and it still resolves, clamped to the first line");

  const module = framesOf(w, "\tat java.base@17/java.util.ArrayList.get(ArrayList.java:427)")[0];
  assert.equal(module.classFqn, "java.util.ArrayList", "the module prefix is not part of the class");
  assert.equal(module.fileName, "ArrayList.java");
  assert.equal(module.line, 427);
});

test("node's own crash: the bare first line is a frame, <anonymous> is not", () => {
  const w = shared.window;
  const text = sampleText("node");
  const frames = framesOf(w, text);
  assert.deepEqual(located(frames), [
    `${DIR}/lib/inner.js:1`,
    `${DIR}/lib/inner.js:1`,
    `${DIR}/lib/inner.js:1`,
    `${DIR}/lib/inner.js:1`,
    `${DIR}/app.js:2`,
    `${DIR}/app.js:2`,
    `${DIR}/app.js:3`,
    "node:internal/modules/cjs/loader:1781",
    "node:internal/modules/cjs/loader:1913",
    "node:internal/modules/cjs/loader:1505",
  ], "every frame node printed, including the throw site on the first line");
  assert.equal(frames[0].column, 0, "the first line carries no column, and that is not a missing line number");
  assert.equal(frames[1].column, 39, "the frames below it do");

  const prose = proseOf(w, text);
  assert.ok(prose.some((line) => line.includes("at Array.map (<anonymous>)")),
    `a frame with no file renders as prose:\n${prose.join("\n")}`);
  assert.ok(prose.some((line) => line.includes("function deep(n)")), "and so does the echoed source line");
  assert.ok(prose.some((line) => line.trim() === "Error: boom"), "and the message");
});

test("python's own crash: the File lines are frames, the echoed source and carets are not", () => {
  const w = shared.window;
  const text = sampleText("python");
  const frames = framesOf(w, text);
  assert.deepEqual(located(frames), [
    `${DIR}/main.py:8`, `${DIR}/main.py:5`, `${DIR}/pkg/inner.py:4`, `${DIR}/pkg/inner.py:4`, `${DIR}/pkg/inner.py:3`,
  ]);
  assert.equal(frames[0].method, "<module>", "the function python names is kept");
  const prose = proseOf(w, text);
  assert.ok(prose.some((line) => line.includes("~~~~~^^")), "the caret line is prose");
  assert.ok(prose.some((line) => line.includes("return deep(n - 1)")), "and so is the echoed source");
});

test("go's own crash: the offset is optional, so the inlined frames are not lost", () => {
  const w = shared.window;
  const text = sampleText("go");
  const frames = framesOf(w, text);
  assert.deepEqual(located(frames), [
    `${DIR}/inner/inner.go:5`, `${DIR}/inner/inner.go:7`, `${DIR}/inner/inner.go:7`, `${DIR}/main.go:5`, `${DIR}/main.go:7`,
  ], "five frames: two carry a +0x offset and three do not");
  assert.ok(frames.every((one) => one.reader === "go"),
    "and the go reader claims them — the v8 bare form is unindented on purpose, or it would claim these first");
  assert.ok(proseOf(w, text).some((line) => line.startsWith("sample/inner.Deep")), "the symbol line above each one is prose");
});

test("rust's own crash: the panic header is a frame and so is every at line below it", () => {
  const w = shared.window;
  const text = sampleText("rust");
  const frames = framesOf(w, text);
  assert.equal(frames[0].reader, "rust", "the header is read by the rust reader");
  assert.equal(frames[0].fileName, "main.rs", "a relative path, which the resolver's suffix matching has to carry");
  assert.equal(frames[0].line, 3);
  assert.equal(frames[0].column, 9);
  assert.equal(frames.length, 34, "the header plus every continuation line of a real 70-line backtrace");
  assert.ok(frames.slice(1).every((one) => one.reader === "v8"),
    "rust's continuation lines are the v8 shape, and are read by that reader rather than a copy of it");
  assert.deepEqual(located(frames.filter((one) => one.fileName.startsWith(DIR))),
    [`${DIR}/main.rs:3`, `${DIR}/main.rs:5`, `${DIR}/main.rs:5`, `${DIR}/main.rs:9`, `${DIR}/main.rs:13`],
    "the frames inside the crashing program, among the rustc-internal ones");
});

test("ruby's own crash: the first line and every from line are frames", () => {
  const w = shared.window;
  const text = sampleText("ruby");
  const frames = framesOf(w, text);
  assert.deepEqual(located(frames), [
    `${DIR}/lib/inner.rb:2`, `${DIR}/lib/inner.rb:3`, `${DIR}/lib/inner.rb:3`, "main.rb:4", "main.rb:7",
  ]);
  assert.equal(frames[0].method, "Object#deep", "the method ruby names is kept");
  assert.ok(proseOf(w, text).some((line) => line.includes("^^^^")), "the caret line is prose");
});

test("normalizing is kept only when it finds more frames than the text as pasted", () => {
  const w = shared.window;
  const wrapped = "java.lang.RuntimeException: boom at com.foo.Bar.baz(Bar.java:4) at com.foo.Bar.run(Bar.java:7)";
  assert.equal(framesOf(w, "\tat com.foo.Bar.baz(Bar.java:4)").length, 1, "one frame on its own line is one frame");
  assert.equal(frameCount(w, wrapped), 1,
    "mail wrapped the trace onto one line, and only the first frame survives that");
  assert.deepEqual(located(framesOf(w, wrapped)), ["Bar.java:4", "Bar.java:7"],
    "so the unwrapped reading is kept, because it finds more");

  const escaped = "java.lang.RuntimeException: boom\\n\\tat com.foo.Bar.baz(Bar.java:4)\\n\\tat com.foo.Bar.run(Bar.java:7)";
  assert.deepEqual(located(framesOf(w, escaped)), ["Bar.java:4", "Bar.java:7"],
    "and the same for a trace pasted with its newlines escaped");

  const rust = sampleText("rust");
  const raw = frameCount(w, rust);
  const normalized = frameCount(w, w.normalizeStackTraceText(rust));
  assert.equal(raw, 34, "rust's real backtrace, as printed");
  assert.equal(normalized, 33, "normalizing splits `panicked at main.rs:3:9:` in two and loses the panic site");
  assert.equal(framesOf(w, rust)[0].fileName, "main.rs", "so the text as pasted is what is kept, and the panic site keeps its link");
});

test("the resolver ranks by the class's package, then by what this review changed, then by the shortest path", () => {
  const w = shared.window;
  const resolve = (line) => {
    const frame = framesOf(w, line)[0];
    assert.ok(frame, `${line} is a frame`);
    return w.resolveStackFrame(frame);
  };

  assert.equal(resolve("\tat com.foo.Bar.baz(Bar.java:4)").path, "src/main/java/com/foo/Bar.java");
  assert.equal(resolve("\tat com.qux.Bar.baz(Bar.java:3)").path, "src/main/java/com/qux/Bar.java",
    "two files are called Bar.java, and the package in the class name is what tells them apart");
  assert.equal(resolve("\tat com.foo.Bar.baz(Bar.java:4)").lineIndex, 3, "the line number is 1-based, the index is not");

  assert.equal(resolve("\tat Dup.main(Dup.java:1)").path, "src/aaa/Dup.java",
    "with no package to go by, the file this review changed wins over the one it did not");

  const ambiguous = resolve("\tat com.zzz.Bar.baz(Bar.java:1)");
  assert.equal(ambiguous.ambiguous, 1, "neither Bar.java is in com/zzz, so the row is a guess and says so");
  assert.equal(resolve("\tat com.foo.Bar.baz(Bar.java:4)").ambiguous, 0, "and a ranked answer is not a guess");

  assert.equal(resolve("    at handle (/home/runner/work/repo/src/app/handler.ts:2:10)").path, "src/app/handler.ts",
    "a CI machine's absolute path reaches the file by its longest shared suffix");
  assert.equal(resolve("    at handle (/elsewhere/handler.ts:2:10)").path, "src/app/handler.ts",
    "and a path that shares only the name falls back to the same ranking");

  assert.equal(resolve("- com.foo.Bar.baz() @bci=12, line=4 (Compiled frame)").path, "src/main/java/com/foo/Bar.java",
    "a forced thread-dump frame names no file at all, and is reached through its class name");
});

test("a frame whose file is not in this project resolves to nothing, and its row names the file it looked for", async () => {
  const v = await loadViewer(html);
  try {
    const w = v.window;
    const frame = framesOf(w, "\tat com.foo.Missing.gone(Missing.java:7)")[0];
    assert.ok(frame, "the line is a frame");
    assert.equal(w.resolveStackFrame(frame), null, "and resolves to nothing");

    w.openStackTracePanel();
    v.typeInto(v.$("#stack-trace-input"), "\tat com.foo.Bar.baz(Bar.java:4)\n\tat com.foo.Missing.gone(Missing.java:7)\n");
    await v.settle(200);

    const notes = v.$all("#stack-trace-results .stack-missing").map((row) => row.textContent);
    assert.equal(notes.length, 1, "one of the two frames could not be placed");
    assert.match(notes[0], /Missing\.java/, `and the row says which file it looked for: ${notes[0]}`);
  } finally {
    v.close();
  }
});

test("the panel lists the frames of a pasted trace and opening a row lands the caret on that line", async () => {
  const v = await loadViewer(html);
  try {
    const w = v.window;
    v.key("s", { metaKey: true, shiftKey: true, code: "KeyS" });
    await v.settle(30);
    assert.ok(!v.$("#stack-trace").classList.contains("hidden"), "the chord opened the panel");
    assert.equal(v.document.activeElement.id, "stack-trace-input", "with the caret in the textarea");

    v.typeInto(v.$("#stack-trace-input"), [
      "java.lang.RuntimeException: boom",
      "\tat com.foo.Bar.baz(Bar.java:4)",
      "\tat com.foo.Missing.gone(Missing.java:7)",
      "",
    ].join("\n"));
    await v.settle(200);

    assert.deepEqual(v.$all("#stack-trace-results .stack-prose").map((row) => row.textContent.trim()),
      ["java.lang.RuntimeException: boom"], "the message renders as prose rather than being dropped");
    const rows = v.$all("#stack-trace-results .stack-item");
    assert.equal(rows.length, 1, "one of the two frames is a file this review can open");
    assert.match(rows[0].textContent, /src\/main\/java\/com\/foo\/Bar\.java:4/, "and the row shows the repo-relative path");
    assert.match(v.$("#stack-trace-summary").textContent, /2/, "the summary counts the frames it read");

    const opened = [];
    const real = w.openSourceAt;
    w.openSourceAt = (path, lineIndex, column) => { opened.push([path, lineIndex, column]); return real(path, lineIndex, column); };
    v.click(rows[0]);
    await v.settle(120);
    assert.deepEqual(opened, [["src/main/java/com/foo/Bar.java", 3, 0]],
      "clicking the row opens the file through the one reader for 'open this file here'");
    assert.ok(v.$("#stack-trace").classList.contains("hidden"), "and the panel closes behind it");
    assert.equal(v.caretLine(), 4, "the caret is on the line the frame named, not on the file's first line");
  } finally {
    v.close();
  }
});

test("the keyboard walks the rows, Cmd+Enter takes the first one, and Esc gives the keyboard back", async () => {
  const v = await loadViewer(html);
  try {
    const w = v.window;
    const opener = v.$("#compare-pill") || v.$("button");
    opener.focus();
    w.openStackTracePanel();
    v.typeInto(v.$("#stack-trace-input"), [
      "\tat com.foo.Missing.gone(Missing.java:7)",
      "\tat com.foo.Bar.baz(Bar.java:4)",
      "\tat com.qux.Bar.baz(Bar.java:3)",
      "",
    ].join("\n"));
    await v.settle(200);
    assert.equal(v.$all("#stack-trace-results .stack-item").length, 2, "two of the three frames can be opened");

    v.key("ArrowDown");
    await v.settle(20);
    let active = v.$("#stack-trace-results .stack-item.active");
    assert.match(active.textContent, /com\/foo\/Bar\.java:4/, "the first openable row, not the first row");
    v.key("ArrowDown");
    await v.settle(20);
    active = v.$("#stack-trace-results .stack-item.active");
    assert.match(active.textContent, /com\/qux\/Bar\.java:3/, "and the next one");

    const opened = [];
    w.openSourceAt = (path, lineIndex) => { opened.push(`${path}:${lineIndex + 1}`); };
    v.key("Enter");
    await v.settle(20);
    assert.deepEqual(opened, ["src/main/java/com/qux/Bar.java:3"], "Enter opens the selected row");

    w.openStackTracePanel();
    await v.settle(20);
    v.key("Enter", { metaKey: true });
    await v.settle(20);
    assert.deepEqual(opened.slice(1), ["src/main/java/com/foo/Bar.java:4"],
      "Cmd+Enter takes the first frame that resolves — where did it blow up");

    opener.focus();
    w.openStackTracePanel();
    await v.settle(20);
    v.key("Escape");
    await v.settle(20);
    assert.ok(v.$("#stack-trace").classList.contains("hidden"), "Esc closed it");
    assert.equal(v.document.activeElement, opener, "and the keyboard went back to whatever opened it");
  } finally {
    v.close();
  }
});

test("the panel prefills from the clipboard, but only a trace, and never over text already typed", async () => {
  const v = await loadViewer(html);
  try {
    const w = v.window;
    let clipboard = "the weather today";
    w.kakapoClipboard = { read: () => clipboard, write: () => {} };

    w.openStackTracePanel();
    assert.equal(v.$("#stack-trace-input").value, "", "prose on the clipboard is not a stack trace and is not pasted in");
    w.closeStackTrace();

    clipboard = "java.lang.RuntimeException: boom\n\tat com.foo.Bar.baz(Bar.java:4)\n";
    w.openStackTracePanel();
    await v.settle(20);
    assert.equal(v.$("#stack-trace-input").value, clipboard, "a trace on the clipboard is what the panel is for");
    assert.equal(v.$all("#stack-trace-results .stack-item").length, 1, "and it is read on open, with no button to press");
    w.closeStackTrace();

    v.typeInto(v.$("#stack-trace-input"), "\tat com.qux.Bar.baz(Bar.java:3)");
    clipboard = "java.lang.RuntimeException: other\n\tat com.foo.Bar.baz(Bar.java:4)\n";
    w.openStackTracePanel();
    assert.equal(v.$("#stack-trace-input").value, "\tat com.qux.Bar.baz(Bar.java:3)",
      "what the reader typed outranks what is on the clipboard");
  } finally {
    v.close();
  }
});
