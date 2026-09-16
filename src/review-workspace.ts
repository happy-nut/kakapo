import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDiffReview } from "./cli.js";
import { collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { writeReviewBodies, type ReviewWorkspaceOptions } from "./review-bodies.js";
import type { DiffReviewUpdate, SourceFile } from "./types.js";

// The READ side of a built review — body slices and the watch signature — lives in review-bodies.js so the
// main process can have it without dragging in the builder this file imports. Re-exported for callers that
// legitimately want both halves (the build worker).
export { allReviewBodies, readReviewBody, reviewBodiesFile, reviewBodyCount, reviewDiffSignature } from "./review-bodies.js";
export type { ReviewWorkspaceOptions } from "./review-bodies.js";

// This is the stable input boundary between Electron window orchestration and review generation. Keeping
// it free of BrowserWindow/app types makes the expensive Git/build flow independently testable.

export type ReviewWorkspaceSnapshot = {
  signature: string;
  html: string;
  update?: DiffReviewUpdate;
  reviewBase?: string;
  reviewTarget?: string;
  reviewUpstream?: string;
  // Where this build's per-file diffs are, NOT the diffs themselves. On a large review they are the biggest
  // thing a build produces — 106 MB of text for a 1,352-file compare — and main used to hold every byte of it
  // for every open workspace, cloned across the worker boundary to get there. They are written beside the
  // review HTML instead, and read one slice at a time when a body is actually asked for.
  bodies: { file: string; offsets: number[] }; // offsets: [start, length, start, length, …] by file index
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
    baseLabel: options.baseLabel,
    openPath: options.openPath,
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
  const bodies = writeReviewBodies(target, build.lazyBodyDiffs ?? []);
  return {
    signature: build.signature,
    html: build.html,
    update: build.update,
    reviewBase: build.reviewBase,
    reviewTarget: build.reviewTarget,
    reviewUpstream: build.reviewUpstream,
    bodies,
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

