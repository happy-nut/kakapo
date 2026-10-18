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
