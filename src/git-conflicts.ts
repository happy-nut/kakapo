import { git } from "./git.js";

// Does the work under review collide with work that has landed on its base?
//
// This is the one thing GitKraken charges for that kakapo did not have and that fits what kakapo is: the
// answer comes from the local object database, needs no network, no account, and never touches the working
// tree, the index or a ref.
//
// `git merge-tree` is the obvious tool and the wrong one here. It compares two COMMITS, and the changes
// kakapo exists to read are usually not committed yet — an agent has just written them — so it would be
// silent in exactly the case that matters. (Its human-readable output is localized, too: on a Korean system
// the conflict lines read "충돌 (내용)", so parsing its prose would be a bug waiting for a locale change.)
//
// What works for committed and uncommitted work alike is to ask both sides the same question against the
// point where they diverged. Line numbers only mean something inside one revision, so both sides are read in
// MERGE-BASE coordinates — the `-` ranges of each diff — and compared there. Overlapping ranges are what git
// itself would call a conflict; the same file touched in different places is not a conflict, but it is worth
// knowing about, so it is reported separately rather than folded into the same word.

export type FileCollision = {
  path: string;
  /** "conflict": both sides changed the same lines. "diverged": same file, different lines. */
  kind: "conflict" | "diverged";
  /** Lines (in merge-base coordinates) both sides changed. Empty for "diverged". */
  lines: number[];
};

export type BaseDivergence = {
  /** Where the review's base and its working tree parted company. */
  mergeBase: string;
  /** Files the base changed since then that the review also changes. */
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

// Lines present in both sets of ranges. A zero-width range (an insertion) collides with any range that
// contains the line it was inserted after, and with another insertion at the same point.
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
  // No separate "has the base moved?" question: when it has not, it IS the merge base, and the diff below
  // is empty — which lands in the same `collisions: []` by the same path, one process cheaper.
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
    // Both diffs start at the merge base, so their `-` ranges are in the same coordinate system. The second
    // has no second revision: that is the working tree, which is the whole reason merge-tree cannot do this.
    const theirs = oldRanges(git(root, ["diff", "--unified=0", `${mergeBase}..${base}`, "--", path]));
    const ours = oldRanges(git(root, ["diff", "--unified=0", mergeBase, "--", path]));
    if (!theirs.length || !ours.length) continue;
    const lines = overlappingLines(ours, theirs);
    collisions.push(lines.length ? { path, kind: "conflict", lines } : { path, kind: "diverged", lines: [] });
  }
  return { mergeBase, collisions };
}
