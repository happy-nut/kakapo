import { defaultBaseRef, git, gitAsync, isCommitSha, RECORD_FS, RECORD_RS } from "./git.js";

// One selectable patch set: a commit on the branch under review. The reviewer picks one as the diff
// base and always compares it against the latest state (working tree). "remote보다 앞선 로컬 커밋
// 하나하나가 patch set 하나" — the local model from issue #11.
export type PatchSet = {
  sha: string;
  shortSha: string;
  subject: string;
  date: string; // ISO-8601 committer date
};

export type PatchSetList = {
  // Currently active base as the review options hold it: a commit SHA, a ref name (CLI --base), or the
  // sentinel "auto" (no explicit base — the automatic merge-base/HEAD). Drives which row is highlighted.
  activeBase: string;
  // Currently active right/target side: a commit SHA, or the sentinel "worktree" (compare against the
  // working tree — today's default). Filled by the IPC handler from the live options.
  activeTarget: string;
  // The branch point the "All changes" (Auto) row diffs against: the upstream merge-base, or the
  // merge-base with a conventional default branch. Absent when neither can be resolved.
  branchPoint?: { sha: string; label: string };
  upstream?: string;
  head: string;
  // Commits in branchPoint..HEAD, oldest → newest. Empty when the branch has no commits ahead.
  commits: PatchSet[];
  // True when `commits` is a compare scope opened from Cmd+9 (a fixed A..F range) rather than the local
  // commits-ahead list. In this mode both dropdowns pick base/target from `commits`.
  scoped?: boolean;
};

// One record per line, free text last — see RECORD_RS in git.ts for why it is not 0x1e. A forged record
// here would be worse than a forged history row: the sha of the row the reviewer picks becomes the diff's
// BASE, so an invented patch set labelled with a plausible subject makes them read the wrong change set.
const FS = RECORD_FS;
const RS = RECORD_RS;
const PRETTY = `--pretty=format:%H${FS}%h${FS}%cI${FS}%s`;

// The base the "All changes" row compares against. Prefer the tracking branch's merge-base (so only
// commits introduced on this branch count, correct even after divergence); fall back to the merge-base
// with a conventional default branch when there is no upstream. Unlike resolveAutomaticReviewBase this
// does not require a clean worktree — the reviewer picks patch sets while the tree is dirty.
/**
 * The base a ref gives, or nothing when that ref cannot serve as one.
 *
 * A ref that CONTAINS HEAD has no commits ahead of it, so its merge-base IS HEAD — and the branch list
 * offers the branch you are on, which makes that one click away. Used as a base it empties the patch-set
 * bar, taking the numbered sets and the "all" exit with it, on a setting persisted per repository and
 * restored at open.
 *
 * Exported because BOTH readers of `compareRef` have to apply it. Stated in only one of them, the two
 * disagreed again in the state it rejects: the bar fell through and labelled its option `main` while
 * set-compare-mode went on resolving the picked ref to HEAD — the same label-says-one-branch,
 * click-uses-another split that threading the ref through here was meant to end.
 */
export function usableCompareBase(root: string, ref: string, head?: string): string | undefined {
  if (!ref) return undefined;
  const mergeBase = git(root, ["merge-base", ref, "HEAD"]);
  if (!mergeBase) return undefined;
  return mergeBase === (head ?? git(root, ["rev-parse", "HEAD"])) ? undefined : mergeBase;
}

function resolveBranchPoint(root: string, preferred?: string, head?: string): { sha: string; label: string; upstream?: string } | undefined {
  // The branch the compare control is SET to wins. This list is what labels the bar's "all" option and
  // what decides whether that option is the one in force, while the click resolves `compareRef` or the
  // default — so resolving the default here regardless made the button read `전체 변경 · origin/main`
  // and measure against `develop`, for as long as the picked branch stayed picked (it is persisted per
  // repository and restored at open). One ref, read by the label, the marking and the click alike.
  if (preferred) {
    const picked = usableCompareBase(root, preferred, head);
    if (picked) return { sha: picked, label: preferred };
  }
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream) {
    const mergeBase = git(root, ["merge-base", upstream, "HEAD"]);
    if (mergeBase) return { sha: mergeBase, label: upstream, upstream };
  }
  const base = defaultBaseRef(root);
  const mergeBase = base && git(root, ["merge-base", base, "HEAD"]);
  if (mergeBase) return { sha: mergeBase, label: base };
  return undefined;
}

// Enumerate the branch's patch sets for the base selector. activeBase is left "" here; the IPC handler
// fills it from the live review options so the same list can highlight the current selection.
export function readPatchSets(root: string, compareRef?: string): PatchSetList {
  const head = git(root, ["rev-parse", "HEAD"]);
  // `head` is passed rather than resolved again: this runs on every diff update (refreshPatchSets is wired
  // to onDiffUpdate), and it was spawning a second `git rev-parse HEAD` for a value one line above it.
  const branchPoint = resolveBranchPoint(root, compareRef, head);
  const commits: PatchSet[] = [];
  if (branchPoint && branchPoint.sha !== head) {
    const out = git(root, [
      "-c", "log.showSignature=false",
      "log", "--no-color", "--no-patch",
      "--date=iso-strict",
      PRETTY,
      "--reverse", // oldest → newest, the order the selector lists patch sets in
      "-n", "500", // guard against a pathologically long branch; feature branches are far smaller
      `${branchPoint.sha}..HEAD`,
      "--",
    ]);
    for (const record of out.split(RS)) {
      if (!record.trim()) continue;
      const f = record.split(FS);
      if (!isCommitSha(f[0] ?? "")) continue;
      commits.push({
        sha: f[0],
        shortSha: f[1] || f[0].slice(0, 8),
        date: f[2] || "",
        // Rejoined: a subject carrying the field separator keeps all of itself and shifts nothing.
        subject: f.slice(3).join(FS),
      });
    }
  }
  return {
    activeBase: "",
    activeTarget: "worktree",
    branchPoint: branchPoint ? { sha: branchPoint.sha, label: branchPoint.label } : undefined,
    upstream: branchPoint?.upstream,
    head,
    commits,
  };
}

/**
 * Where the reviewer stopped reading, when the branch still runs from there to HEAD.
 *
 * The mark is HEAD at the moment a review was handed to an agent (app-main's kakapo:mark-read). Coming
 * back to that worktree, "what did it do since I handed off" is the question, and answering it needs no
 * branch and no commit picking — the reviewer already told us where they stopped by stopping.
 *
 * Offered only when three things hold: the mark names a commit this repository still has, that commit is
 * an ANCESTOR of HEAD, and HEAD has moved past it. Agents rebase, amend and reset, so a mark is routinely
 * left pointing at a commit that is still in the object database and no longer on the branch — diffing
 * against one of those answers "what differs from a commit that is not in your history", which is not the
 * question the row's label makes. Nothing is offered rather than offering that.
 */
export type ReadMark = { sha: string; shortSha: string; commits: number };

export function resolveReadMark(root: string, mark: string | undefined, head?: string): ReadMark | undefined {
  if (!mark || !isCommitSha(mark)) return undefined;
  const tip = head ?? git(root, ["rev-parse", "HEAD"]);
  if (!tip || tip === mark) return undefined;
  // One command answers both of the remaining questions. merge-base is "" for an object this repository
  // does not have, and anything other than the mark itself once the branch has been rewritten out from
  // under it; only a commit that is still an ancestor of HEAD answers with its own sha.
  if (git(root, ["merge-base", mark, "HEAD"]) !== mark) return undefined;
  const commits = Number(git(root, ["rev-list", "--count", `${mark}..HEAD`]));
  // Abbreviated by slicing rather than by `git rev-parse --short`: this runs on every diff update once the
  // compare menu has been opened, and a third process for a label is not worth the main-thread stall.
  return { sha: mark, shortSha: mark.slice(0, 7), commits: Number.isFinite(commits) ? commits : 0 };
}

/**
 * What one patch set actually did: how many files, how many lines, and which paths.
 *
 * Deliberately NOT part of readPatchSets. That runs on every diff update (refreshPatchSets is wired to
 * onDiffUpdate), and a `--numstat` walk of the branch is a per-commit diff — several times the cost of the
 * metadata log beside it. The ledger is opened on purpose and read for a while, so it pays for its own
 * numbers and nobody who never opens it pays anything.
 */
export type PatchSetStat = { files: number; added: number; removed: number; paths: string[] };

/**
 * Parse `git log --numstat --format=%H`. Exported for the test: the shapes that break this parser are a
 * binary file (`-` for both counts), a merge commit (a sha with no numstat lines at all) and a rename
 * (`src/{a => b}.ts` as the path), and none of them is convenient to produce from a fixture by accident.
 *
 * A bare 40-hex line starts a commit, and nothing else can look like one: every numstat line carries two
 * tabs before its path, so a file literally named like a sha is still three fields.
 */
export function parsePatchSetStats(out: string): Record<string, PatchSetStat> {
  const stats: Record<string, PatchSetStat> = {};
  let current: PatchSetStat | undefined;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (/^[0-9a-f]{40}$/.test(line)) {
      current = { files: 0, added: 0, removed: 0, paths: [] };
      stats[line] = current;
      continue;
    }
    if (!current) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    current.files += 1;
    // A binary file reports "-" for both counts. It changed — it just has no lines to count, and adding
    // NaN to the total would turn the whole patch set's figure into "NaN" on screen.
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) current.added += added;
    if (Number.isFinite(removed)) current.removed += removed;
    // Rejoined: a path holding a tab keeps all of itself rather than being truncated at the first one.
    current.paths.push(parts.slice(2).join("\t"));
  }
  return stats;
}

export async function readPatchSetStats(root: string, from: string, to: string): Promise<Record<string, PatchSetStat>> {
  if (!from || !to) return {};
  // Async: this is a per-commit diff walk, and on the Electron main process a spawnSync of that size is
  // frozen UI for as long as it takes.
  const out = await gitAsync(root, [
    "-c", "log.showSignature=false",
    "log", "--no-color", "--numstat", "--format=%H",
    "-n", "500", // the same guard readPatchSets uses; a branch longer than this is not being read by hand
    `${from}..${to}`,
    "--",
  ]);
  return parsePatchSetStats(out);
}
