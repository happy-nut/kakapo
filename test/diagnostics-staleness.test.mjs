// Diagnostics must describe the file as it is NOW.
//
// ensureDocument sends didChange when a file's mtime moves, but the diagnostics held for that uri — and the
// "already published once" mark that tells diagnosticsFor not to wait — were left alone. So the next read
// answered from the version that had just stopped existing, at its line numbers: an agent fixed a type
// error, the watch rebuild re-read the file, and the squiggle stayed, parked on whatever line had moved into
// its place. Drives the real bundled TypeScript server, because the bug was in the client's cache and a fake
// server would assert nothing.
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

    // The agent fixes it, and adds a line above so a stale diagnostic would land somewhere wrong rather
    // than merely being out of date.
    writeFileSync(file, "const tidy = 1;\nexport const n: number = 42;\nexport { tidy };\n");
    // mtime is what ensureDocument compares, and a write inside the same millisecond would not move it.
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
