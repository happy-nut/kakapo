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

export type GitBlameLine = {
  line: number;
  hash: string;
  author: string;
  date: string; // YYYY-MM-DD
  summary: string;
};

// Field/record separators that can't occur in git output, so subjects with spaces/commas parse cleanly.
const FS = "\x1f";
const RS = "\x1e";
const PRETTY = `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%ad${FS}%D${FS}%s${RS}`;

function trackedWorkspacePath(root: string, requestedPath: string): string {
  const path = String(requestedPath || "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.includes(":") || path.includes("\0") || path.includes("\n")) return "";
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return "";
  return git(root, ["ls-files", "--error-unmatch", "--", path]) ? path : "";
}

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
  const path = trackedWorkspacePath(root, request.path);
  const line = Math.trunc(Number(request.line));
  const limit = request.limit && request.limit > 0 ? Math.min(Math.trunc(request.limit), 500) : 300;
  if (!path) return [];
  if (!Number.isInteger(line) || line < 1) return [];
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

// One stable commit attribution per working-tree line. Porcelain mode is locale-independent and keeps
// author names with spaces intact. Root commits are normal hashes (`--root`) rather than boundary hashes,
// so every committed annotation can open the existing commit-diff renderer directly.
export function readGitBlame(root: string, requestedPath: string, revision?: string): GitBlameLine[] {
  const path = trackedWorkspacePath(root, requestedPath);
  if (!path) return [];
  const requestedRevision = String(revision || "");
  // The revision comes from the review snapshot owned by main, never arbitrary renderer input. Resolve a
  // normal branch/tag/base name to an immutable commit before placing it in blame's option-bearing argv.
  if (requestedRevision && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(requestedRevision)) return [];
  const target = requestedRevision
    ? git(root, ["rev-parse", "--verify", `${requestedRevision}^{commit}`])
    : "";
  if (requestedRevision && !/^[0-9a-fA-F]{40,64}$/.test(target)) return [];
  const args = ["blame", "--line-porcelain", "--root"];
  if (target) args.push(target);
  args.push("--", path);
  const out = git(root, args);
  if (!out) return [];
  const rows = out.split("\n");
  const result: GitBlameLine[] = [];
  for (let index = 0; index < rows.length;) {
    const header = rows[index]?.match(/^([0-9a-fA-F]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/);
    if (!header) { index += 1; continue; }
    const hash = header[1];
    const line = Number(header[2]);
    const metadata: Record<string, string> = {};
    index += 1;
    while (index < rows.length && !rows[index].startsWith("\t")) {
      const separator = rows[index].indexOf(" ");
      if (separator > 0) metadata[rows[index].slice(0, separator)] = rows[index].slice(separator + 1);
      index += 1;
    }
    if (index < rows.length && rows[index].startsWith("\t")) index += 1;
    const seconds = Number(metadata["author-time"]);
    const zone = String(metadata["author-tz"] || "").match(/^([+-])(\d{2})(\d{2})$/);
    const zoneMinutes = zone
      ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]))
      : 0;
    const date = Number.isFinite(seconds) && seconds > 0
      ? new Date((seconds + zoneMinutes * 60) * 1000).toISOString().slice(0, 10)
      : "";
    if (Number.isInteger(line) && line > 0) {
      result.push({
        line,
        hash,
        author: metadata.author || "",
        date,
        summary: metadata.summary || "",
      });
    }
  }
  return result;
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
