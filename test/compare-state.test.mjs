// The diff toolbar says what it is comparing. A clean worktree moves the review to the branch point, and with
// nothing unpushed either it swings round to the tracking branch — three different reviews that used to look
// identical on screen ("로컬에 변경이 있는 건지, 없어서 리모트와 비교하는 건지 분간이 안 간다").
//
// Each mode is exercised through buildDiffReview, because the point is the mode the BUILD picks, not a
// renderer called with a hand-written state: the confusion came from the automatic base resolution, so a test
// that hands `{ mode: "incoming" }` to the renderer would pass while the app kept showing the wrong thing.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildDiffReview } from "../dist/build.js";
import { MESSAGES } from "../dist/i18n.js";

let fixture;
let repo;   // the checkout under review
let other;  // a second clone, used to put commits on the remote that `repo` has not got

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return (result.stdout || "").trim();
}
function review(root, extra) {
  return buildDiffReview({ root, staged: false, includeUntracked: true, context: 12, title: "t", lazyLoad: false, ...extra });
}
// The pill's mode is the class the renderer stamps on it; the name beside it is a data-i18n key, so the mode
// can be read out of the markup without depending on which locale the reader is in.
function pillMode(html) {
  return (html.match(/class="compare-pill compare-([a-z]+)"/) || [])[1] || null;
}
function pillRefs(html) {
  return [...html.matchAll(/<span class="compare-ref"(?: data-i18n="([^"]+)")?>([^<]*)</g)]
    .map((m) => m[1] || m[2]);
}

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "kakapo-compare-"));
  const remote = join(fixture, "remote.git");
  repo = join(fixture, "repo");
  other = join(fixture, "other");
  git(fixture, ["init", "--bare", "-q", remote]);
  git(fixture, ["clone", "-q", remote, repo]);
  git(repo, ["config", "user.email", "review@test.invalid"]);
  git(repo, ["config", "user.name", "Review Fixture"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["push", "-qu", "origin", "main"]);
  git(fixture, ["clone", "-q", remote, other]);
  git(other, ["config", "user.email", "other@test.invalid"]);
  git(other, ["config", "user.name", "Someone Else"]);
  // The bare repo's own HEAD still names whatever `git init` defaulted to, so the second clone lands on that
  // branch rather than on main. Put it on main explicitly instead of relying on the clone's guess.
  git(other, ["checkout", "-qB", "main", "origin/main"]);
});

after(() => rmSync(fixture, { recursive: true, force: true }));

test("an uncommitted edit says so, and names the working tree as the right-hand side", () => {
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 2;\n");
  const build = review(repo);
  assert.equal(pillMode(build.update.reviewStatus), "local");
  assert.deepEqual(pillRefs(build.update.reviewStatus), ["HEAD", "compare.worktree"]);
  assert.equal(build.update.compareBanner, "", "nothing to explain — this is the review you asked for");
  assert.match(build.html, /compare-pill compare-local/, "the first paint carries it too, not just the refresh");
});

test("committing the same edit turns the pill over to the unpushed commits, counted", () => {
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "local change"]);
  const build = review(repo);
  assert.equal(pillMode(build.update.reviewStatus), "ahead");
  assert.deepEqual(pillRefs(build.update.reviewStatus), ["origin/main", "HEAD"], "branch point on the left, your work on the right");
  assert.match(build.update.reviewStatus, /class="compare-count">1</, "one commit ahead");
  assert.equal(build.update.compareBanner, "");
});

test("with nothing of your own left, the review swings round to the remote — and says why", () => {
  git(repo, ["push", "-q"]);
  // Someone else pushes two commits this checkout has not got.
  git(other, ["fetch", "-q"]);
  git(other, ["reset", "-q", "--hard", "origin/main"]);
  writeFileSync(join(other, "src", "app.ts"), "export const value = 3;\n");
  git(other, ["commit", "-qam", "their first"]);
  writeFileSync(join(other, "src", "app.ts"), "export const value = 4;\n");
  git(other, ["commit", "-qam", "their second"]);
  git(other, ["push", "-q"]);
  git(repo, ["fetch", "-q"]);

  const build = review(repo);
  assert.equal(pillMode(build.update.reviewStatus), "incoming");
  assert.deepEqual(pillRefs(build.update.reviewStatus), ["HEAD", "origin/main"], "your checkout on the left, the remote on the right");
  assert.match(build.update.reviewStatus, /class="compare-count">2</, "two commits the remote is ahead by");
  // The state the whole thing exists for: the pill alone cannot say WHY the diff moved.
  assert.match(build.update.compareBanner, /data-i18n="compare\.incoming\.why"/);
  assert.match(build.update.compareBanner, /id="compare-open-history"/, "and offers the one place those commits can be read");
  assert.match(build.html, /compare-why/);
});

test("a base you picked yourself stays neutral and prints both revisions short", () => {
  const head = git(repo, ["rev-parse", "HEAD"]);
  const parent = git(repo, ["rev-parse", "HEAD~1"]);
  const build = review(repo, { base: parent, target: head });
  assert.equal(pillMode(build.update.reviewStatus), "manual");
  assert.deepEqual(pillRefs(build.update.reviewStatus), [parent.slice(0, 7), head.slice(0, 7)], "40 chars of SHA is unreadable at 11px");
  assert.equal(build.update.compareBanner, "", "you chose this one — there is nothing to explain");
});

test("--staged compares HEAD against the index, and names it that", () => {
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 9;\n");
  git(repo, ["add", "."]);
  const build = review(repo, { staged: true });
  assert.equal(pillMode(build.update.reviewStatus), "staged");
  assert.deepEqual(pillRefs(build.update.reviewStatus), ["HEAD", "compare.index"]);
  git(repo, ["reset", "-q", "--hard"]);
});

// The renderer builds the pill's label key as `compare.${mode}` — a mode without a row is a raw key on screen,
// and only in the locale that is missing it.
test("every mode has a name in every locale", () => {
  const keys = ["compare.local", "compare.staged", "compare.ahead", "compare.incoming", "compare.manual",
    "compare.worktree", "compare.index", "compare.title", "compare.incoming.why", "compare.openHistory"];
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const key of keys) assert.ok(messages[key], `${locale} is missing ${key}`);
  }
});
