import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { resolveLanguageServer } from "../dist/lsp.js";

let project = null;

const SOURCES = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
    include: ["src"],
  }),
  "src/store.ts": [
    "export class Store {",
    "  private total = 0;",
    "",
    "  run(): number {",
    "",
    "    return this.bump();",
    "  }",
    "",
    "  bump(): number {",
    "    this.total += 1;",
    "    return this.total;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

before(() => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-call-graph-"));
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (!resolveLanguageServer(root, "src/store.ts")) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  project = { root, analysis: new ProjectAnalysis(root, { files: [{ path: "src/store.ts", content: SOURCES["src/store.ts"] }] }) };
});

after(async () => {
  if (!project) return;
  await project.analysis.dispose?.();
  rmSync(project.root, { recursive: true, force: true });
  project = null;
});

test("a caller carries the call sites inside it, which are not its declaration line", async (t) => {
  if (!project) { t.skip("no TypeScript language server installed"); return; }
  const callers = await project.analysis.query({ kind: "callers", path: "src/store.ts", line: 8, column: 2, symbol: "bump" });
  assert.equal(callers.engine, "lsp", callers.fallbackReason ?? "");

  const run = callers.locations.find((item) => String(item.name || "").startsWith("run"));
  assert.ok(run, `run() is a caller of bump() (got ${JSON.stringify(callers.locations.map((l) => l.name))})`);
  assert.equal(run.lineIndex, 3, "the row still points at the caller's own declaration, which is what names it");

  assert.ok(Array.isArray(run.callSites) && run.callSites.length, "and it carries where inside run() the call is");
  assert.deepEqual(run.callSites.map((site) => site.lineIndex), [5],
    "`return this.bump();` is two lines below `run(): number {`, so Enter must not land on the declaration");
});
