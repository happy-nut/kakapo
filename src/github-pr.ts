import { spawnSync } from "node:child_process";
import { git } from "./git.js";

export type PullRequestRef = { owner: string; repo: string; number: number };

/** Whose repository this checkout points at, read off the `origin` remote. */
export function remoteSlug(root: string): { owner: string; repo: string } | undefined {
  const url = git(root, ["remote", "get-url", "origin"]).trim();
  if (!url) return undefined;
  // Both spellings git hands out: `git@host:owner/repo.git` and `https://host/owner/repo.git`, plus the
  // ssh:// form. Only the last two path segments matter, and `.git` is optional.
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

/**
 * Read a pull request out of whatever the reader pasted.
 *
 * A link from the address bar is the common case and may carry a tab or an anchor (`/files`,
 * `#discussion_r…`), so the number is taken from the `pull/<n>` segment rather than from the end. The
 * shorter spellings people actually type are accepted too: `owner/repo#12`, and a bare `#12` or `12`,
 * which mean "this repository" and need the remote to say which that is.
 */
export function parsePullRequestRef(input: string, fallback?: { owner: string; repo: string }): PullRequestRef | undefined {
  const text = String(input || "").trim();
  if (!text) return undefined;
  const link = text.match(/(?:^|\/\/)(?:[^/]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/)
    || text.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (link) {
    const number = Number(link[3]);
    return number > 0 ? { owner: link[1], repo: link[2].replace(/\.git$/, ""), number } : undefined;
  }
  const bare = text.match(/^#?(\d+)$/);
  if (bare && fallback) {
    const number = Number(bare[1]);
    return number > 0 ? { owner: fallback.owner, repo: fallback.repo, number } : undefined;
  }
  return undefined;
}

export type PullRequestDetails = { base: string; head: string; title: string };
export type PullRequestLookup =
  | { ok: true; details: PullRequestDetails }
  | { ok: false; error: "gh-missing" | "gh-failed"; detail?: string };

export function lookupPullRequest(root: string, ref: PullRequestRef, run = spawnSync): PullRequestLookup {
  const result = run("gh", [
    "pr", "view", String(ref.number),
    "--repo", `${ref.owner}/${ref.repo}`,
    "--json", "baseRefName,headRefName,title",
  ], { cwd: root, encoding: "utf8" as const });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: "gh-missing" };
  if (result.status !== 0) {
    return { ok: false, error: "gh-failed", detail: String(result.stderr || "").trim().split("\n")[0] || "" };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || "")) as Record<string, unknown>;
    const base = typeof parsed.baseRefName === "string" ? parsed.baseRefName : "";
    const head = typeof parsed.headRefName === "string" ? parsed.headRefName : "";
    if (!base || !head) return { ok: false, error: "gh-failed", detail: "no branch names in the answer" };
    return { ok: true, details: { base, head, title: typeof parsed.title === "string" ? parsed.title : "" } };
  } catch {
    return { ok: false, error: "gh-failed", detail: "unreadable answer" };
  }
}

export function localRevisionFor(root: string, branch: string, prefer: "remote" | "local"): string | undefined {
  const candidates = prefer === "remote"
    ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]
    : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  for (const candidate of candidates) {
    if (git(root, ["rev-parse", "--verify", "--quiet", candidate])) {
      return candidate.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
    }
  }
  return undefined;
}
