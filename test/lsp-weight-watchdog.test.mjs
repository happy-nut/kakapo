import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const appMain = read("src/app-main.ts");
const analysis = read("src/analysis.ts");
const lsp = read("src/lsp.ts");

test("fleets are weighed by live server pids, with the JVM family exempt", () => {
  assert.match(lsp, /serverPid\(\): number \| undefined \{[\s\S]{0,200}?exitCode === null && child\.signalCode === null/,
    "a dead child never reports a pid, so ps is never asked about a recycled process");
  assert.match(analysis, /serverPids\(\): \{ pid: number; family: string \}\[\]/,
    "the family travels with the pid so exemptions can be decided by the caller");
  assert.match(appMain, /LSP_WEIGHT_EXEMPT_FAMILIES = new Set\(\["kotlin"\]\)/,
    "the Kotlin server is 1.3 GB when healthy — recycling it by weight would thrash it");
});

test("an over-budget fleet is recycled through the same paths the idle suspend uses", () => {
  assert.match(appMain, /sum\(fleet\.weighed\) >= LSP_FLEET_BUDGET_MB\) recycleFleet\(/,
    "under budget does nothing; over budget recycles");
  assert.match(appMain, /function recycleFleet[\s\S]{0,400}?state\.analysis\.dispose\(\);/,
    "recycling disposes the fleet");
  assert.match(appMain, /isVisibleWorkspace\(state\)[\s\S]{0,200}?makeAnalysis\(state\.options\.root, \(\) => state\);\s*\n\s*scheduleAnalysisPrewarm\(state\)/,
    "a visible workspace gets a fresh fleet immediately — a hover warmup, not a dead code-nav");
  assert.match(appMain, /function recycleFleet[\s\S]{0,500}?state\.analysisSuspended = true;/,
    "a hidden window resumes exactly like the idle suspend");
  assert.match(appMain, /setInterval\(watchLspWeight, LSP_WATCHDOG_MS\)/, "and the watchdog is actually armed");
});

test("the fleets are also bounded together, and the bill is paid by the coldest workspace", () => {
  assert.match(appMain, /const LSP_TOTAL_BUDGET_MB = \d+;/, "there is a ceiling on all fleets together");
  assert.match(appMain, /if \(total < LSP_TOTAL_BUDGET_MB\) return;/, "under the ceiling nothing happens");
  assert.match(appMain, /\.sort\(\(a, b\) => a\.state\.lastFocusedAt - b\.state\.lastFocusedAt\)/,
    "and over it, the least recently fronted workspace pays first");
  assert.match(appMain, /remaining\s*\n?\s*\.filter\(\(fleet\) => fleet !== inFront\)/,
    "never the window the reader is in");
  assert.match(appMain, /win\.on\("focus", \(\) => \{ state\.lastFocusedAt = Date\.now\(\); \}\)/,
    "which needs the stamp to be kept current");
  assert.match(appMain, /lastFocusedAt: number;/, "the stamp is part of the window's state");

  assert.match(appMain, /weighed: servers\.filter\(\(\{ family \}\) => !LSP_WEIGHT_EXEMPT_FAMILIES\.has\(family\)\)/,
    "the exemption applies to the per-window weight");
  assert.match(appMain, /total = remaining\.reduce\(\(mb, fleet\) => mb \+ sum\(fleet\.pids\), 0\)/,
    "…and the total counts every server, exempt or not");
});

test("the watchdog asks the OS once, not once per window", () => {
  assert.match(appMain, /execFile\("ps", \["-o", "pid=,rss=", "-p", everyPid\.join\(","\)\]/,
    "every pid in one call, keyed by pid so the answers can be attributed");
  assert.equal(appMain.match(/execFile\("ps"/g).length, 1, "and there is only one such call");
});
