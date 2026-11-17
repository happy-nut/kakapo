import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { listRevisionFiles, readRevisionBlobs } from "../dist/git-tree.js";

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
const analyzerFor = (root) => new ProjectAnalysis(root, { resolveServer: () => undefined });
const paths = (response) => (response.locations || []).map((item) => item.path);

test("a moved symbol resolves inside the revision, not where it lives today", async () => {
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
    const onWorktree = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "src/http/handler.ts", line: 1, column: 17,
    });
    assert.deepEqual(paths(onWorktree), ["src/http/handler.ts"], "the working tree still answers about itself");
    assert.equal(onWorktree.revision, undefined, "and is not labelled as a revision answer");

    analysis.setReviewTarget(commitA);
    const onRevision = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "legacy/server.ts", line: 1, column: 17,
    });
    assert.deepEqual(paths(onRevision), ["legacy/server.ts"],
      "the definition is the one in the revision being read — the file actually on screen");
    assert.equal(onRevision.revision, commitA, "and the answer says which revision it describes");
    assert.equal(onRevision.engine, "index", "a revision can only be answered by the index");
    assert.equal(onRevision.confidence, "heuristic", "which is name-matching, and says so");

    analysis.setReviewTarget("worktree");
    const restored = await analysis.query({
      kind: "definition", symbol: "handleRequest", path: "src/http/handler.ts", line: 1, column: 17,
    });
    assert.deepEqual(paths(restored), ["src/http/handler.ts"], '"worktree" is the working tree, not a revision');
    assert.equal(restored.revision, undefined);
  } finally { analysis.dispose(); }
});

test("a name that exists only at HEAD is absent while an older revision is on screen", async () => {
  const root = repo();
  write(root, "src/math.ts", "export function computeAlpha(n) {\n  return n * 2;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "computeAlpha"]);
  const commitA = run(root, ["rev-parse", "HEAD"]);

  write(root, "src/math.ts", "export function computeBeta(n) {\n  return n * 2;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "rename to computeBeta"]);

  const analysis = analyzerFor(root);
  try {
    analysis.setReviewTarget(commitA);
    const old = await analysis.query({ kind: "definition", symbol: "computeAlpha", path: "src/math.ts", line: 1, column: 17 });
    assert.deepEqual(paths(old), ["src/math.ts"], "the revision's own symbol is found");

    const current = await analysis.query({ kind: "definition", symbol: "computeBeta", path: "src/math.ts", line: 1, column: 17 });
    assert.deepEqual(paths(current), [], "a name introduced after this revision is not in it");
    assert.equal(current.revision, commitA, "and the empty answer is still labelled with the revision");
  } finally { analysis.dispose(); }
});

test("an unreadable revision declines instead of answering empty", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alpha() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alpha"]);

  const analysis = analyzerFor(root);
  try {
    analysis.setReviewTarget("notarevisionatall");
    const declined = await analysis.query({ kind: "definition", symbol: "alpha", path: "src/a.ts", line: 1, column: 17 });
    assert.equal(declined.ok, false, "an unreadable revision is not an answer");
    assert.equal(declined.declined, "revision", "and says so by name");
    assert.deepEqual(declined.locations, []);

    analysis.setReviewTarget(run(root, ["rev-parse", "HEAD"]));
    const fine = await analysis.query({ kind: "definition", symbol: "alpha", path: "src/a.ts", line: 1, column: 17 });
    assert.equal(fine.declined, undefined, "a readable revision answers");
    assert.deepEqual(paths(fine), ["src/a.ts"]);
  } finally { analysis.dispose(); }
});

test("diagnostics stay unavailable on a revision, because no server can read one", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alpha() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alpha"]);

  const analysis = analyzerFor(root);
  try {
    analysis.setReviewTarget(run(root, ["rev-parse", "HEAD"]));
    const diagnostics = await analysis.diagnostics("src/a.ts");
    assert.equal(diagnostics.available, false, "nothing can judge a revision's text");
    assert.deepEqual(diagnostics.diagnostics, []);
  } finally { analysis.dispose(); }
});

test("the tree reader survives the paths git allows and Node's idea of them", async () => {
  const root = repo();
  write(root, "src/weißbier café.ts", "export function tricky() {\n  return 1;\n}\n");
  write(root, "src/plain.ts", "export function plain() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "awkward names"]);
  const head = run(root, ["rev-parse", "HEAD"]);

  const listed = listRevisionFiles(root, head);
  assert.ok(listed.includes("src/weißbier café.ts"),
    `a non-ASCII path with a space survives enumeration: ${JSON.stringify(listed)}`);

  const blobs = await readRevisionBlobs(root, head, listed, { maxBytes: 1_000_000 });
  const byPath = new Map(blobs.map((blob) => [blob.path, blob.content]));
  for (const path of listed) {
    const expected = execFileSync("git", ["show", `${head}:${path}`], { cwd: root, encoding: "utf8" });
    assert.equal(byPath.get(path), expected, `${path} reads back byte-for-byte`);
  }

  const nested = join(root, "src");
  assert.deepEqual(
    listRevisionFiles(nested, head).sort(),
    ["plain.ts", "weißbier café.ts"],
    "paths come back relative to the workspace, not the repository",
  );
});

test("the viewer tells a found-in-revision answer apart from a still-indexing one", () => {
  const client = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  assert.match(client, /if \(response\.revision\) return false;/,
    "a revision answer is excluded from the still-indexing label");
  assert.match(client, /monaco\.analysisRevisionMatched/, "and gets its own, which names the revision");
  assert.match(client, /monaco\.analysisRevision'/, "the unreadable-revision decline still has a message");
  const sites = client.match(/if \(declinedForRevision\(response, name\)\) return;/g) || [];
  assert.equal(sites.length, 5, `every jumping navigation checks the decline (found ${sites.length})`);
});

test("the symbol under the caret is read from the revision's text, not the working tree's", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alphaOnly() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alphaOnly"]);
  const commitA = run(root, ["rev-parse", "HEAD"]);

  write(root, "src/a.ts", "export function betaOnlyX() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "betaOnlyX"]);

  const analysis = analyzerFor(root);
  try {
    const line = 0;
    const column = "export function ".length + 2;

    const onWorktree = await analysis.query({ kind: "definition", path: "src/a.ts", line, column });
    assert.equal(onWorktree.symbol, "betaOnlyX", "control: the working tree resolves its own identifier");

    analysis.setReviewTarget(commitA);
    const onRevision = await analysis.query({ kind: "definition", path: "src/a.ts", line, column });
    assert.equal(onRevision.symbol, "alphaOnly",
      "the caret resolves against the revision on screen — the working tree would have said betaOnlyX");
    assert.deepEqual(paths(onRevision), ["src/a.ts"], "and its definition is found in the revision");
  } finally { analysis.dispose(); }
});

test("a result's preview line is the revision's line", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function shared() {\n  return 'OLD-BODY';\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "old body"]);
  const commitA = run(root, ["rev-parse", "HEAD"]);

  write(root, "src/a.ts", "export function shared() {\n  return 'NEW-BODY';\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "new body"]);

  const analysis = analyzerFor(root);
  try {
    analysis.setReviewTarget(commitA);
    const response = await analysis.query({ kind: "references", symbol: "shared", path: "src/a.ts", line: 1, column: 17 });
    const texts = (response.locations || []).map((item) => item.text || "").join("\n");
    assert.doesNotMatch(texts, /NEW-BODY/, "no line from the working tree leaks into a revision's results");
  } finally { analysis.dispose(); }
});
