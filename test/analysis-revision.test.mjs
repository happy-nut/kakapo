// Navigation must not answer about the working tree while the canvas is showing a revision.
//
// kakapo supports an A→B compare whose right side is an exact revision (app-main.ts: "exact right/new side
// revision for an A→B compare"). Everything ProjectAnalysis reads comes from disk, so in that mode the index
// describes a DIFFERENT text than the one on screen. That goes wrong in two shapes:
//
//   renamed symbol  — answers with nothing, which at least LOOKS like an answer of "none"
//   moved symbol    — answers with the file it lives in TODAY, a file that may not have existed in the
//                     revision being read, and nothing distinguishes that from a correct jump
//
// The second is the reason this is a decline and not a best effort. Both repositories below are the ones
// the behaviour was first reproduced in.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const run = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-revision-"));
  dirs.push(root);
  run(root, ["init", "-qb", "main"]);
  run(root, ["config", "user.email", "t@t.t"]);
  run(root, ["config", "user.name", "t"]);
  return root;
}
// No language server: this is about which TEXT is consulted, and a real server would answer by position
// and hide the question. (The same trap caught the syncIndex tests.)
const analyzerFor = (root) => new ProjectAnalysis(root, { resolveServer: () => undefined });

test("a moved symbol would send the reviewer into a file the revision never had — so navigation declines", async () => {
  const root = repo();
  write(root, "legacy/server.ts", "export function handleRequest(req) {\n  return 'legacy';\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "handleRequest in legacy/server.ts"]);
  const commitA = run(root, ["rev-parse", "HEAD"]);

  rmSync(join(root, "legacy"), { recursive: true, force: true });
  write(root, "src/http/handler.ts", "export function handleRequest(req) {\n  return 'v2';\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "move and rewrite"]);

  const analysis = analyzerFor(root);
  try {
    // The working tree: navigation works, and this is the control. Without it a decline that fires
    // unconditionally would pass every assertion below.
    const onWorktree = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "src/http/handler.ts", line: 1, column: 17,
    });
    assert.equal(onWorktree.ok, true, "on the working tree the analyzer still answers");
    assert.equal(onWorktree.declined, undefined, "and does not decline");
    assert.ok(onWorktree.locations.length > 0, "and finds the definition it can see");

    // Now the canvas moves to commit A, where that file does not exist.
    analysis.setReviewTarget(commitA);
    const onRevision = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "legacy/server.ts", line: 1, column: 17,
    });
    assert.equal(onRevision.ok, false, "the analyzer declines rather than answering from disk");
    assert.equal(onRevision.declined, "revision", "and says why, so the viewer can explain it");
    assert.equal(onRevision.declinedRevision, commitA, "naming the revision on screen");
    assert.deepEqual(onRevision.locations, [], "with no location — src/http/handler.ts is not an answer here");

    // And it comes back when the compare returns to the working tree.
    analysis.setReviewTarget("worktree");
    const restored = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "src/http/handler.ts", line: 1, column: 17,
    });
    assert.equal(restored.ok, true, '"worktree" is the working tree, not a revision');
    assert.equal(restored.declined, undefined);
  } finally { analysis.dispose(); }
});

test("every question goes through the same boundary, not just go-to-definition", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alpha() {\n  return 1;\n}\nalpha();\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alpha"]);
  const commit = run(root, ["rev-parse", "HEAD"]);

  const analysis = analyzerFor(root);
  try {
    analysis.setReviewTarget(commit);
    // workspaceSymbol is included on purpose: a symbol LIST for the wrong revision is the same lie in a
    // different shape, and it reaches the reviewer through a different surface (Cmd+T, not Cmd+B).
    for (const kind of ["definition", "references", "implementation", "workspaceSymbol"]) {
      const response = await analysis.query({ kind, symbol: "alpha", query: "alpha", path: "src/a.ts", line: 1, column: 17 });
      assert.equal(response.declined, "revision", `${kind} declines on a revision`);
      assert.deepEqual(response.locations, [], `${kind} returns nothing to act on`);
    }
    // Diagnostics answer differently — there is already a word for "nothing can judge this file" — but the
    // reviewer must not get squiggles computed from today's text on a revision's line numbers.
    const diagnostics = await analysis.diagnostics("src/a.ts");
    assert.equal(diagnostics.available, false, "no diagnostics are offered for a revision");
    assert.deepEqual(diagnostics.diagnostics, [], "and none are reported");
  } finally { analysis.dispose(); }
});

test("the decline is a distinct state, not a failure and not an empty answer", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alpha() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alpha"]);

  const analysis = analyzerFor(root);
  try {
    // A symbol that genuinely does not exist, on the working tree: ok, no decline, no locations. This is
    // what "asked and there is nothing" looks like, and the viewer renders it differently on purpose.
    const absent = await analysis.query({
      kind: "definition", symbol: "neverExistedAnywhere", path: "src/a.ts", line: 1, column: 17,
    });
    assert.equal(absent.declined, undefined, "a missing symbol is not a declined question");
    assert.deepEqual(absent.locations, [], "it is simply an empty answer");

    analysis.setReviewTarget("deadbee");
    const declined = await analysis.query({
      kind: "definition", symbol: "neverExistedAnywhere", path: "src/a.ts", line: 1, column: 17,
    });
    assert.notEqual(declined.ok, absent.ok, "the two are distinguishable at the IPC boundary");
    assert.equal(declined.declined, "revision");
  } finally { analysis.dispose(); }
});

test("the viewer stops at the boundary before its own fallback, and says which revision", () => {
  const client = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  // The standalone in-memory scan reads the rendered DOM, which IS the revision on screen — so it would
  // answer, and jump, by a different route. The guard has to come first at every call site.
  assert.match(client, /declined === 'revision'/, "the viewer recognises a declined answer");
  // CALL sites only. Counting /declinedForRevision\(response\)/ also matches the function's own
  // declaration, which kept this at 3 after a call site was deleted — the control for this test passed
  // while the guard was gone.
  const sites = client.match(/if \(declinedForRevision\(response\)\) return;/g) || [];
  assert.equal(sites.length, 3, `definition, references and implementation each check it (found ${sites.length})`);
  assert.match(client, /monaco\.analysisRevision/, "and shows the revision-specific message");
  // Not the generic "definition not found": that is what the reviewer would act on, believing the symbol
  // has no definition anywhere. Scoped to goToDefOrUsages alone, because the next function's guard would
  // otherwise stand in for this one's.
  const start = client.indexOf("async function goToDefOrUsages");
  const end = client.indexOf("async function goToImplementation", start);
  assert.ok(start >= 0 && end > start, "goToDefOrUsages is in the bundle, followed by goToImplementation");
  const definitionFlow = client.slice(start, end);
  const guardAt = definitionFlow.indexOf("declinedForRevision");
  const scanAt = definitionFlow.indexOf("findSymbolDefinition");
  assert.ok(guardAt >= 0, "goToDefOrUsages checks the boundary at all");
  assert.ok(scanAt >= 0, "and still has the standalone scan this is guarding against");
  assert.ok(guardAt < scanAt, "the guard runs before the standalone scan, not after it");
});
