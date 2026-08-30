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
  assert.match(appMain, /if \(mb < LSP_FLEET_BUDGET_MB\) return;[\s\S]{0,300}?state\.analysis\.dispose\(\);/,
    "under budget does nothing; over budget disposes");
  assert.match(appMain, /isVisibleWorkspace\(state\)[\s\S]{0,200}?makeAnalysis\(state\.options\.root, \(\) => state\);\s*\n\s*scheduleAnalysisPrewarm\(state\)/,
    "a visible workspace gets a fresh fleet immediately — a hover warmup, not a dead code-nav");
  assert.match(appMain, /state\.analysisSuspended = true; \/\/ the next activation rebuilds it/,
    "a hidden workspace resumes exactly like the idle suspend");
  assert.match(appMain, /setInterval\(\(\) => \{ watchLspWeight\(\); parkLongHidden\(\); \}, LSP_WATCHDOG_MS\)/,
    "and the watchdog is actually armed (sharing its tick with the deep park)");
});
