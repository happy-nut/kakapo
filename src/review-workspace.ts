import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDiffReview } from "./cli.js";
import { collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { writeReviewBodies, type ReviewWorkspaceOptions } from "./review-bodies.js";
import type { DiffReviewUpdate, SourceFile } from "./types.js";

export { allReviewBodies, readReviewBody, reviewBodiesFile, reviewBodyCount, reviewDiffSignature } from "./review-bodies.js";
export type { ReviewWorkspaceOptions } from "./review-bodies.js";

export type ReviewWorkspaceSnapshot = {
  signature: string;
  html: string;
  update?: DiffReviewUpdate;
  reviewBase?: string;
  reviewTarget?: string;
  reviewUpstream?: string;
  watchSignature: string;
  bodies: { file: string; offsets: number[] };
  sourceFiles: SourceFile[];
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
    whitespace: options.whitespace,
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
    watchSignature: build.watchSignature,
    bodies,
    sourceFiles: build.lazySourceFiles ?? [],
    fullIndexDeferred: Boolean(build.fullIndexDeferred),
  };
}

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
    whitespace: options.whitespace,
    root: options.root,
  });
  return collectSourceFiles(parseUnifiedDiff(diffText), options.root, {
    previewLargeText: true,
    deferSourceContent: true,
    target: reviewTarget ?? options.target,
  });
}

