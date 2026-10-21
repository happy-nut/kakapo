// Opening a project should get the indexing over with in the background, so the reviewer's first Cmd+Down
// is already semantic. `warmup` alone never did that: it gets a server as far as acknowledging `initialize`,
// which a cold JDT or rust-analyzer does in milliseconds before spending real time building its model.
//
// Drives the real bundled TypeScript server, because the whole question is what a real server does between
// the handshake and having an index.
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

// Prewarm does not merely START the indexing, it waits for the server to CONFIRM it analysed the file —
// `indexed: true` on the final status is only reachable through that wait. Asserting "the first navigation
// is semantic" instead would prove nothing: on a two-file project this machine's server is fast enough to
// answer semantically with or without the wait, so that test passed either way when it was checked against
// the unwaited build. This one does not.
test("prewarm waits for the server to confirm it analysed the file", { timeout: 120_000 }, async () => {
  const root = project();
  let last;
  const analysis = new ProjectAnalysis(root, { onStatus: (s) => { last = s; } });
  try {
    await analysis.prewarm(["src/app.ts"]);
    assert.equal(last.phase, "ready");
    assert.equal(last.indexed, true, "the server confirmed the analysis rather than the budget running out");

    // …and the navigation that follows is the semantic one, which is the point of doing it at open time.
    const result = await analysis.query({ kind: "definition", path: "src/app.ts", line: 1, column: 20, symbol: "target" });
    assert.equal(result.engine, "lsp", `answered semantically: ${result.fallbackReason ?? "no reason"}`);
    assert.equal(result.locations[0]?.path, "src/target.ts", "and it lands in the right file");
  } finally {
    analysis.dispose();
  }
});

// A server that never diagnoses the warm-up file must not leave the chip saying "indexing" forever.
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

// The regex index is what answers navigation WHILE the servers are still reading the project — that is its
// only job. It was built lazily, on first use, which put the whole build on the reviewer's first keystroke
// in exactly the window it exists to cover: measured at 148 ms on this repository and ~1.8 s on a
// 3,000-file one, paid on top of whatever that keystroke had already spent waiting for the server.
// prewarm starts it now, without awaiting it, so by the time a key is pressed getIndex() is already settled.
//
// Compared rather than bounded: an absolute millisecond ceiling is a flake waiting for a loaded CI box, and
// on a two-file fixture a cold build finishes inside any ceiling worth writing. The project below is big
// enough that building its index is unmistakably more work than looking something up in one.
test("prewarm builds the regex index, so the first navigation in the warm-up window does not", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-index-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  for (let i = 0; i < 400; i += 1) {
    writeFileSync(join(root, "src", `mod${i}.ts`), `export function helper${i}(): number { return ${i}; }\n`.repeat(12));
  }
  writeFileSync(join(root, "src", "target.ts"), "export function target() { return 1; }\n");

  // No language server at all, so whatever a query costs here is the index and nothing else.
  const cold = new ProjectAnalysis(root, { resolveServer: () => undefined });
  const warm = new ProjectAnalysis(root, { resolveServer: () => undefined });
  try {
    await warm.prewarm(["src/target.ts"]);
    // prewarm deliberately does not await the index, so give the in-flight build its turns.
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

// Building the index is ~1.8 s of pure CPU on a 3,000-file repository, and it runs in the main process. In
// one synchronous block that is a two-second freeze of IPC, the window and every other query. Chunked, the
// work is the same and the longest stall is tens of milliseconds. This pins the chunking itself: the async
// builder must actually yield, and must produce exactly what the synchronous one produces.
test("the index scan yields to the event loop and still builds the same index", async () => {
  const files = [];
  for (let i = 0; i < 400; i += 1) {
    files.push({ path: `src/f${i}.ts`, content: `export function sym${i}() {}\nexport const val${i} = 1;\n` });
  }
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const chunked = await buildRegexSymbolIndexChunked(files, 256); // small budget so this stays quick
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
