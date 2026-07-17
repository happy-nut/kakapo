import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDiffReview } from "./cli.js";
import { readUnifiedDiff } from "./diff.js";
import { git } from "./git.js";
import type { DiffReviewUpdate, SourceFile } from "./types.js";

// This is the stable input boundary between Electron window orchestration and review generation. Keeping
// it free of BrowserWindow/app types makes the expensive Git/build flow independently testable.
export type ReviewWorkspaceOptions = {
  root: string;
  base?: string;
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
  reviewUpstream?: string;
  bodyDiffs: string[];
  sourceFiles: SourceFile[];
};

export function writeReviewWorkspace(
  target: string,
  options: ReviewWorkspaceOptions,
  title: string,
): ReviewWorkspaceSnapshot {
  const build = buildDiffReview({
    base: options.base,
    staged: options.staged,
    includeUntracked: options.includeUntracked,
    context: options.context,
    title,
    ignoreWhitespace: options.ignoreWhitespace,
    lazyLoad: true,
    app: true,
    root: options.root,
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, build.html);
  return {
    signature: build.signature,
    html: build.html,
    update: build.update,
    reviewBase: build.reviewBase,
    reviewUpstream: build.reviewUpstream,
    bodyDiffs: build.lazyBodyDiffs ?? [],
    sourceFiles: build.lazySourceFiles ?? [],
  };
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
      staged: options.staged,
      context: options.context,
      includeUntracked: options.includeUntracked,
      ignoreWhitespace: options.ignoreWhitespace,
      root: options.root,
    }))
    .digest("hex");
}
