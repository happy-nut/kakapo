// Navigation answers about the revision on screen, not about the working tree.
//
// kakapo supports an A→B compare whose right side is an exact revision (app-main.ts: "exact right/new side
// revision for an A→B compare"). Every read in ProjectAnalysis used to come from `locationFilePath`, which
// is `join(root, path)` — the working tree — so in that mode the index described a DIFFERENT text than the
// one being read. It went wrong in two shapes, and both fixtures below are the ones it was reproduced in:
//
//   renamed symbol  — answered with nothing, which LOOKS like an answer of "none"
//   moved symbol    — answered with the file the symbol lives in TODAY, a file that may not have existed in
//                     the revision being read, indistinguishable from a correct jump
//
// The index is now built from the revision and content is read through it, so the assertions here are the
// inverse of what the bug produced. The second test is the sharpest: a name that exists ONLY at HEAD must
// come back empty while an older revision is on screen.
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
// No language server, and that is not only for speed: a server reads the working tree and cannot be pointed
// at a revision, so on a revision there is never one in play. Stubbing it out here matches production.
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
    // The control. Without it, an implementation that always answered from the revision — or never
    // answered at all — would satisfy everything below.
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

    // The direction that proves the index is really the revision's: the CURRENT name must not resolve.
    // A working-tree index would have found it, which is exactly the bug.
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
    // Reading a whole tree introduced a new way to be silently empty: a revision git cannot resolve yields
    // an index with no files, and then every answer is `[]` — "nothing there" instead of "nothing looked
    // at". That is the failure this whole change set out to remove, so it is named.
    analysis.setReviewTarget("notarevisionatall");
    const declined = await analysis.query({ kind: "definition", symbol: "alpha", path: "src/a.ts", line: 1, column: 17 });
    assert.equal(declined.ok, false, "an unreadable revision is not an answer");
    assert.equal(declined.declined, "revision", "and says so by name");
    assert.deepEqual(declined.locations, []);

    // Control: a readable revision does NOT decline, so the check above is about readability and not about
    // being on a revision at all.
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
    // Unlike navigation, this one cannot be fixed by reading the revision: diagnostics come from a language
    // server, and a server reads the working tree. Its line numbers would still LAND on the revision, which
    // is what makes it worse than a wrong jump — plausible squiggles for problems in a different text.
    const diagnostics = await analysis.diagnostics("src/a.ts");
    assert.equal(diagnostics.available, false, "nothing can judge a revision's text");
    assert.deepEqual(diagnostics.diagnostics, []);
  } finally { analysis.dispose(); }
});

// The tree reader, directly. Its failure mode is silence — a wrong pathspec returns an empty list, which
// looks exactly like an empty revision — so the two inputs that produce a wrong pathspec are pinned here.
test("the tree reader survives the paths git allows and Node's idea of them", async () => {
  const root = repo();
  // A path git quotes and escapes without -z. Reading ls-tree line by line mangles this into a path that
  // exists nowhere, and the file silently drops out of the index.
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
  // Byte-exact against git itself. The record length in `cat-file --batch` is in BYTES, so a parser that
  // decodes before slicing drifts on exactly these files and on nothing else.
  for (const path of listed) {
    const expected = execFileSync("git", ["show", `${head}:${path}`], { cwd: root, encoding: "utf8" });
    assert.equal(byPath.get(path), expected, `${path} reads back byte-for-byte`);
  }

  // And the whole thing works from a SUBDIRECTORY, where paths are workspace-relative and git specs are
  // repository-relative. Computing that prefix with `relative(repoRoot(root), root)` is wrong whenever the
  // path reaches the repository through a symlink — on macOS the temp directory does, so this fixture
  // returned nothing at all until the prefix came from `git rev-parse --show-prefix`.
  const nested = join(root, "src");
  assert.deepEqual(
    listRevisionFiles(nested, head).sort(),
    ["plain.ts", "weißbier café.ts"],
    "paths come back relative to the workspace, not the repository",
  );
});

test("the viewer tells a found-in-revision answer apart from a still-indexing one", () => {
  const client = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  // A revision answer always carries a fallbackReason (no server can read a revision). Left alone, that
  // made every one of them read as "still indexing" — telling the reviewer to wait for an answer that is
  // never coming.
  assert.match(client, /if \(response\.revision\) return false;/,
    "a revision answer is excluded from the still-indexing label");
  assert.match(client, /monaco\.analysisRevisionMatched/, "and gets its own, which names the revision");
  assert.match(client, /monaco\.analysisRevision'/, "the unreadable-revision decline still has a message");
  // One per navigation that asks the analysis layer a question and then JUMPS somewhere with the answer:
  // definition-or-usages, find usages, implementation, type declaration, supertype. A new one belongs in
  // this count — which is the point of counting rather than sampling. (The structure popup and the two
  // hierarchies are not here: they render the decline in their own panel instead of jumping.)
  const sites = client.match(/if \(declinedForRevision\(response, name\)\) return;/g) || [];
  assert.equal(sites.length, 5, `every jumping navigation checks the decline (found ${sites.length})`);
});

// readSource, which is the actual routing point: four call sites used to read the working tree directly.
//
// Every test above passes `symbol:` explicitly, and that short-circuits symbolContext entirely — so none of
// them read a single byte of file content, and removing the revision branch from readSource left them all
// passing. This one asks the question the way the viewer does: a path and a caret position, no symbol. The
// identifier under that caret has to be read out of the revision's text, and the working tree has a
// DIFFERENT identifier at the same position.
test("the symbol under the caret is read from the revision's text, not the working tree's", async () => {
  const root = repo();
  write(root, "src/a.ts", "export function alphaOnly() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "alphaOnly"]);
  const commitA = run(root, ["rev-parse", "HEAD"]);

  // Same file, same line, same column — a different name sits there now. Padded to the identical length so
  // the column cannot be what distinguishes them.
  write(root, "src/a.ts", "export function betaOnlyX() {\n  return 1;\n}\n");
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "betaOnlyX"]);

  const analysis = analyzerFor(root);
  try {
    // `line` is a 0-BASED index, so the declaration is line 0. Written as 1 first, this landed on
    // `  return 1;`, where there is no identifier at all — symbolContext then fell through to its index
    // lookup and returned the right answer for the wrong reason, passing while readSource was bypassed.
    const line = 0;
    const column = "export function ".length + 2; // inside the identifier, whichever one is there

    const onWorktree = await analysis.query({ kind: "definition", path: "src/a.ts", line, column });
    assert.equal(onWorktree.symbol, "betaOnlyX", "control: the working tree resolves its own identifier");

    analysis.setReviewTarget(commitA);
    const onRevision = await analysis.query({ kind: "definition", path: "src/a.ts", line, column });
    assert.equal(onRevision.symbol, "alphaOnly",
      "the caret resolves against the revision on screen — the working tree would have said betaOnlyX");
    assert.deepEqual(paths(onRevision), ["src/a.ts"], "and its definition is found in the revision");
  } finally { analysis.dispose(); }
});

// The result preview text comes through readSource too (withText). A location labelled with the working
// tree's line, under a revision's diff, is a quieter version of the same lie.
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
