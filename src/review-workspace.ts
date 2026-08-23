import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// One file, appended in build order, with a [start, length] pair per diff. A slice read is what a body costs
// to fetch — no parse, no index of its own, and nothing retained between requests.
export function reviewBodiesFile(target: string): string {
  return join(dirname(target), "bodies.diff");
}
function writeReviewBodies(target: string, diffs: string[]): { file: string; offsets: number[] } {
  const file = reviewBodiesFile(target);
  const offsets: number[] = [];
  const chunks: Buffer[] = [];
  let at = 0;
  for (const diff of diffs) {
    const buffer = Buffer.from(diff, "utf8");
    offsets.push(at, buffer.length);
    chunks.push(buffer);
    at += buffer.length;
  }
  writeFileSync(file, Buffer.concat(chunks));
  return { file, offsets };
}

export function readReviewBody(bodies: { file: string; offsets: number[] } | undefined, index: number): string {
  if (!bodies || !Number.isInteger(index) || index < 0) return "";
  const start = bodies.offsets[index * 2];
  const length = bodies.offsets[index * 2 + 1];
  if (start === undefined || !length) return "";
  let fd: number | undefined;
  try {
    fd = openSync(bodies.file, "r");
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return ""; // the build that wrote it has been replaced; the caller re-asks after the next one
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}
// The one caller that needs every diff at once (folding context open, which searches the review for a path).
// It reads the file in one go and throws the strings away with the call — the opposite of holding them.
export function allReviewBodies(bodies: { file: string; offsets: number[] } | undefined): string[] {
  if (!bodies || !bodies.offsets.length) return [];
  let raw: Buffer;
  try { raw = readFileSync(bodies.file); } catch { return []; }
  const out: string[] = [];
  for (let at = 0; at < bodies.offsets.length; at += 2) {
    const start = bodies.offsets[at];
    const length = bodies.offsets[at + 1];
    out.push(raw.subarray(start, start + length).toString("utf8"));
  }
  return out;
}
// How many files this build carried, for the callers that only need the count.
export function reviewBodyCount(bodies: { file: string; offsets: number[] } | undefined): number {
  return bodies ? bodies.offsets.length / 2 : 0;
}

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
