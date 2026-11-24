#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("call-graph");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }));
repo.put("src/util.ts", [
  "export function formatBytesForDisplay(bytes: number): string {",
  "  return `${bytes}B`;",
  "}",
  "",
].join("\n"));
repo.put("src/render.ts", [
  "import { formatBytesForDisplay } from './util';",
  "",
  "export function renderHttpResponseFileRow(size: number): string {",
  "  return formatBytesForDisplay(size);",
  "}",
  "",
  "export function renderImageCapabilityNote(size: number): string {",
  "  return formatBytesForDisplay(size) + ' image';",
  "}",
  "",
].join("\n"));
repo.put("src/page.ts", [
  "import { renderHttpResponseFileRow } from './render';",
  "",
  "export function renderResponsePage(size: number): string {",
  "  return renderHttpResponseFileRow(size);",
  "}",
  "",
].join("\n"));
repo.put("src/walk.ts", [
  "export function walkTree(depth: number): number {",
  "  if (depth <= 0) return 0;",
  "  return walkTree(depth - 1);",
  "}",
  "",
  ...Array.from({ length: 220 }, (_, i) => `export const pad${i} = ${i};`),
  "",
].join("\n"));
repo.put("src/tree.ts", [
  "import { walkTree } from './walk';",
  "",
  "export function countTree(depth: number): number {",
  "  return walkTree(depth);",
  "}",
  "",
].join("\n"));
repo.commit("initial");
repo.put("src/page.ts", [
  "import { renderHttpResponseFileRow } from './render';",
  "",
  "export function renderResponsePage(size: number): string {",
  "  return renderHttpResponseFileRow(size) + '!';",
  "}",
  "",
].join("\n"));

const columns = `Array.from(document.querySelectorAll('#semantic-peek-results .semantic-peek-col'))
  .map((c) => Array.from(c.querySelectorAll('.semantic-peek-node-name')).map((n) => n.textContent.trim()))`;
const trail = `(document.getElementById('semantic-peek-meta') || {}).textContent || ''`;
const spine = `Array.from(document.querySelectorAll('.semantic-peek-spine .semantic-peek-node-name')).map((n) => n.textContent.trim())`;
const code = `Array.from(document.querySelectorAll('.semantic-peek-col:not(.semantic-peek-spine) .semantic-peek-node-code')).map((n) => n.textContent.trim())`;

await drive("call-graph", repo, async (page, h) => {
  await page.evaluate(`openSourceFile('src/util.ts')`);
  await h.until(`sourceOpenPath() === 'src/util.ts'`);
  await h.until(`document.querySelectorAll('#source-body .source-row').length > 0`);

  await page.evaluate(`setSourceCursor('src/util.ts', 0, 16, true, -1)`);
  await page.key("b", "KeyB", 66, 4);
  const opened = await h.until(`!document.getElementById('semantic-peek').classList.contains('hidden')`, 20000);
  h.control(Boolean(opened), "⌘B opens the usages popup on formatBytesForDisplay");
  h.check(await page.evaluate(`document.querySelectorAll('#semantic-peek-results .semantic-peek-item').length`) > 0,
    "and it is a flat list of usages to begin with");
  await h.shot("1-usages-flat-list");

  await page.key("ArrowRight", "ArrowRight", 39, 0);
  await h.until(`document.querySelectorAll('#semantic-peek-results .semantic-peek-col').length >= 2`, 20000);
  const first = await page.evaluate(columns);
  h.check(first.length === 2, "→ branches the list into columns", JSON.stringify(first));
  h.check(JSON.stringify(first[1] || []).includes("renderHttpResponseFileRow"),
    "the second column holds the functions that call it", JSON.stringify(first[1]));
  const sites = await page.evaluate(code);
  h.check(sites.some((line) => line.includes("formatBytesForDisplay(size)")),
    "and each caller's row reads the line that makes the call, out of the file itself", JSON.stringify(sites));
  await h.shot("2-callers-column");

  await page.key("ArrowRight", "ArrowRight", 39, 0);
  await h.until(`document.querySelectorAll('#semantic-peek-results .semantic-peek-col').length >= 3`, 20000);
  const deeper = await page.evaluate(columns);
  h.check(deeper.length === 3, "and → again walks one more step out", JSON.stringify(deeper));
  h.check(String(await page.evaluate(trail)).includes("←"),
    "the trail names the way back", await page.evaluate(trail));
  const wire = await page.evaluate(`(() => {
    const path = document.querySelector('.semantic-peek-wires path');
    if (!path) return { drawn: 0 };
    const rgb = (text) => (String(text).match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c) => c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); })
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ink = rgb(getComputedStyle(path).stroke);
    const paper = rgb(getComputedStyle(document.getElementById('semantic-peek')).backgroundColor);
    const a = lum(ink), b = lum(paper);
    return { drawn: document.querySelectorAll('.semantic-peek-wires path').length,
             ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
  })()`);
  h.check(wire.drawn > 0 && wire.ratio >= 1.4,
    "the curves are drawn and can be told from the panel behind them",
    wire.drawn + " paths, contrast " + wire.ratio + ":1");
  const path = await page.evaluate(spine);
  h.check(path[0] === "formatBytesForDisplay",
    "the spine still holds the symbol the question started on", JSON.stringify(path));
  await h.shot("3-two-steps-out");

  await page.key("ArrowLeft", "ArrowLeft", 37, 0);
  await h.until(`document.querySelectorAll('#semantic-peek-results .semantic-peek-col').length === 2`);
  await page.key("ArrowLeft", "ArrowLeft", 37, 0);
  await h.until(`document.querySelectorAll('#semantic-peek-results .semantic-peek-col').length === 0`);
  h.check(await page.evaluate(`document.querySelectorAll('#semantic-peek-results .semantic-peek-item').length`) > 0,
    "← walks back out, and the last step gives back the list it came from");
  await h.shot("4-back-to-the-list");

  await page.evaluate(`openSourceFile('src/walk.ts')`);
  await h.until(`sourceOpenPath() === 'src/walk.ts'`);
  await h.until(`document.querySelectorAll('#source-body .source-row').length > 0`);
  await page.evaluate(`setSourceCursor('src/walk.ts', 0, 16, true, -1)`);
  await page.key("b", "KeyB", 66, 4);
  await h.until(`!document.getElementById('semantic-peek').classList.contains('hidden')`, 20000);
  await page.key("ArrowRight", "ArrowRight", 39, 0);
  await h.until(`document.querySelectorAll('#semantic-peek-results .semantic-peek-col').length >= 2`, 20000);
  const marks = await page.evaluate(`Array.from(document.querySelectorAll('.semantic-peek-col:not(.semantic-peek-spine) .semantic-peek-node'))
    .map((n) => ({ name: (n.querySelector('.semantic-peek-node-name') || {}).textContent, cycle: n.classList.contains('is-cycle'),
                   tag: (n.querySelector('.row-tag.is-cycle') || {}).textContent || '' }))`);
  const self = marks.find((m) => String(m.name || "").includes("walkTree"));
  const other = marks.find((m) => String(m.name || "").includes("countTree"));
  h.check(Boolean(self && self.cycle), "walkTree calls itself, and the row says so", JSON.stringify(marks));
  h.check(Boolean(self && /recursive|재귀/.test(self.tag)), "with the word, not only a colour", self && self.tag);
  h.check(Boolean(other) && other.cycle === false,
    "and a caller that repeats nothing carries no mark, so the mark means something", JSON.stringify(other));
  await h.shot("5-recursion-marked");

  const moved = await page.evaluate(`(() => { const b = document.getElementById('source-body'); const was = b.scrollTop; b.scrollTop = was + 400; return b.scrollTop !== was; })()`);
  h.check(moved, "the file is long enough that the reader can scroll away from the caret");
  const gone = await h.until(`document.getElementById('semantic-peek').classList.contains('hidden')`, 3000);
  h.check(Boolean(gone), "scrolling the code closes the popup instead of leaving it pinned over another line");
  await h.shot("6-scrolled-away");
});
