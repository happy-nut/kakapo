import { git } from "./git.js";

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
};

// Field/record separators that can't occur in git output — the same idiom readGitLog uses (git-log.ts).
const FS = "\x1f";
const RS = "\x1e";
const PRETTY = `--pretty=format:%H${FS}%h${FS}%s${FS}%cI${RS}`;

// The base the "All changes" row compares against. Prefer the tracking branch's merge-base (so only
// commits introduced on this branch count, correct even after divergence); fall back to the merge-base
// with a conventional default branch when there is no upstream. Unlike resolveAutomaticReviewBase this
// does not require a clean worktree — the reviewer picks patch sets while the tree is dirty.
function resolveBranchPoint(root: string): { sha: string; label: string; upstream?: string } | undefined {
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream) {
    const mergeBase = git(root, ["merge-base", upstream, "HEAD"]);
    if (mergeBase) return { sha: mergeBase, label: upstream, upstream };
  }
  for (const candidate of ["main", "master"]) {
    if (!git(root, ["rev-parse", "--verify", "--quiet", candidate])) continue;
    const mergeBase = git(root, ["merge-base", candidate, "HEAD"]);
    if (mergeBase) return { sha: mergeBase, label: candidate };
  }
  return undefined;
}

// Enumerate the branch's patch sets for the base selector. activeBase is left "" here; the IPC handler
// fills it from the live review options so the same list can highlight the current selection.
export function readPatchSets(root: string): PatchSetList {
  const head = git(root, ["rev-parse", "HEAD"]);
  const branchPoint = resolveBranchPoint(root);
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
      const trimmed = record.replace(/^\n/, "");
      if (!trimmed.trim()) continue;
      const f = trimmed.split(FS);
      if (!f[0]) continue;
      commits.push({
        sha: f[0],
        shortSha: f[1] || f[0].slice(0, 8),
        subject: f[2] || "",
        date: f[3] || "",
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
