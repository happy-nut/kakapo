import { defaultBaseRef, git, gitAsync, isCommitSha, RECORD_FS, RECORD_RS } from "./git.js";

export type PatchSet = {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
};

export type PatchSetList = {
  activeBase: string;
  activeTarget: string;
  branchPoint?: { sha: string; label: string };
  upstream?: string;
  head: string;
  commits: PatchSet[];
  scoped?: boolean;
};

const FS = RECORD_FS;
const RS = RECORD_RS;
const PRETTY = `--pretty=format:%H${FS}%h${FS}%cI${FS}%s`;

export function usableCompareBase(root: string, ref: string, head?: string): string | undefined {
  if (!ref) return undefined;
  const mergeBase = git(root, ["merge-base", ref, "HEAD"]);
  if (!mergeBase) return undefined;
  return mergeBase === (head ?? git(root, ["rev-parse", "HEAD"])) ? undefined : mergeBase;
}

function resolveBranchPoint(root: string, preferred?: string, head?: string): { sha: string; label: string; upstream?: string } | undefined {
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

export function readPatchSets(root: string, compareRef?: string): PatchSetList {
  const head = git(root, ["rev-parse", "HEAD"]);
  const branchPoint = resolveBranchPoint(root, compareRef, head);
  const commits: PatchSet[] = [];
  if (branchPoint && branchPoint.sha !== head) {
    const out = git(root, [
      "-c", "log.showSignature=false",
      "log", "--no-color", "--no-patch",
      "--date=iso-strict",
      PRETTY,
      "--reverse",
      "-n", "500",
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

export type ReadMark = { sha: string; shortSha: string; commits: number };

export function resolveReadMark(root: string, mark: string | undefined, head?: string): ReadMark | undefined {
  if (!mark || !isCommitSha(mark)) return undefined;
  const tip = head ?? git(root, ["rev-parse", "HEAD"]);
  if (!tip || tip === mark) return undefined;
  if (git(root, ["merge-base", mark, "HEAD"]) !== mark) return undefined;
  const commits = Number(git(root, ["rev-list", "--count", `${mark}..HEAD`]));
  return { sha: mark, shortSha: mark.slice(0, 7), commits: Number.isFinite(commits) ? commits : 0 };
}

export type PatchSetStat = { files: number; added: number; removed: number; paths: string[] };

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
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) current.added += added;
    if (Number.isFinite(removed)) current.removed += removed;
    current.paths.push(parts.slice(2).join("\t"));
  }
  return stats;
}

export async function readPatchSetStats(root: string, from: string, to: string): Promise<Record<string, PatchSetStat>> {
  if (!from || !to) return {};
  const out = await gitAsync(root, [
    "-c", "log.showSignature=false",
    "log", "--no-color", "--numstat", "--format=%H",
    "-n", "500",
    `${from}..${to}`,
    "--",
  ]);
  return parsePatchSetStats(out);
}
