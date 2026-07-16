import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildDiffReview } from "../dist/build.js";
import { resolveAutomaticReviewBase } from "../dist/git.js";

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
