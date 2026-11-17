import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const FILE = "src/app.ts";
const SOURCE = [
  "export function helper() { return 1; }",
  "export const used = helper();",
  "",
].join("\n");

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-baseside-"));
  dirs.push(root);
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-qb", "main"]);
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  const absolute = join(root, FILE);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, SOURCE);
  run(["add", "-A"]);
  run(["commit", "-qm", "one"]);
  return root;
}

function analyzerFor(root, calls) {
  return new ProjectAnalysis(root, {
    resolveServer: (...args) => { calls.push(args[0]); return undefined; },
  });
}

const ask = (analysis, extra) => analysis.query({
  kind: "definition", path: FILE, line: 1, column: 20, symbol: "helper", ...extra,
});

test("a base-pane position is never handed to a language server", async () => {
  const root = repo();
  const calls = [];
  const analysis = analyzerFor(root, calls);

  const working = await ask(analysis, {});
  assert.ok(calls.length > 0, "the premise: an ordinary request does reach for a server");
  assert.ok(!working.baseSide, "and is not marked as coming from the base");

  const before = calls.length;
  const base = await ask(analysis, { side: "old" });
  assert.equal(calls.length, before, "a base-pane request reaches for no server at all");
  assert.equal(base.baseSide, true, "and says so, because the page needs a different sentence for it");
  assert.ok(base.fallbackReason, "with the reason the server was not asked");
  assert.match(String(base.fallbackReason), /base/i, "which names the base, not a revision");
  assert.equal(base.engine, "index", "the name index answers instead — the reason the base side is offered");
});

test("declining the server does not decline the answer", async () => {
  const root = repo();
  const analysis = analyzerFor(root, []);
  const base = await ask(analysis, { side: "old" });
  assert.ok(base.ok, "the request succeeded");
  assert.deepEqual((base.locations || []).map((item) => item.path), [FILE],
    "the index still found `helper` by name, in the file it is declared in");
});
