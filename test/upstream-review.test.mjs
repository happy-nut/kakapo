import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildDiffReview } from "../dist/build.js";
import { resolveAutomaticReviewBase } from "../dist/git.js";
import { reviewDiffSignature, writeReviewWorkspace } from "../dist/review-workspace.js";

let fixture;
let repo;
let baseline;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return (result.stdout || "").trim();
}

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "kakapo-upstream-"));
  const remote = join(fixture, "remote.git");
  repo = join(fixture, "repo");
  mkdirSync(repo);
  git(fixture, ["init", "--bare", "-q", remote]);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "review@test.invalid"]);
  git(repo, ["config", "user.name", "Review Fixture"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  git(repo, ["branch", "-M", "main"]);
  baseline = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-qu", "origin", "main"]);

  writeFileSync(join(repo, "src", "app.ts"), "export const value = 2;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "local AI change"]);
});

after(() => rmSync(fixture, { recursive: true, force: true }));

test("a clean branch ahead of upstream automatically reviews its local commits", () => {
  const selected = resolveAutomaticReviewBase(repo, true);
  assert.deepEqual(
    { revision: selected?.revision, upstream: selected?.upstream, ahead: selected?.ahead },
    { revision: baseline, upstream: "origin/main", ahead: 1 },
  );

  const build = buildDiffReview({
    root: repo,
    staged: false,
    includeUntracked: true,
    context: 12,
    title: "upstream review",
    lazyLoad: true,
    app: true,
  });
  assert.equal(build.reviewBase, baseline, "the build exposes the exact base for folded-context requests");
  assert.equal(build.reviewUpstream, "origin/main", "the app can watch the tracking ref for a later push");
  assert.equal(build.files, 1, "the committed change is not reported as an empty worktree");
  assert.match(build.html, /src\/app\.ts/, "the ahead commit appears in the Changes panel");
});

test("an uncommitted edit keeps the normal HEAD-to-worktree review scope", () => {
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 3;\n");
  const build = buildDiffReview({
    root: repo,
    staged: false,
    includeUntracked: true,
    context: 12,
    title: "working review",
    lazyLoad: true,
    app: true,
  });
  assert.equal(build.reviewBase, undefined);
  assert.equal(build.reviewUpstream, undefined);
  assert.equal(build.files, 1);
});

test("review workspace service persists a lazy snapshot and detects later Git changes", () => {
  const options = {
    root: repo,
    staged: false,
    includeUntracked: true,
    context: 12,
    ignoreWhitespace: false,
  };
  const target = join(fixture, "app-data", "review", "app-review.html");
  const snapshot = writeReviewWorkspace(target, options, "Kakapo");

  assert.equal(readFileSync(target, "utf8"), snapshot.html);
  assert.ok(snapshot.bodyDiffs.length > 0, "lazy diff bodies remain available to the IPC adapter");
  assert.ok(snapshot.sourceFiles.some((file) => file.path === "src/app.ts"), "source metadata survives the service boundary");

  const before = reviewDiffSignature(options, snapshot.reviewBase, snapshot.reviewUpstream);
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 4;\n");
  const afterChange = reviewDiffSignature(options, snapshot.reviewBase, snapshot.reviewUpstream);
  assert.notEqual(afterChange, before, "the cheap watcher signature changes without rebuilding the review");
});

// Nothing of your own to review — clean worktree, nothing unpushed — but the tracking branch has moved on.
// An empty review is the least useful answer there: what is left to read is what the remote has and this
// checkout does not, so the review pins its right side to the tracking branch and shows the incoming change.
// (Explain annotates whatever the review shows, so this is also what makes "explain this diff" work there.)
test("a clean branch BEHIND upstream reviews the incoming change instead of nothing", () => {
  const behindRepo = join(fixture, "behind");
  // The bare fixture's HEAD still points at its default branch, so name the one we actually pushed.
  git(fixture, ["clone", "-q", "-b", "main", join(fixture, "remote.git"), behindRepo]);
  git(behindRepo, ["config", "user.email", "review@test.invalid"]);
  git(behindRepo, ["config", "user.name", "Review Fixture"]);
  const atClone = git(behindRepo, ["rev-parse", "HEAD"]);

  // Someone else pushes; this checkout fetches but has not merged. Nothing local, nothing unpushed.
  git(repo, ["push", "-q", "origin", "main"]);
  git(behindRepo, ["fetch", "-q"]);
  assert.equal(git(behindRepo, ["status", "--porcelain"]), "", "the worktree is clean");

  const selected = resolveAutomaticReviewBase(behindRepo, true);
  assert.deepEqual(
    { revision: selected?.revision, upstream: selected?.upstream, ahead: selected?.ahead, target: selected?.target },
    { revision: atClone, upstream: "origin/main", ahead: 0, target: "origin/main" },
    "the right side is the tracking branch, anchored at the merge-base",
  );
  assert.equal(selected?.behind, 1, "and it reports how much is incoming");

  const build = buildDiffReview({
    root: behindRepo,
    staged: false,
    includeUntracked: true,
    context: 12,
    title: "incoming review",
    lazyLoad: true,
    app: true,
  });
  assert.ok(build.html.includes("src/app.ts"), "the incoming file is in the review");
  assert.equal(build.reviewTarget, "origin/main", "the build reports the pinned right side");
  // lazyLoad keeps file bodies out of the shell, so the incoming line lives in the deferred diffs.
  assert.match((build.lazyBodyDiffs || []).join("\n"), /value = 2/,
    "and shows what the remote has, not the local baseline");
});

// Explaining work that is already COMMITTED. The review is the branch's own commits (merge-base…HEAD), not a
// dirty worktree, and everything the explanation depends on has to survive that: the diff exists, the Changes
// panel has rows to anchor a beak on, and the run boundary — which is what makes a note a briefing — is
// recorded by sending the prompt, not by anything about the tree being dirty.
test("a briefing appears for an explanation of already-committed work", async () => {
  const { loadViewer } = await import("./helpers/dom.mjs");
  const build = buildDiffReview({
    root: repo, staged: false, includeUntracked: true, context: 12,
    title: "committed review", lazyLoad: false, app: false,
  });
  assert.ok(build.files >= 1, "the committed change is the review");

  const v = await loadViewer(build.html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };
  v.window.showDiffView(false);
  await v.settle(40);

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(20);
  v.key("Enter");
  await v.settle(30);
  assert.equal(sent.length, 1, "the explain prompt went out");

  v.agentSays({
    kind: "note", role: "problem", group: 1, path: "src/app.ts", line: 1, title: "why",
    text: "## The value was wrong\nIt read 1.\n\n## It reads 2 now\nOne line.\n\n## Start in src/app.ts\n- `src/app.ts` — the only file that changed.",
  });
  await v.settle(60);

  const pop = v.$("#mc-briefing");
  assert.ok(pop, "the briefing opens on a committed diff exactly as on a dirty one");
  assert.match(pop.querySelector(".mc-brf-h").textContent, /value was wrong/);
  assert.ok(v.$('#changes-panel .change-row[data-file="src/app.ts"]'), "and the file it points at is in the Changes list");
  v.close();
});
