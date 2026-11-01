import { defaultBaseRef, git, isCommitSha, RECORD_FS, RECORD_RS } from "./git.js";

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
