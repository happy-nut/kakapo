// Build a real standalone review HTML from a throwaway git repo, exactly as `mo` ships it.
//
// We intentionally drive the *real* pipeline (git diff -> buildDiffReview) instead of hand-writing
// HTML: the regression we guard (comment save reading the wrong textarea) lived in the interaction
// between the server-rendered markup and the client script, so a fixture that skips either half
// would not catch it. buildDiffReview reads process.cwd(), so we chdir into the temp repo for the
// single synchronous call and always restore — node --test runs each file in its own process, but
// we still keep cwd clean so multiple fixtures in one file don't leak into each other.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_BUILD = join(HERE, "..", "..", "dist", "build.js");

let buildDiffReviewFn = null;
let renderLazyDiffBodyFn = null;
async function loadBuilder() {
  if (!buildDiffReviewFn) {
    const mod = await import(DIST_BUILD);
    buildDiffReviewFn = mod.buildDiffReview;
    renderLazyDiffBodyFn = mod.renderLazyDiffBody;
  }
  return buildDiffReviewFn;
}

const createdDirs = [];

/**
 * @param {Array<{path: string, before?: string, after?: string}>} files
 *   before === undefined -> file is created in the change (untracked/new)
 *   after  === undefined -> file is deleted in the change
 * @param {object} [opts] forwarded onto buildDiffReview (title, context, ignoreWhitespace, ...)
 * @returns {Promise<{dir: string, html: string, build: object}>}
 */
export async function makeReviewHtml(files, opts = {}) {
  const buildDiffReview = await loadBuilder();
  const dir = mkdtempSync(join(tmpdir(), "monacori-test-"));
  createdDirs.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@monacori.test"]);
  git(["config", "user.name", "monacori test"]);
  git(["config", "commit.gpgsign", "false"]);

  // Baseline commit: every file that has a `before` (i.e. exists prior to the change under review).
  const baseline = files.filter((f) => f.before !== undefined);
  for (const f of baseline) writeFile(dir, f.path, f.before);
  if (baseline.length) {
    git(["add", "-A"]);
    git(["commit", "-qm", "baseline"]);
  } else {
    // git needs at least one commit for `git diff` to have a base.
    writeFile(dir, ".monacori-keep", "");
    git(["add", "-A"]);
    git(["commit", "-qm", "baseline"]);
  }

  // Apply the change under review.
  for (const f of files) {
    if (f.after === undefined && f.before !== undefined) {
      rmSync(join(dir, f.path), { force: true });
    } else if (f.after !== undefined) {
      writeFile(dir, f.path, f.after);
    }
  }

  const prev = process.cwd();
  process.chdir(dir);
  let build;
  try {
    build = buildDiffReview({
      staged: false,
      includeUntracked: true,
      context: 12,
      title: "test",
      lazyLoad: false, // embed source so the standalone HTML is self-contained for jsdom
      app: false, // Electron-only review affordances are unnecessary in jsdom
      ...opts,
    });
  } finally {
    process.chdir(prev);
  }
  return { dir, html: build.html, build };
}

export async function renderLazyBodies(build) {
  await loadBuilder();
  return (build.lazyBodyDiffs || []).map((diff) => renderLazyDiffBodyFn(diff));
}

function writeFile(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Remove every temp repo created in this process. Call from an after() hook. */
export function cleanupFixtures() {
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
