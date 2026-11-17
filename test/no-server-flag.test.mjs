import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";

const dirs = [];
after(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function project() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-noserver-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  writeFileSync(join(root, "src", "app.ts"), "export const used = 1;\nexport const other = used;\n");
  writeFileSync(join(root, "notes.md"), "# Notes\n\nkakapo reads diffs.\n");
  return root;
}

test("a language with no server says so; a language with one never does", async () => {
  const analysis = new ProjectAnalysis(project());
  try {
    const md = await analysis.query({ kind: "implementation", path: "notes.md", name: "kakapo", line: 2, column: 0 });
    assert.equal(md.noServer, true, "no server covers Markdown");

    const ts = await analysis.query({ kind: "implementation", path: "src/app.ts", name: "used", line: 1, column: 20 });
    assert.notEqual(ts.noServer, true, "a resolvable language is never reported as unsupported");
  } finally {
    analysis.dispose();
  }
});

test("a quarantined server does not turn its language into an unsupported one", async () => {
  const root = project();
  const analysis = new ProjectAnalysis(root);
  try {
    const client = analysis.clientFor ? analysis.clientFor("src/app.ts") : null;
    assert.ok(client, "a client resolves for TypeScript before the quarantine");
    analysis.quarantine(client, new Error("simulated transport failure"));
    assert.equal(analysis.clientFor("src/app.ts"), undefined, "...and none resolves after it");

    const after = await analysis.query({ kind: "implementation", path: "src/app.ts", name: "used", line: 1, column: 20 });
    assert.equal(after.noServer, false,
      "a server that fell over is not the same as a language nothing covers");
  } finally {
    analysis.dispose();
  }
});
