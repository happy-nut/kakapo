import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PANEL = "src/viewer/27-stack-trace.js";
const AUDIT = "scripts/ui-text-audit.mjs";

// A stack-trace row carries two kinds of text and the chrome-text audit has to tell them apart: what the
// reader's crash wrote (a path, a symbol, a prose line) is not ours to measure, and our own sentences are.
// The class is the only signal, so a row filled with text under neither class is a Korean string nobody
// ever measured at 900px.
const THEIRS = "stack-line";
const OURS = "stack-note";
const FILLED = /<(?:span|div) class="([^"]*)"[^>]*>'\s*\+\s*(escapeHtml\(|t\()/g;

test("the reader finds the panel's text elements at all", () => {
  const panel = readFileSync(resolve(root, PANEL), "utf8");
  const found = Array.from(panel.matchAll(FILLED), (match) => match[1]);
  assert.ok(found.length >= 4, `this reader found ${found.length} text elements in ${PANEL}, so it is not `
    + "reading the row builders and anything it reports below is its own bug");
  assert.ok(found.some((classes) => classes.includes(THEIRS)) && found.some((classes) => classes.includes(OURS)),
    `it found no element of one of the two kinds: ${JSON.stringify(found)}`);
});

test("every text a stack row carries says whose sentence it is", () => {
  const panel = readFileSync(resolve(root, PANEL), "utf8");
  const unclassed = Array.from(panel.matchAll(FILLED), (match) => match[1])
    .filter((classes) => !classes.split(/\s+/).some((name) => name === THEIRS || name === OURS));
  assert.deepEqual(unclassed, [], `a stack row is filled with text under neither .${THEIRS} nor .${OURS}, `
    + `so ${AUDIT} either measures the reader's own crash output or skips a sentence we wrote.`);
});

test("the audit exempts the reader's crash text and nothing more of ours", () => {
  const audit = readFileSync(resolve(root, AUDIT), "utf8");
  assert.ok(audit.includes(`'.${THEIRS}'`), `${AUDIT} does not exempt .${THEIRS}, so a path and a symbol out `
    + "of someone else's stack trace are measured as chrome text and reported as defects we can fix");
  assert.ok(!audit.includes(`'.${OURS}'`), `${AUDIT} exempts .${OURS}, which is our own sentences — the one `
    + "text in that panel the audit exists to measure");
});
