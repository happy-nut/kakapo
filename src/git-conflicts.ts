import { git } from "./git.js";

export type FileCollision = {
  path: string;
  /** "conflict": both sides changed the same lines. "diverged": same file, different lines. */
  kind: "conflict" | "diverged";
  /** Lines (in merge-base coordinates) both sides changed. Empty for "diverged". */
  lines: number[];
};

export type BaseDivergence = {
  mergeBase: string;
  collisions: FileCollision[];
};

type Range = { start: number; count: number };

// The `-` side of a `@@ -a,b +c,d @@` header: which lines of the OLD revision this hunk replaces. With
// --unified=0 that is exactly the changed region and nothing around it. A count of 0 is an insertion, which
// occupies no old line but sits between two of them — recorded as a zero-width range at that point so an
// insertion by both sides in the same place still reads as a collision.
function oldRanges(diffText: string): Range[] {
  const ranges: Range[] = [];
  for (const line of diffText.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start)) continue;
    ranges.push({ start, count: Number.isFinite(count) ? count : 1 });
  }
  return ranges;
}

function overlappingLines(ours: Range[], theirs: Range[]): number[] {
  const hit = new Set<number>();
  for (const a of ours) {
    for (const b of theirs) {
      if (a.count === 0 || b.count === 0) {
        const insertion = a.count === 0 ? a : b;
        const other = a.count === 0 ? b : a;
        if (other.count === 0) {
          if (other.start === insertion.start) hit.add(insertion.start);
          continue;
        }
        if (insertion.start >= other.start && insertion.start < other.start + other.count) hit.add(insertion.start);
        continue;
      }
      const from = Math.max(a.start, b.start);
      const to = Math.min(a.start + a.count, b.start + b.count);
      for (let line = from; line < to; line += 1) hit.add(line);
    }
  }
  return [...hit].sort((x, y) => x - y);
}

/**
 * Compare the working tree against `base`, through the commit where they diverged.
 *
 * Returns undefined when there is nothing to say — not a git repository, no common ancestor, or, the common
 * case, a base that has not moved since the branch left it. That last check is one `merge-base` call and
 * ends the whole thing, so a review of an up-to-date branch pays almost nothing for this.
 *
 * `paths` is the review's own changed files; nothing outside them is examined, because a collision in a file
 * the reader is not being shown is not something this screen can usefully say.
 */
export function detectBaseDivergence(root: string, base: string, paths: string[]): BaseDivergence | undefined {
  if (!base || !paths.length) return undefined;
  const mergeBase = git(root, ["merge-base", base, "HEAD"]);
  if (!mergeBase) return undefined;
  const touchedByBase = new Set(
    git(root, ["diff", "--name-only", `${mergeBase}..${base}`])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const candidates = paths.filter((path) => touchedByBase.has(path));
  if (!candidates.length) return { mergeBase, collisions: [] };

  const collisions: FileCollision[] = [];
  for (const path of candidates) {
    const theirs = oldRanges(git(root, ["diff", "--unified=0", `${mergeBase}..${base}`, "--", path]));
    const ours = oldRanges(git(root, ["diff", "--unified=0", mergeBase, "--", path]));
    if (!theirs.length || !ours.length) continue;
    const lines = overlappingLines(ours, theirs);
    collisions.push(lines.length ? { path, kind: "conflict", lines } : { path, kind: "diverged", lines: [] });
  }
  return { mergeBase, collisions };
}
