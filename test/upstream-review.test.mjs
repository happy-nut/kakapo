import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildDiffReview } from "../dist/build.js";
import { resolveAutomaticReviewBase } from "../dist/git.js";
import { readPatchSets, usableCompareBase } from "../dist/patch-sets.js";
import { readReviewBody, reviewDiffSignature, writeReviewWorkspace } from "../dist/review-workspace.js";

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
  assert.ok(snapshot.bodies.offsets.length > 0, "the snapshot carries an index of the lazy diff bodies");
  assert.ok(existsSync(snapshot.bodies.file), "and the file they were written to");
  assert.match(readReviewBody(snapshot.bodies, 0), /^diff --git|^--- |^\+\+\+ |@@/m,
    "a slice read off it is that file's own diff");
  assert.ok(snapshot.sourceFiles.some((file) => file.path === "src/app.ts"), "source metadata survives the service boundary");

  const before = reviewDiffSignature(options, snapshot.reviewBase, snapshot.reviewUpstream);
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 4;\n");
  const afterChange = reviewDiffSignature(options, snapshot.reviewBase, snapshot.reviewUpstream);
  assert.notEqual(afterChange, before, "the cheap watcher signature changes without rebuilding the review");
});

test("a clean branch BEHIND upstream reviews the incoming change instead of nothing", () => {
  const behindRepo = join(fixture, "behind");
  git(fixture, ["clone", "-q", "-b", "main", join(fixture, "remote.git"), behindRepo]);
  git(behindRepo, ["config", "user.email", "review@test.invalid"]);
  git(behindRepo, ["config", "user.name", "Review Fixture"]);
  const atClone = git(behindRepo, ["rev-parse", "HEAD"]);

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
  assert.match((build.lazyBodyDiffs || []).join("\n"), /value = 2/,
    "and shows what the remote has, not the local baseline");
});

test("an untracked feature branch stops showing commits already merged into remote main", () => {
  const mergedRemote = join(fixture, "merged-remote.git");
  const feature = join(fixture, "merged-feature");
  const integrator = join(fixture, "merged-integrator");
  git(fixture, ["init", "--bare", "-q", mergedRemote]);
  git(fixture, ["clone", "-q", mergedRemote, feature]);
  git(feature, ["config", "user.email", "review@test.invalid"]);
  git(feature, ["config", "user.name", "Review Fixture"]);
  writeFileSync(join(feature, "app.ts"), "before\n");
  git(feature, ["add", "."]);
  git(feature, ["commit", "-qm", "baseline"]);
  git(feature, ["branch", "-M", "main"]);
  git(feature, ["push", "-qu", "origin", "main"]);
  git(feature, ["checkout", "-qb", "feature"]);
  writeFileSync(join(feature, "app.ts"), "after\n");
  git(feature, ["commit", "-qam", "feature change"]);
  git(feature, ["push", "-q", "origin", "feature"]);
  git(fixture, ["clone", "-q", "-b", "main", mergedRemote, integrator]);
  git(integrator, ["config", "user.email", "review@test.invalid"]);
  git(integrator, ["config", "user.name", "Review Fixture"]);
  git(integrator, ["merge", "-q", "--no-ff", "origin/feature", "-m", "merge feature"]);
  git(integrator, ["push", "-q", "origin", "main"]);
  git(feature, ["fetch", "-q", "origin"]);

  assert.equal(resolveAutomaticReviewBase(feature, true), undefined,
    "remote main already contains HEAD, even though stale local main does not");
  assert.equal(readPatchSets(feature).commits.length, 0,
    "the compare bar uses the same remote base and drops the merged patch sets");
  assert.equal(buildDiffReview({
    root: feature, staged: false, includeUntracked: true, context: 12,
    title: "merged review", lazyLoad: true, app: true,
  }).files, 0);
});

test("the patch-set base follows the branch the compare control is set to", () => {
  const fixture = mkdtempSync(join(tmpdir(), "kakapo-patchset-ref-"));
  const git = (args) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
  try {
    git(["init", "-qb", "main"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(fixture, "a.txt"), "one\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    git(["branch", "develop"]);
    git(["checkout", "-qb", "work"]);
    writeFileSync(join(fixture, "a.txt"), "two\n");
    git(["commit", "-qam", "ahead one"]);
    writeFileSync(join(fixture, "a.txt"), "three\n");
    git(["commit", "-qam", "ahead two"]);

    const plain = readPatchSets(fixture);
    assert.equal(plain.commits.length, 2, "the premise: two commits ahead of the default branch");
    assert.equal(plain.branchPoint.label, "main", "and the default is what it resolves without a preference");

    const preferred = readPatchSets(fixture, "develop");
    assert.equal(preferred.branchPoint.label, "develop",
      "the picked branch is what the bar names, because it is what the click will use");
    assert.equal(preferred.commits.length, 2, "and it still enumerates what is ahead of it");

    const own = readPatchSets(fixture, "work");
    assert.equal(own.branchPoint.label, "main",
      "a ref that contains HEAD falls through rather than leaving the bar with nothing to draw");
    assert.equal(own.commits.length, 2, "so the patch sets — and the way out — stay on screen");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the rule about an unusable base is one rule, read by both sides", () => {
  const fixture = mkdtempSync(join(tmpdir(), "kakapo-usable-base-"));
  const git = (args) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
  try {
    git(["init", "-qb", "main"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(fixture, "a.txt"), "one\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    git(["checkout", "-qb", "work"]);
    writeFileSync(join(fixture, "a.txt"), "two\n");
    git(["commit", "-qam", "ahead"]);

    assert.ok(usableCompareBase(fixture, "main"), "a branch behind HEAD gives a base");
    assert.equal(usableCompareBase(fixture, "work"), undefined,
      "the branch you are on does not — it has nothing ahead of it");
    assert.equal(usableCompareBase(fixture, "no-such-branch"), undefined, "and neither does a ref that is gone");

    const appMain = readFileSync(new URL("../dist/app-main.js", import.meta.url), "utf8");
    const at = appMain.indexOf('ipcMain.handle("kakapo:set-compare-mode"');
    assert.ok(at > 0, "the premise: the handler is findable");
    const handler = appMain.slice(at, appMain.indexOf("ipcMain.handle(", at + 1));
    assert.match(handler, /usableCompareBase\(/,
      "set-compare-mode resolves its base through the same rule, not with its own merge-base call");
    assert.ok(!/["']merge-base["']/.test(handler),
      "and does not keep a merge-base call of its own beside it");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
