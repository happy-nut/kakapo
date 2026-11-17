import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalWorkspaceRoot, git } from "./git.js";
import type { WhitespaceMode } from "./types.js";

export type ReviewWorkspaceOptions = {
  root: string;
  base?: string;
  baseLabel?: string;
  openPath?: string;
  target?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  ignoreWhitespace: boolean;
  whitespace?: WhitespaceMode;
};

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
    return "";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { } }
  }
}
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
export function reviewBodyCount(bodies: { file: string; offsets: number[] } | undefined): number {
  return bodies ? bodies.offsets.length / 2 : 0;
}

export function reviewDiffSignature(
  options: ReviewWorkspaceOptions,
  reviewBase?: string,
  reviewUpstream?: string,
): string {
  const base = reviewBase ?? options.base;
  const upstreamRevision = reviewUpstream ? git(options.root, ["rev-parse", reviewUpstream]) : "";
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

