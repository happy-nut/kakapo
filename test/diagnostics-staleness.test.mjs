import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";

const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test("fixing an error clears its diagnostic instead of leaving it on a moved line", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-diag-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
  const file = join(root, "src", "app.ts");
  const relative = "src/app.ts";
  writeFileSync(file, "export const n: number = 'not a number';\n");

  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm([relative]);
    const broken = await analysis.diagnostics(relative);
    assert.equal(broken.engine, "lsp", `the bundled server must answer: ${broken.error ?? "no reason"}`);
    assert.ok(broken.diagnostics.length > 0, "the type error is reported while it is there");

    writeFileSync(file, "const tidy = 1;\nexport const n: number = 42;\nexport { tidy };\n");
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);

    const fixed = await analysis.diagnostics(relative);
    assert.equal(fixed.engine, "lsp");
    assert.deepEqual(
      fixed.diagnostics.map((d) => `${d.lineIndex}:${d.message}`),
      [],
      "the fixed file has no diagnostics — not the previous version's, at the previous version's lines",
    );
  } finally {
    analysis.dispose();
  }
});
