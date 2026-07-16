import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { parseUnifiedDiff } from "./diff.js";
import { canonicalWorkspaceRoot, repoRoot } from "./git.js";

export type DiffContextRequest = {
  path?: unknown;
  oldStart?: unknown;
  oldEnd?: unknown;
  newStart?: unknown;
  newEnd?: unknown;
};

export type DiffContextResult = {
  ok: boolean;
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
  error?: string;
};

const MAX_CONTEXT_LINES = 1_000;

// Return only the requested folded range. The renderer never receives whole base revisions, and the
// path must belong to the current review diff before any filesystem/git read is attempted.
export function readReviewDiffContext(input: {
  root: string;
  base?: string;
  staged: boolean;
  bodyDiffs: string[];
  request: DiffContextRequest;
}): DiffContextResult {
  const path = normalizePath(input.request.path);
  const empty = (error: string): DiffContextResult => ({
    ok: false, oldStart: 0, newStart: 0, oldLines: [], newLines: [], error,
  });
  if (!path) return empty("Invalid review path");

  const file = input.bodyDiffs
    .flatMap((body) => parseUnifiedDiff(body))
    .find((candidate) => candidate.displayPath === path);
  if (!file) return empty("The file is not part of the current review");

  const oldRange = boundedRange(input.request.oldStart, input.request.oldEnd);
  const newRange = boundedRange(input.request.newStart, input.request.newEnd);
  if (!oldRange && !newRange) return empty("Invalid context range");

  // Review paths are relative to the folder the user opened. Git blobs still use repository-relative
  // paths, so prefix only the base/index lookup while reading the working tree directly from the selected
  // workspace. This keeps folded context correct for nested monorepo packages.
  const workspaceRoot = canonicalWorkspaceRoot(input.root);
  const root = repoRoot(workspaceRoot);
  const prefix = relative(root, workspaceRoot).replace(/\\/g, "/");
  const gitPath = (path: string) => prefix && prefix !== "." ? `${prefix}/${path}` : path;

  const oldText = file.oldPath === "/dev/null"
    ? ""
    : readGitBlob(root, `${input.staged ? "HEAD" : input.base || "HEAD"}:${gitPath(file.oldPath)}`);
  const newText = file.newPath === "/dev/null"
    ? ""
    : input.staged
      ? readGitBlob(root, `:${gitPath(file.newPath)}`)
      : readWorktreeFile(workspaceRoot, file.newPath);

  if (oldText === null && file.oldPath !== "/dev/null") return empty("Base source is unavailable");
  if (newText === null && file.newPath !== "/dev/null") return empty("Working source is unavailable");

  return {
    ok: true,
    oldStart: oldRange?.start ?? 0,
    newStart: newRange?.start ?? 0,
    oldLines: oldRange ? sliceLines(oldText || "", oldRange.start, oldRange.end) : [],
    newLines: newRange ? sliceLines(newText || "", newRange.start, newRange.end) : [],
  };
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return "";
  return path;
}

function boundedRange(startValue: unknown, endValue: unknown): { start: number; end: number } | null {
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end: Math.min(end, start + MAX_CONTEXT_LINES - 1) };
}

function readGitBlob(root: string, spec: string): string | null {
  const result = spawnSync("git", ["show", spec], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
  });
  return result.status === 0 ? result.stdout || "" : null;
}

function readWorktreeFile(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(absolute)) return null;
  try { return readFileSync(absolute, "utf8"); } catch { return null; }
}

function sliceLines(text: string, start: number, end: number): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(start - 1, end);
}
