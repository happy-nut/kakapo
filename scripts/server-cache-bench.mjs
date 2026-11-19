import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CORPORA = {
  rubocop: {
    family: "ruby",
    probe: { path: "lib/rubocop/cli.rb", line: 27, column: 24, symbol: "ConfigStore", expected: "lib/rubocop/config_store.rb" },
    plant: { path: "lib/rubocop/cli.rb", append: "\nclass KakapoOnlyInThisWorktree\nend\n" },
  },
  discourse: {
    family: "ruby",
    probe: { path: "app/controllers/application_controller.rb", line: 524, column: 20, symbol: "Guardian", expected: "lib/guardian.rb" },
    plant: { path: "lib/guardian.rb", append: "\nclass KakapoOnlyInThisWorktree\nend\n" },
  },
  exposed: {
    family: "kotlin",
    probe: {
      path: "exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Table.kt",
      line: 5,
      column: 46,
      symbol: "EntityID",
      expected: "exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/dao/id/EntityID.kt",
    },
    plant: { path: "exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/dao/id/EntityID.kt", append: "\nclass KakapoOnlyInThisWorktree\n" },
  },
  laravel: {
    family: "php",
    probe: { path: "src/Illuminate/Cache/CacheManager.php", line: 9, column: 24, symbol: "Arr", expected: "src/Illuminate/Collections/Arr.php" },
    plant: { path: "src/Illuminate/Collections/Arr.php", append: "\nclass KakapoOnlyInThisWorktree {}\n" },
  },
};

const READY_BUDGET_MS = Number(process.env.CACHE_BENCH_READY_MS ?? 240_000);
const REPEATS = Number(process.env.CACHE_BENCH_REPEATS ?? 3);

const [corpus, rawA, rawB] = process.argv.slice(2);
if (!corpus || !rawA || !rawB) {
  console.error(`usage: node scripts/server-cache-bench.mjs <${Object.keys(CORPORA).join("|")}> <worktree-a> <worktree-b>`);
  process.exit(2);
}
const worktreeA = resolve(rawA);
const worktreeB = resolve(rawB);
const spec = CORPORA[corpus];
if (!spec) {
  console.error(`no probe is written for the corpus "${corpus}"`);
  process.exit(2);
}
const family = spec.family;

process.env.TMPDIR = process.env.CACHE_BENCH_TMPDIR
  || mkdtempSync(join(tmpdir(), "kakapo-cache-bench-"));
process.env.KAKAPO_LSP_BUNDLE_ROOT = process.env.KAKAPO_LSP_BUNDLE_ROOT
  || join(process.cwd(), "vendor", "language-servers");

const { ProjectAnalysis } = await import("../dist/analysis.js");
const { SERVER_CACHE_SCOPES, serverCacheDirectory } = await import("../dist/server-cache.js");

function cacheOf(root) {
  return serverCacheDirectory(family, root);
}

function wipe(path) {
  rmSync(path, { recursive: true, force: true });
}

function sizeOf(path) {
  if (!existsSync(path)) return 0;
  const out = execFileSync("du", ["-sk", path], { encoding: "utf8" });
  return Number(out.split("\t")[0]) * 1024;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function shutdown(analysis) {
  const pids = analysis.serverPids().map((one) => one.pid);
  analysis.dispose();
  const deadline = Date.now() + 30_000;
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
  }
  if (pids.some(alive)) throw new Error(`a ${family} server outlived its window, so the next run would race it`);
}

async function readyAnalysis(root) {
  const analysis = new ProjectAnalysis(root, { coldQueryBudgetMs: 50 });
  const started = Date.now();
  void analysis.prewarm([spec.probe.path]).catch(() => undefined);
  const deadline = started + READY_BUDGET_MS;
  for (;;) {
    const answer = await analysis.query({ kind: "definition", ...spec.probe });
    if (answer.engine === "lsp" && answer.locations?.[0]?.path === spec.probe.expected) {
      return { analysis, ms: Date.now() - started, server: answer.server };
    }
    if (Date.now() > deadline) {
      await shutdown(analysis);
      throw new Error(`${family} never answered semantically in ${READY_BUDGET_MS}ms: ${answer.fallbackReason ?? answer.engine}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function timeToFirstSemanticAnswer(root, options = {}) {
  const ready = await readyAnalysis(root);
  if (options.keepAlive) options.keepAlive.push(ready.analysis);
  else await shutdown(ready.analysis);
  return { ms: ready.ms, server: ready.server };
}

const PLANTED_SYMBOL = "KakapoOnlyInThisWorktree";

async function findsPlantedSymbol(root) {
  const { analysis } = await readyAnalysis(root);
  try {
    const answer = await analysis.query({ kind: "workspaceSymbol", path: spec.plant.path, query: PLANTED_SYMBOL });
    return answer.engine === "lsp" && (answer.locations ?? []).some((one) => one.path === spec.plant.path);
  } finally {
    await shutdown(analysis);
  }
}

function median(values) {
  const sorted = [...values].sort((one, two) => one - two);
  return sorted[Math.floor(sorted.length / 2)];
}

function report(label, values) {
  const spread = Math.max(...values) - Math.min(...values);
  console.log(`${label.padEnd(34)} ${String(median(values)).padStart(7)} ms   runs ${values.join(", ")}   spread ${spread} ms`);
}

console.log(`corpus ${corpus}, family ${family}`);
console.log(`worktree A ${worktreeA}`);
console.log(`worktree B ${worktreeB}`);
console.log(`cache base ${process.env.TMPDIR}`);

const ownCold = [];
const ownWarm = [];
const shared = [];
let ownSize = 0;
let filledSize = 0;
let sharedSize = 0;
for (let run = 0; run < REPEATS; run += 1) {
  SERVER_CACHE_SCOPES[family] = "worktree";
  wipe(cacheOf(worktreeB));
  const cold = await timeToFirstSemanticAnswer(worktreeB);
  ownSize = sizeOf(cacheOf(worktreeB));
  const warm = await timeToFirstSemanticAnswer(worktreeB);

  SERVER_CACHE_SCOPES[family] = "shared";
  wipe(cacheOf(worktreeA));
  await timeToFirstSemanticAnswer(worktreeA);
  filledSize = sizeOf(cacheOf(worktreeA));
  const sibling = await timeToFirstSemanticAnswer(worktreeB);
  sharedSize = sizeOf(cacheOf(worktreeA));

  ownCold.push(cold.ms);
  ownWarm.push(warm.ms);
  shared.push(sibling.ms);
  console.log(`round ${run + 1} on ${cold.server}: own cold ${cold.ms} ms, own warm ${warm.ms} ms, sibling's shared ${sibling.ms} ms`);
}

report("own cache, cold", ownCold);
report("own cache, warm", ownWarm);
report("shared cache the sibling filled", shared);
console.log(`cache on disk  own ${(ownSize / 1e6).toFixed(1)} MB   shared after A ${(filledSize / 1e6).toFixed(1)} MB   after A and B ${(sharedSize / 1e6).toFixed(1)} MB`);

async function plantedTextSurvives(scope, untouched, planted, names) {
  SERVER_CACHE_SCOPES[family] = scope;
  wipe(cacheOf(untouched));
  wipe(cacheOf(planted));
  const plantedAt = join(planted, spec.plant.path);
  const original = readFileSync(plantedAt, "utf8");
  try {
    const before = await findsPlantedSymbol(untouched);
    writeFileSync(plantedAt, original + spec.plant.append);
    const after = await findsPlantedSymbol(planted);
    console.log(`planted text, ${scope} cache, ${names}: the untouched one finds it ${before}, the planted one ${after}`);
    return { control: before, seen: after };
  } finally {
    writeFileSync(plantedAt, original);
  }
}

const plantedRuns = [];
for (let run = 0; run < REPEATS; run += 1) {
  plantedRuns.push({ scope: "worktree", ...await plantedTextSurvives("worktree", worktreeA, worktreeB, "A untouched, B planted") });
  plantedRuns.push({ scope: "shared", ...await plantedTextSurvives("shared", worktreeA, worktreeB, "A fills the cache, B planted") });
  plantedRuns.push({ scope: "shared", ...await plantedTextSurvives("shared", worktreeB, worktreeA, "B fills the cache, A planted") });
}
const falsePositives = plantedRuns.filter((one) => one.control).length;
const apartRuns = plantedRuns.filter((one) => one.scope === "worktree");
const togetherRuns = plantedRuns.filter((one) => one.scope === "shared");
const seenApart = apartRuns.filter((one) => one.seen).length;
const seenTogether = togetherRuns.filter((one) => one.seen).length;
console.log(`planted text found: ${seenApart}/${apartRuns.length} with a cache each, ${seenTogether}/${togetherRuns.length} on one shared cache`);
if (falsePositives) console.log(`the check is broken: ${falsePositives} runs found the symbol in the worktree that never held it`);
const misread = Boolean(falsePositives) || seenTogether < togetherRuns.length;
if (misread) console.log("MISREAD: a sibling's cache answered for text it never held");

async function bothAtOnce(scope) {
  SERVER_CACHE_SCOPES[family] = scope;
  wipe(cacheOf(worktreeA));
  wipe(cacheOf(worktreeB));
  const keepAlive = [];
  const settled = await Promise.allSettled([
    timeToFirstSemanticAnswer(worktreeA, { keepAlive }),
    timeToFirstSemanticAnswer(worktreeB, { keepAlive }),
  ]);
  for (const analysis of keepAlive) await shutdown(analysis);
  const refused = settled.filter((one) => one.status === "rejected");
  const slowest = Math.max(...settled.filter((one) => one.status === "fulfilled").map((one) => one.value.ms), 0);
  for (const failure of refused) console.log(`  ${failure.reason?.message ?? failure.reason}`);
  return { refused: refused.length, slowest };
}

const apart = [];
const together = [];
let refusedApart = 0;
let refusedTogether = 0;
for (let run = 0; run < REPEATS; run += 1) {
  const separate = await bothAtOnce("worktree");
  const one = await bothAtOnce("shared");
  apart.push(separate.slowest);
  together.push(one.slowest);
  refusedApart += separate.refused;
  refusedTogether += one.refused;
  console.log(`pair ${run + 1}: a cache each ${separate.slowest} ms, one cache ${one.slowest} ms`);
}
report("two live servers, a cache each", apart);
report("two live servers, one cache", together);
if (refusedApart || refusedTogether) console.log(`refusals: a cache each ${refusedApart}, one cache ${refusedTogether}`);

process.exit(misread || refusedTogether > refusedApart ? 1 : 0);
