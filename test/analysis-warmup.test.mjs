import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { buildRegexSymbolIndex, buildRegexSymbolIndexChunked } from "../dist/analysis-index.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function project() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-warm-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
  writeFileSync(join(root, "src", "target.ts"), "export function target() { return 1; }\n");
  writeFileSync(join(root, "src", "app.ts"), "import { target } from './target.js';\nexport const used = target();\n");
  return root;
}

test("prewarm reports the indexing window and then a ready it has confirmed", { timeout: 120_000 }, async () => {
  const root = project();
  const phases = [];
  const analysis = new ProjectAnalysis(root, { onStatus: (s) => phases.push(s.phase) });
  try {
    await analysis.prewarm(["src/app.ts"]);

    assert.ok(phases.includes("indexing"), `the indexing window is named (saw: ${phases.join(" → ")})`);
    assert.equal(phases.at(-1), "ready", `and it ends ready (saw: ${phases.join(" → ")})`);
    assert.ok(
      phases.indexOf("indexing") < phases.lastIndexOf("ready"),
      "in that order — indexing is not reported after the fact",
    );
  } finally {
    analysis.dispose();
  }
});

test("prewarm waits for the server to confirm it analysed the file", { timeout: 120_000 }, async () => {
  const root = project();
  let last;
  const analysis = new ProjectAnalysis(root, { onStatus: (s) => { last = s; } });
  try {
    await analysis.prewarm(["src/app.ts"]);
    assert.equal(last.phase, "ready");
    assert.equal(last.indexed, true, "the server confirmed the analysis rather than the budget running out");

    const result = await analysis.query({ kind: "definition", path: "src/app.ts", line: 1, column: 20, symbol: "target" });
    assert.equal(result.engine, "lsp", `answered semantically: ${result.fallbackReason ?? "no reason"}`);
    assert.equal(result.locations[0]?.path, "src/target.ts", "and it lands in the right file");
  } finally {
    analysis.dispose();
  }
});

test("a server that never confirms still ends up ready, not stuck", { timeout: 60_000 }, async () => {
  const root = project();
  const phases = [];
  let last;
  const analysis = new ProjectAnalysis(root, { onStatus: (s) => { phases.push(s.phase); last = s; }, indexBudgetMs: 50 });
  try {
    await analysis.prewarm(["src/app.ts"]);
    assert.equal(phases.at(-1), "ready", `a budget that runs out still resolves (saw: ${phases.join(" → ")})`);
    assert.equal(last?.indexed, false, "and says it never got confirmation, rather than claiming it did");
  } finally {
    analysis.dispose();
  }
});

test("prewarm builds the regex index, so the first navigation in the warm-up window does not", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-index-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  for (let i = 0; i < 400; i += 1) {
    writeFileSync(join(root, "src", `mod${i}.ts`), `export function helper${i}(): number { return ${i}; }\n`.repeat(12));
  }
  writeFileSync(join(root, "src", "target.ts"), "export function target() { return 1; }\n");

  const cold = new ProjectAnalysis(root, { resolveServer: () => undefined });
  const warm = new ProjectAnalysis(root, { resolveServer: () => undefined });
  try {
    await warm.prewarm(["src/target.ts"]);
    for (let i = 0; i < 200; i += 1) await new Promise((r) => setImmediate(r));

    const ask = async (analysis) => {
      const at = process.hrtime.bigint();
      const result = await analysis.query({ kind: "definition", path: "src/target.ts", line: 0, column: 18, symbol: "target" });
      return { ms: Number(process.hrtime.bigint() - at) / 1e6, result };
    };
    const coldFirst = await ask(cold);
    const warmFirst = await ask(warm);

    assert.equal(warmFirst.result.engine, "index", "the index is what answered");
    assert.deepEqual(warmFirst.result.locations.map((i) => i.path), ["src/target.ts"], "and it answered correctly");
    assert.deepEqual(coldFirst.result.locations, warmFirst.result.locations, "both reach the same answer");
    assert.ok(
      coldFirst.ms > warmFirst.ms * 4,
      `a prewarmed first query (${warmFirst.ms.toFixed(1)} ms) should be far cheaper than a cold one `
      + `(${coldFirst.ms.toFixed(1)} ms) — if they cost the same, prewarm is not building the index`,
    );
  } finally {
    cold.dispose();
    warm.dispose();
  }
});

test("the index scan yields to the event loop and still builds the same index", async () => {
  const files = [];
  for (let i = 0; i < 400; i += 1) {
    files.push({ path: `src/f${i}.ts`, content: `export function sym${i}() {}\nexport const val${i} = 1;\n` });
  }
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const chunked = await buildRegexSymbolIndexChunked(files, 256);
  clearInterval(timer);
  assert.ok(ticks > 0, "the event loop ran during the scan — without yielding, nothing else gets a turn");

  const sync = buildRegexSymbolIndex(files);
  assert.equal(chunked.symbols.length, sync.symbols.length);
  assert.equal(chunked.files.size, sync.files.size);
  assert.deepEqual(
    chunked.symbols.map((s) => [s.path, s.lineIndex, s.name, s.symbolKind]),
    sync.symbols.map((s) => [s.path, s.lineIndex, s.name, s.symbolKind]),
    "chunking changed the index it produces",
  );
});
