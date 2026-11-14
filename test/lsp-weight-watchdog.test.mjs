// A workspace in active rotation never sits still for the 30-minute idle suspend, so its pyright grows for
// as long as the app runs (measured: two ~1 GB fleets after an afternoon of switching — and pyright returns
// memory only on restart; heap caps and didClose were measured useless). Fleets are therefore also recycled
// by weight. The chain worth pinning: pids come from the live child processes, the JVM exemption exists (a
// healthy Kotlin server is 1.3 GB and must not thrash), and both over-budget outcomes route through the
// same resume paths the idle suspend already proved.
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

// The per-window budget bounds ONE fleet and nothing bounded their sum: each workspace carried its own
// allowance, so N windows could hold N × 900 MB and the machine-wide figure was whatever the reader
// happened to have open. Measured here: one warm TypeScript workspace is ~1.0 GB of physical footprint all
// in, a Python one reaches 1-2 GB of pyright alone and a Kotlin one 1.75 GB of JVM — four of those is the
// ten gigabytes this was reported at.
test("the fleets are also bounded together, and the bill is paid by the coldest workspace", () => {
  assert.match(appMain, /const LSP_TOTAL_BUDGET_MB = \d+;/, "there is a ceiling on all fleets together");
  assert.match(appMain, /if \(total < LSP_TOTAL_BUDGET_MB\) return;/, "under the ceiling nothing happens");
  assert.match(appMain, /\.sort\(\(a, b\) => a\.state\.lastFocusedAt - b\.state\.lastFocusedAt\)/,
    "and over it, the least recently fronted workspace pays first");
  assert.match(appMain, /remaining\s*\n?\s*\.filter\(\(fleet\) => fleet !== inFront\)/,
    "never the window the reader is in");
  assert.match(appMain, /win\.on\("focus", \(\) => \{ state\.lastFocusedAt = Date\.now\(\); \}\)/,
    "which needs the stamp to be kept current");
  // isVisibleWorkspace only asks whether a window is MINIMIZED, and on macOS a covered window is not
  // minimized — so "visible" cannot be the test for cold, and lastFocusedAt is why this works at all.
  assert.match(appMain, /lastFocusedAt: number;/, "the stamp is part of the window's state");

  // A JVM fleet stays out of the per-window check and inside the total: exempt from being thrashed, not
  // exempt from being counted. That was the single largest unguarded block — 1.75 GB that nothing could
  // ever reclaim while the window existed.
  assert.match(appMain, /weighed: servers\.filter\(\(\{ family \}\) => !LSP_WEIGHT_EXEMPT_FAMILIES\.has\(family\)\)/,
    "the exemption applies to the per-window weight");
  assert.match(appMain, /total = remaining\.reduce\(\(mb, fleet\) => mb \+ sum\(fleet\.pids\), 0\)/,
    "…and the total counts every server, exempt or not");
});

// One `ps` for every fleet rather than one per window: this runs for as long as the app does.
test("the watchdog asks the OS once, not once per window", () => {
  assert.match(appMain, /execFile\("ps", \["-o", "pid=,rss=", "-p", everyPid\.join\(","\)\]/,
    "every pid in one call, keyed by pid so the answers can be attributed");
  assert.equal(appMain.match(/execFile\("ps"/g).length, 1, "and there is only one such call");
});
