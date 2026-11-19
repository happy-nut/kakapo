import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/shapes.ts";
const LINES = [
  "export class Circle {",
  '  readonly name = "circle";',
  "  area(precision: number): number {",
  "    return precision;",
  "  }",
  "}",
];

function tokenAt(lineIndex, word, type) {
  const column = LINES[lineIndex].indexOf(word);
  assert.ok(column >= 0, `${word} is on line ${lineIndex}`);
  return { lineIndex, startColumn: column, length: word.length, type };
}
const TOKENS = [
  tokenAt(0, "Circle", "class"),
  tokenAt(1, "name", "property"),
  tokenAt(2, "area", "member"),
  tokenAt(2, "precision", "parameter"),
  tokenAt(3, "precision", "parameter"),
];

test("the fixture answers the way typescript-language-server does: identifiers only", () => {
  const kinds = new Set(TOKENS.map((token) => token.type));
  for (const absent of ["keyword", "string", "comment", "number"]) {
    assert.ok(!kinds.has(absent),
      `the server's legend has no ${absent}, so a view that treats these tokens as the whole answer loses it`);
  }
});

const WAS = [
  "export class Circle {",
  '  readonly name = "square";',
  "  area(p: number): number {",
  "    return p;",
  "  }",
  "}",
];

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: `${WAS.join("\n")}\n`, after: `${LINES.join("\n")}\n` },
  ], { app: true }));
});
after(cleanupFixtures);

async function viewer(tokens = TOKENS) {
  return await loadViewer(html, {
    analysisBridge: (request) => (request.kind === "semanticTokens"
      ? { ok: true, engine: "lsp", confidence: "semantic", locations: [], tokens }
      : { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
    eagerIntersections: true,
  });
}

function classesIn(root) {
  const out = new Map();
  for (const span of root.querySelectorAll("[class]")) {
    const name = typeof span.className === "string" ? span.className : "";
    if (!/(^|\s)tok(mod)?-/.test(name)) continue;
    const own = Array.from(span.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("");
    if (!out.has(own)) out.set(own, name);
  }
  return out;
}

async function sourceRows(v) {
  v.window.openSourceFile(FILE);
  await v.settle(60);
  v.window.openSourceFile(FILE);
  await v.settle(60);
  return (index) => v.$(`.source-row[data-line-index="${index}"] .source-code`);
}

test("a semantic token does not cost the line the colours the lexer gave it", async () => {
  const v = await viewer();
  const row = await sourceRows(v);
  const first = classesIn(row(0));
  assert.equal(first.get("Circle"), "tok-type", "the server's answer is painted");
  assert.equal(first.get("class"), "tok-keyword", "and `class` keeps the keyword colour the lexer gave it");
  assert.equal(first.get("export"), "tok-keyword", "…as does `export`");

  const second = classesIn(row(1));
  assert.equal(second.get("name"), "tok-property", "the property is the server's answer");
  assert.equal(second.get('"circle"'), "tok-string", "and the string literal is still a string");
  v.close();
});

test("the two painters together spell the line back, adding and losing nothing", async () => {
  const v = await viewer();
  const row = await sourceRows(v);
  for (let index = 0; index < LINES.length; index += 1) {
    assert.equal(v.window.sourceCellText(row(index)), LINES[index], `line ${index} reads as itself`);
  }
  v.close();
});

function diffWrapper(v) {
  const wrapper = v.window.diffWrapperByPath(FILE);
  assert.ok(wrapper, "the diff has a wrapper for the file");
  v.window.ensureFileReady(wrapper);
  return wrapper;
}

async function settledDiff(v) {
  const wrapper = diffWrapper(v);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await v.settle(25);
    if (wrapper.querySelector(".d2h-code-line-ctn .tok-parameter")) return wrapper;
  }
  return wrapper;
}

function rowShapes(wrapper) {
  return Array.from(wrapper.querySelectorAll(".d2h-code-line-ctn")).map((ctn) => ({
    text: ctn.textContent,
    hljs: ctn.querySelectorAll('[class*="hljs-"]').length,
    marks: ctn.querySelectorAll("ins, del, .ws-lead, .ws-trail").length,
  }));
}

test("the diff view paints what the server said about the changed lines", async () => {
  const v = await viewer();
  const wrapper = await settledDiff(v);
  const painted = classesIn(wrapper);
  assert.equal(painted.get("name"), "tok-property", "a property in the diff reads as a property");
  assert.equal(painted.get("precision"), "tok-parameter", "a parameter reads as a parameter");
  assert.equal(painted.get("area"), "tok-method", "a method reads as a method");
  v.close();
});

test("painting the diff keeps the markup diff2html and highlight.js already put there", async () => {
  const unpainted = await viewer([]);
  const before = rowShapes(await settledDiff(unpainted));
  assert.ok(before.some((entry) => entry.hljs > 0), "highlight.js painted the diff before we touched it");
  assert.ok(before.some((entry) => entry.marks > 0), "diff2html marked whitespace or a word-level change");

  const v = await viewer();
  const wrapper = await settledDiff(v);
  assert.ok(wrapper.querySelector(".d2h-code-line-ctn .tok-parameter"), "this run did paint the rows");
  const now = rowShapes(wrapper);
  assert.equal(now.length, before.length, "no row was added or dropped");
  now.forEach((shape, index) => {
    assert.equal(shape.text, before[index].text, `row ${index} still reads as itself`);
    assert.equal(shape.hljs, before[index].hljs, `row ${index} kept every highlight.js span`);
    assert.equal(shape.marks, before[index].marks,
      `row ${index} kept every word-level change mark and whitespace mark`);
  });
  unpainted.close();
  v.close();
});

test("a second pass over the same rows does not paint them twice", async () => {
  const v = await viewer();
  const wrapper = await settledDiff(v);
  const count = () => wrapper.querySelectorAll(".d2h-code-line-ctn .tok-parameter").length;
  const once = count();
  assert.ok(once > 0, "the first pass painted parameters");
  v.window.repaintDiffSemanticTokens(FILE);
  v.window.repaintDiffSemanticTokens(FILE);
  await v.settle(40);
  assert.equal(count(), once, "the rows carry the same spans, not a second copy of them");
  v.close();
});

function sideRows(v, wrapper, side) {
  const pairs = v.window.diffSideRowPairs(wrapper);
  return side === "old" ? pairs.oldRows : pairs.newRows;
}

test("an unchanged line on the left is painted from its twin on the right", async () => {
  const v = await viewer();
  const wrapper = await settledDiff(v);
  const left = sideRows(v, wrapper, "old")
    .map((row) => v.window.diffCellCtn(row))
    .filter(Boolean)
    .find((ctn) => (ctn.textContent || "").includes("class Circle"));
  assert.ok(left, "the left side shows the unchanged class line");
  assert.equal(classesIn(left).get("Circle"), "tok-type",
    "the same text at the same place on both sides is the same symbol");
  v.close();
});

test("a line the right side changed is not painted with the right side's columns", async () => {
  const v = await viewer();
  const wrapper = await settledDiff(v);
  const changed = sideRows(v, wrapper, "old")
    .map((row) => v.window.diffCellCtn(row))
    .filter(Boolean)
    .find((ctn) => (ctn.textContent || "").includes("area(p:"));
  assert.ok(changed, "the left side still shows the old signature");
  assert.equal(changed.querySelectorAll('[class*="tok-"]').length, 0,
    "nothing the server said about the new line may be placed on the old one");
  v.close();
});

test("a wrapper that arrives after the tokens is painted from what is already known", async () => {
  const v = await viewer();
  const wrapper = v.window.diffWrapperByPath(FILE);
  await settledDiff(v);
  const asked = [];
  v.window.kakapoAnalysis.query = (request) => { asked.push(request.kind); return Promise.resolve(null); };
  for (const ctn of wrapper.querySelectorAll(".d2h-code-line-ctn")) {
    delete ctn.dataset.semanticPainted;
    for (const span of ctn.querySelectorAll('[class*="tok-"]')) {
      span.replaceWith(v.document.createTextNode(span.textContent));
    }
  }
  assert.equal(wrapper.querySelectorAll('.d2h-code-line-ctn [class*="tok-"]').length, 0, "the rows start bare");
  v.window.annotateDiffHunkRows(wrapper);
  assert.ok(wrapper.querySelector(".d2h-code-line-ctn .tok-parameter"),
    "annotating the rows paints them without asking the server again");
  assert.deepEqual(asked, [], "and it asked nothing");
  v.close();
});
