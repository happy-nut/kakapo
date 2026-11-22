import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILES = [
  { path: "src/util.ts", before: "", after: ["export function formatBytes(n: number) {", "  return n + 'B';", "}", ""].join("\n") },
  { path: "src/render.ts", before: "", after: ["import { formatBytes } from './util';", "", "export function renderRow(n: number) {", "  return formatBytes(n);", "}", ""].join("\n") },
  { path: "src/page.ts", before: "", after: ["import { renderRow } from './render';", "", "export function renderPage() {", "  return renderRow(1);", "}", ""].join("\n") },
  { path: "src/boot.ts", before: "", after: ["import { renderPage } from './page';", "", "export function bootWindow() {", "  return renderPage();", "}", ""].join("\n") },
];

const CALLERS = {
  formatBytes: [{ path: "src/render.ts", lineIndex: 2, column: 16, name: "renderRow", text: "export function renderRow(n: number) {", callSites: [{ lineIndex: 3, column: 9 }] }],
  renderRow: [{ path: "src/page.ts", lineIndex: 2, column: 16, name: "renderPage", text: "export function renderPage() {", callSites: [{ lineIndex: 3, column: 9 }] }],
  renderPage: [{ path: "src/boot.ts", lineIndex: 2, column: 16, name: "bootWindow", text: "export function bootWindow() {", callSites: [{ lineIndex: 3, column: 9 }] }],
  bootWindow: [],
};

let html;
before(async () => { ({ html } = await makeReviewHtml(FILES, { app: true })); });
after(cleanupFixtures);

function bridge(request) {
  if (request.kind !== "callers") return null;
  return { ok: true, engine: "lsp", confidence: "semantic", locations: CALLERS[request.symbol] ?? [] };
}

async function openPeek(v) {
  v.window.openSemanticPeek("formatBytes", [
    { path: "src/page.ts", lineIndex: 3, column: 9, text: "  return renderRow(1);" },
    { path: "src/render.ts", lineIndex: 3, column: 9, text: "  return formatBytes(n);" },
  ], { ok: true, engine: "lsp", confidence: "semantic" }, "references");
  await v.settle(10);
}

const right = { key: "ArrowRight" };
const left = { key: "ArrowLeft" };

function press(v, init) {
  const event = new v.window.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  return v.window.handleSemanticPeekKey(event);
}

test("the popup is a flat list until the right arrow branches it into callers", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-item").length, 2, "two usages, listed flat");
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 0, "and no columns yet");

  assert.equal(press(v, right), true, "the right arrow is taken by the popup");
  await v.settle(10);
  const columns = v.$all("#semantic-peek-results .semantic-peek-col");
  assert.equal(columns.length, 2, "the symbol stands in the first column and its callers in the second");
  assert.match(columns[1].textContent, /renderRow/, "renderRow calls formatBytes");
  assert.match(columns[1].textContent, /render\.ts:4/, "and the row names the call site, line 4, not the declaration on line 3");
  v.close();
});

test("each step right adds a column and the trail names the way back", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);
  press(v, right);
  await v.settle(10);

  const columns = v.$all("#semantic-peek-results .semantic-peek-col");
  assert.equal(columns.length, 3, "formatBytes, its callers, and theirs");
  assert.match(columns[2].textContent, /renderPage/, "renderPage calls renderRow");
  assert.match(v.$("#semantic-peek-meta").textContent, /formatBytes ← renderRow/, "the trail says where the columns came from");

  press(v, right);
  await v.settle(10);
  press(v, right);
  await v.settle(10);
  assert.match(v.$all("#semantic-peek-results .semantic-peek-col").pop().textContent, /호출자 없음|No callers/,
    "nothing calls bootWindow, and the column says so rather than going blank");
  v.close();
});

test("the left arrow walks back out, and the last step returns the flat list", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);
  press(v, right);
  await v.settle(10);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 3);

  press(v, left);
  await v.settle(10);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 2, "one column goes back");

  press(v, left);
  await v.settle(10);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 0, "and the graph gives way to the list it came from");
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-item").length, 2, "the same two usages as before");
  v.close();
});

test("Enter in a column opens the call site, not the caller's declaration", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 2, "the graph is open, so Enter is the graph's Enter");
  assert.notEqual(v.window.sourceOpenPath(), "src/render.ts", "the view is on another file, so a wrong Enter shows as no move at all");
  press(v, { key: "Enter" });
  await v.settle(20);
  assert.equal(v.window.sourceOpenPath(), "src/render.ts");
  assert.deepEqual([v.window.caretSourceLoc().path, v.window.caretSourceLoc().lineIndex], ["src/render.ts", 3],
    "`return formatBytes(n)` is line index 3; renderRow is declared on 2");
  v.close();
});

test("the spine keeps the whole path once the columns stop fitting", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);
  press(v, right);
  await v.settle(10);
  press(v, right);
  await v.settle(10);

  const spine = v.$("#semantic-peek-results .semantic-peek-spine");
  assert.ok(spine, "the path stands in a spine of its own, not in a column that scrolls away");
  assert.deepEqual(
    Array.from(spine.querySelectorAll(".semantic-peek-node-name")).map((n) => n.textContent.trim()),
    ["formatBytes", "renderRow"],
    "three steps out, and the symbol the question started on is still on screen");
  const columns = v.$all("#semantic-peek-results .semantic-peek-col");
  assert.equal(columns.length, 3, "the spine plus the two newest columns");
  assert.match(columns[2].textContent, /bootWindow/, "and the newest column is the one just asked for");
  v.close();
});

test("a caller's row reads the line that makes the call, not the line it is declared on", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);

  const code = v.$("#semantic-peek-results .semantic-peek-col:not(.semantic-peek-spine) .semantic-peek-node-code");
  assert.ok(code, "every caller's row carries the code of its call site");
  assert.equal(code.textContent.trim(), "return formatBytes(n);",
    "renderRow is declared on line 3 and calls on line 4; the row reads line 4");
  v.close();
});

test("reopening the popup leaves no column from the symbol before it", async () => {
  const v = await loadViewer(html, { analysisBridge: bridge });
  await openPeek(v);
  press(v, right);
  await v.settle(10);
  assert.ok(v.$all("#semantic-peek-results .semantic-peek-col").length);

  await openPeek(v);
  assert.equal(v.$all("#semantic-peek-results .semantic-peek-col").length, 0, "a fresh question opens on its own answer");
  v.close();
});
