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
  // The diffs are the biggest thing a build makes, so the snapshot carries WHERE they are, not the text: main
  // reads one slice when a body is asked for instead of holding every byte per workspace (review-workspace.ts).
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

// Explaining work that is already COMMITTED. The review is the branch's own commits (merge-base…HEAD), not a
// dirty worktree, and everything the explanation depends on has to survive that: the diff exists, the Changes
// panel has rows to anchor a beak on, and the run boundary — which is what makes a note a briefing — is

// The compare bar's "all changes" names a branch and measures against one, and those have to be the same
// branch. `readPatchSets` resolved the upstream-or-default regardless, while the click resolves whatever
// ⌥C last picked — persisted per repository and restored at open — so picking `develop` once left the bar
// reading `전체 변경 · origin/main` and measuring against `develop` for as long as it stayed picked.
//
// The second half is the guard that came with it: the branch list offers the branch you are ON, and a ref
// that CONTAINS HEAD has nothing ahead of it, so the bar would draw no patch sets and hide — taking the
// numbered sets and the "all" exit with it, on a setting that survives a restart.
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
    git(["branch", "develop"]);          // develop sits at the same commit as main
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

    // The branch you are on contains HEAD: nothing is ahead of it, and answering with it would empty the
    // one control that gets you back out.
    const own = readPatchSets(fixture, "work");
    assert.equal(own.branchPoint.label, "main",
      "a ref that contains HEAD falls through rather than leaving the bar with nothing to draw");
    assert.equal(own.commits.length, 2, "so the patch sets — and the way out — stay on screen");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// "A ref that contains HEAD cannot be a base" has to be ONE rule. Stated only where the patch-set bar
// reads it, the bar fell through and labelled its option `main` while set-compare-mode went on resolving
// the picked ref to HEAD — the same label-names-one-branch, click-uses-another split that threading the
// ref into the bar was meant to end, reinstated for exactly the refs the new check rejects.
//
// Asserted against the exported rule and against the source of its second reader, because the defect was
// a rule applied in one of two places and a test of one place cannot see that.
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

    // The second reader. app-main resolves the base for "all changes" and must apply the same rule, or
    // the bar's label and the click it labels name different branches again.
    const appMain = readFileSync(new URL("../dist/app-main.js", import.meta.url), "utf8");
    const at = appMain.indexOf('ipcMain.handle("kakapo:set-compare-mode"');
    assert.ok(at > 0, "the premise: the handler is findable");
    const handler = appMain.slice(at, appMain.indexOf("ipcMain.handle(", at + 1));
    assert.match(handler, /usableCompareBase\(/,
      "set-compare-mode resolves its base through the same rule, not with its own merge-base call");
    // The CALL, not the word. tsc keeps comments, and the handler's own prose explains why "all changes"
    // reduces to a merge-base while the tip mode beside it does not — which a bare /merge-base/ read as the
    // very thing it forbids. A guard that fires on the sentence describing the rule is a guard the next
    // person turns off. `git(root, ["merge-base", …])` is what this is about, and it is quoted.
    assert.ok(!/["']merge-base["']/.test(handler),
      "and does not keep a merge-base call of its own beside it");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
