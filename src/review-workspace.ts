import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDiffReview } from "./cli.js";
import { collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { git } from "./git.js";
import type { DiffReviewUpdate, SourceFile } from "./types.js";

// This is the stable input boundary between Electron window orchestration and review generation. Keeping
// it free of BrowserWindow/app types makes the expensive Git/build flow independently testable.
export type ReviewWorkspaceOptions = {
  root: string;
  base?: string;
  target?: string; // A→B compare: right/new side revision (undefined = working tree)
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  ignoreWhitespace: boolean;
};

export type ReviewWorkspaceSnapshot = {
  signature: string;
  html: string;
  update?: DiffReviewUpdate;
  reviewBase?: string;
  reviewTarget?: string;
  reviewUpstream?: string;
  bodyDiffs: string[];
  sourceFiles: SourceFile[];
  // Diff-first: true when sourceFiles holds ONLY the changed files and the full project index is still owed
  // (materialize it with collectReviewSourceIndex below, on demand). False for a full build.
  fullIndexDeferred: boolean;
};

export function writeReviewWorkspace(
  target: string,
  options: ReviewWorkspaceOptions,
  title: string,
  deferFullIndex = false,
): ReviewWorkspaceSnapshot {
  const build = buildDiffReview({
    base: options.base,
    target: options.target,
    staged: options.staged,
    includeUntracked: options.includeUntracked,
    context: options.context,
    title,
    ignoreWhitespace: options.ignoreWhitespace,
    lazyLoad: true,
    app: true,
    root: options.root,
    deferFullIndex,
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, build.html);
  return {
    signature: build.signature,
    html: build.html,
    update: build.update,
    reviewBase: build.reviewBase,
    reviewTarget: build.reviewTarget,
    reviewUpstream: build.reviewUpstream,
    bodyDiffs: build.lazyBodyDiffs ?? [],
    sourceFiles: build.lazySourceFiles ?? [],
    fullIndexDeferred: Boolean(build.fullIndexDeferred),
  };
}

// Materialize the FULL project index (every tracked file) for a review whose first paint was built diff-first
// (changed files only). Re-reads the unified diff to mark changed/vcs state — pinned to the same reviewBase/
// reviewTarget the initial build resolved — then enumerates the whole tree. Called on demand the first time
// the renderer asks for the project index (app-main's ensureFullProjectIndex), never on the first-paint path.
export function collectReviewSourceIndex(
  options: ReviewWorkspaceOptions,
  reviewBase?: string,
  reviewTarget?: string,
): SourceFile[] {
  const diffText = readUnifiedDiff({
    base: reviewBase ?? options.base,
    target: reviewTarget ?? options.target,
    staged: options.staged,
    context: options.context,
    includeUntracked: options.includeUntracked,
    ignoreWhitespace: options.ignoreWhitespace,
    root: options.root,
  });
  return collectSourceFiles(parseUnifiedDiff(diffText), options.root, {
    previewLargeText: true,
    deferSourceContent: true,
    target: reviewTarget ?? options.target,
  });
}

// The watcher depends on the same review inputs as the full builder, but intentionally hashes only the
// unified diff and upstream revision. This cheap probe keeps the main process responsive between changes.
export function reviewDiffSignature(
  options: ReviewWorkspaceOptions,
  reviewBase?: string,
  reviewUpstream?: string,
): string {
  const base = reviewBase ?? options.base;
  const upstreamRevision = reviewUpstream ? git(options.root, ["rev-parse", reviewUpstream]) : "";
  return createHash("sha1")
    .update(base ?? "HEAD")
    .update("\n")
    .update(upstreamRevision)
    .update("\n")
    .update(readUnifiedDiff({
      base,
      target: options.target,
      staged: options.staged,
      context: options.context,
      includeUntracked: options.includeUntracked,
      ignoreWhitespace: options.ignoreWhitespace,
      root: options.root,
    }))
    .digest("hex");
}
