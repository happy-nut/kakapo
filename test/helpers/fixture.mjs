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

export async function makeReviewHtml(files, opts = {}) {
  const buildDiffReview = await loadBuilder();
  const dir = mkdtempSync(join(tmpdir(), "kakapo-test-"));
  createdDirs.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@kakapo.test"]);
  git(["config", "user.name", "kakapo test"]);
  git(["config", "commit.gpgsign", "false"]);

  const baseline = files.filter((f) => f.before !== undefined);
  for (const f of baseline) writeFile(dir, f.renamedFrom || f.path, f.before);
  if (baseline.length) {
    git(["add", "-A"]);
    git(["commit", "-qm", "baseline"]);
  } else {
    // git needs at least one commit for `git diff` to have a base.
    writeFile(dir, ".kakapo-keep", "");
    git(["add", "-A"]);
    git(["commit", "-qm", "baseline"]);
  }

  for (const f of files) {
    if (f.renamedFrom) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      git(["mv", f.renamedFrom, f.path]);
      if (f.after !== undefined) writeFile(dir, f.path, f.after);
    } else if (f.after === undefined && f.before !== undefined) {
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
      lazyLoad: false,
      app: false,
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

export function cleanupFixtures() {
  while (createdDirs.length) {
    const dir = createdDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
