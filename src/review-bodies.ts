import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalWorkspaceRoot, git } from "./git.js";

// Everything about a built review that the MAIN process needs, and nothing that builds one. The split is not
// tidiness: review-workspace.ts reaches buildDiffReview, and through it diff2html and highlight.js — 100ms of
// parse that only the build worker has any use for, and that app-main was paying on every cold start to call
// reviewBodyCount and hash a watch signature. Main imports this file; the worker imports both.

export type ReviewWorkspaceOptions = {
  root: string;
  base?: string;
  // What to CALL the base on the toolbar pill. The compare dropdown resolves a branch to its merge-base
  // before diffing (see app-main's set-compare-mode), and a 7-char SHA on the pill answers a question nobody
  // asked — the reader picked "main", so the pill says main.
  baseLabel?: string;
  // `kakapo <file>`: the file the first paint should land on, relative to root.
  openPath?: string;
  target?: string; // A→B compare: right/new side revision (undefined = working tree)
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  ignoreWhitespace: boolean;
};

// One file, appended in build order, with a [start, length] pair per diff. A slice read is what a body costs
// to fetch — no parse, no index of its own, and nothing retained between requests.
export function reviewBodiesFile(target: string): string {
  return join(dirname(target), "bodies.diff");
}
export function writeReviewBodies(target: string, diffs: string[]): { file: string; offsets: number[] } {
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

// The watcher depends on the same review inputs as the full builder, but intentionally hashes only the
// unified diff and upstream revision. This cheap probe keeps the main process responsive between changes.
export function reviewDiffSignature(
  options: ReviewWorkspaceOptions,
  reviewBase?: string,
  reviewUpstream?: string,
): string {
  const base = reviewBase ?? options.base;
  const upstreamRevision = reviewUpstream ? git(options.root, ["rev-parse", reviewUpstream]) : "";
  // NOT the unified diff. This runs on the watch tick and on every activation, in the MAIN process, and the
  // diff of a large review is enormous: on a 1,352-file compare `git diff` was 15s of blocked main thread per
  // sweep, plus 1.6s decoding 106 MB to a string and 4s hashing it — the app-wide lag a workspace switch had.
  //
  // The question being asked is only "has anything changed since the last build". `--raw` answers it exactly:
  // one line per path with the blob hashes and status, which move if and only if content moves, and it is
  // kilobytes rather than megabytes. Untracked files carry their own (path, size, mtime) because they have no
  // blob yet. The REAL signature is still the one the build computes from the diff itself.
  const root = canonicalWorkspaceRoot(options.root ?? process.cwd());
  const args = ["diff", "--no-ext-diff", "--find-renames", "--relative", "--raw", "--abbrev=40"];
  if (options.target) args.push(options.base ?? "HEAD", options.target);
  else if (options.staged) args.push("--cached");
  else args.push(options.base ?? "HEAD");
  args.push("--", ".");
  const raw = git(root, args);
  // `--raw` names the new blob only when there IS one. An unstaged edit has not been hashed yet, so git prints
  // all-zeros for that side and the line does not move when the file's content does — the probe would sleep
  // through exactly the edits the watch exists for. Stat what the raw output names, which is what the working
  // tree has to say for itself.
  const touched = raw.split("\n").filter(Boolean).map((line) => {
    const paths = line.split("\t").slice(1);
    return paths.map((path) => {
      try {
        const stat = statSync(join(root, path));
        return `${path}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
      } catch { return `${path}\0gone`; }
    }).join("\t");
  }).join("\n");
  const untracked = options.includeUntracked && !options.target
    ? git(root, ["ls-files", "--others", "--exclude-standard", "--", "."])
        .split("\n").filter(Boolean)
        .map((path) => {
          try {
            const stat = statSync(join(root, path));
            return `${path}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
          } catch { return `${path}\0gone`; }
        })
        .join("\n")
    : "";
  return createHash("sha1")
    .update(base ?? "HEAD")
    .update("\n")
    .update(upstreamRevision)
    .update("\n")
    .update(options.staged ? "staged" : "worktree")
    .update("\n")
    .update(raw)
    .update("\n")
    .update(touched)
    .update("\n")
    .update(untracked)
    .digest("hex");
}

