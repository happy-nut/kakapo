import { git } from "./git.js";
import { renderDiff2Html } from "./highlight.js";

// One commit row for the history view. parents drives the graph lanes (computed in the renderer).
export type GitCommit = {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string; // ISO-8601
  refs: string; // %D — "HEAD -> main, origin/main, tag: v1" (may be empty)
  subject: string;
};

// Field/record separators that can't occur in git output, so subjects with spaces/commas parse cleanly.
const FS = "\x1f";
const RS = "\x1e";
const PRETTY = `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%ad${FS}%D${FS}%s${RS}`;

function parseGitCommits(out: string): GitCommit[] {
  if (!out) return [];
  return out
    .split(RS)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const f = rec.split(FS);
      return {
        hash: f[0] || "",
        parents: (f[1] || "").trim() ? (f[1] as string).trim().split(/\s+/) : [],
        author: f[2] || "",
        email: f[3] || "",
        date: f[4] || "",
        refs: f[5] || "",
        subject: f[6] || "",
      };
    })
    .filter((c) => c.hash);
}

// Read up to `limit` commits (optionally skipping `skip`). Newest first — the order the graph walker expects.
export function readGitLog(root: string, options: { limit?: number; skip?: number } = {}): GitCommit[] {
  const limit = options.limit && options.limit > 0 ? options.limit : 200;
  const args = [
    "-c", "log.showSignature=false",
    "log", "--no-color",
    // History is a repository graph, not just the first-parent walk from the checked-out branch.
    // Topological order guarantees that every child is emitted before its parents, which is the
    // contract used by the renderer's lane allocator. Full decoration lets the UI distinguish local
    // branches from remotes even when either name contains slashes, independent of global Git settings.
    "--all", "--topo-order", "--full-history", "--decorate=full",
    "--date=iso-strict",
    PRETTY,
    `-n`, String(limit),
  ];
  if (options.skip && options.skip > 0) args.push(`--skip=${options.skip}`);
  args.push("--", ".");
  return parseGitCommits(git(root, args));
}

// Commits that actually changed one source line, newest first. `git log -L` follows the line through
// edits instead of merely listing every commit that touched the file, which is the useful question when
// a reviewer right-clicks a line number. The path is renderer input, so accept only a workspace-relative
// Git path and require it to be tracked before placing it in the -L expression.
export function readGitLineLog(
  root: string,
  request: { path: string; line: number; limit?: number },
): GitCommit[] {
  const path = String(request.path || "").replace(/\\/g, "/");
  const line = Math.trunc(Number(request.line));
  const limit = request.limit && request.limit > 0 ? Math.min(Math.trunc(request.limit), 500) : 300;
  if (!path || path.startsWith("/") || path.includes(":") || path.includes("\0") || path.includes("\n")) return [];
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return [];
  if (!Number.isInteger(line) || line < 1) return [];
  if (!git(root, ["ls-files", "--error-unmatch", "--", path])) return [];
  const out = git(root, [
    "-c", "log.showSignature=false",
    "log", "--no-color", "--no-patch",
    "--decorate=full",
    "--date=iso-strict",
    PRETTY,
    "-n", String(limit),
    "-L", `${line},${line}:${path}`,
    "--",
  ]);
  return parseGitCommits(out);
}

// Full detail for one commit: metadata, full message body, and the rendered diff (diff2html HTML).
// Merge commits show no diff under plain `git show`; the renderer notes that case.
export function readCommitDiff(root: string, sha: string): {
  hash: string;
  author: string;
  email: string;
  date: string;
  refs: string;
  message: string;
  diffHtml: string;
  isMerge: boolean;
} | null {
  if (!sha || !/^[0-9a-fA-F]{4,64}$/.test(sha)) return null; // guard: only a hash reaches `git`
  const meta = git(root, ["show", "-s", "--decorate=full", `--pretty=format:%H${FS}%an${FS}%ae${FS}%ad${FS}%D${FS}%P${FS}%B`, "--date=iso-strict", sha]);
  if (!meta) return null;
  const f = meta.split(FS);
  const parents = (f[5] || "").trim() ? (f[5] as string).trim().split(/\s+/) : [];
  const diffText = git(root, ["show", "--relative", "--no-color", "--pretty=format:", sha, "--", "."]).replace(/^\n+/, "");
  return {
    hash: f[0] || sha,
    author: f[1] || "",
    email: f[2] || "",
    date: f[3] || "",
    refs: f[4] || "",
    message: (f[6] || "").trim(),
    diffHtml: renderDiff2Html(diffText),
    isMerge: parents.length > 1,
  };
}
