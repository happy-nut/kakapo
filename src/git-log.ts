import { git, isCommitSha } from "./git.js";
// diff2html + highlight.js are ~100ms of parse and are reached ONLY by the two commit-diff readers below,
// which fire when the reader opens history (⌘9) — never on the way to first paint. Loading them on the first
// such call is what keeps them out of the main process's cold start; Node caches the module after that.
const renderDiff2Html = async (diffText: string): Promise<string> => (await import("./highlight.js")).renderDiff2Html(diffText);
import { parseUnifiedDiff } from "./diff.js";

// Per-file status map (displayPath -> "added"/"modified"/…) parsed from a unified diff, for the history
// view's changed-files list. Shared by the single-commit and range readers, which both build it identically.
function fileStatusFromDiff(diffText: string): Record<string, string> {
  const fileStatus: Record<string, string> = {};
  for (const file of parseUnifiedDiff(diffText)) fileStatus[file.displayPath] = file.status;
  return fileStatus;
}

// One commit row for the history view. parents drives the graph lanes (computed in the renderer).
export type GitCommit = {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string; // ISO-8601
  refs: string; // %D — "HEAD -> main, origin/main, tag: v1" (may be empty)
  subject: string;
  // Fields a caller's own pretty format appended after the subject (the reflog's %gD/%gs). Absent for a
  // plain log, and stripped before the entry leaves readGitReflog.
  extra?: string[];
};

/** One `git log -g` entry: a commit plus the reflog selector and action that recorded it. */
export type GitReflogEntry = GitCommit & { selector: string; action: string };

/** One `git stash list` entry. `hash` is the stash commit, which is what the diff reader is given. */
export type GitStashEntry = {
  selector: string;
  hash: string;
  /** Its first parent is where HEAD was when the stash was made — the base its diff is read against. */
  parents: string[];
  author: string;
  date: string;
  subject: string;
};

/** What a hash, branch, tag or `HEAD~2` typed into the log's search box resolves to. */
export type GitRevision = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
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
// The same record with the reflog's own two fields appended (%gd selector, %gs action).
//
// %aI, not %ad with --date=iso-strict: a date format applies to the reflog SELECTOR too, which turns
// `stash@{0}` into `stash@{2026-10-25T21:45:42+09:00}` — unusable as the name it is supposed to be.
const PRETTY_REFLOG = `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%aI${FS}%D${FS}%s${FS}%gd${FS}%gs${RS}`;

/**
 * What the log view may ask for. Every field is renderer input, so each one is validated below before it
 * reaches argv — and each is attached to its flag (`--author=x`, never `--author x`), so a value that
 * starts with a dash is a value and not another option.
 */
export type GitLogFilter = {
  limit?: number;
  skip?: number;
  /** Substring of the author name or email. */
  author?: string;
  /** A repository-relative file or folder; the log is narrowed to what touched it. */
  path?: string;
  /** Substring of the commit message. */
  text?: string;
  /** Commits that changed the number of occurrences of this string (git's pickaxe, `-S`). */
  content?: string;
  /** YYYY-MM-DD. */
  since?: string;
  until?: string;
  /** Walk one ref instead of every branch. */
  branch?: string;
  /** Walk HEAD only — IntelliJ's "current branch" against its "all branches". */
  currentBranchOnly?: boolean;
  /** With `path`: follow the file through renames (git refuses --follow with more than one path). */
  follow?: boolean;
};

/** A ref name safe to place in argv: no option-looking leading dash, no separators, no whitespace. */
function safeRefName(value: string | undefined): string {
  const ref = String(value || "");
  return /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(ref) && !ref.includes("..") ? ref : "";
}

/** A repository-relative path safe to place after `--`. Unlike blame's, a folder is allowed. */
function safeLogPath(value: string | undefined): string {
  const path = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\n")) return "";
  return path.split("/").some((part) => part === ".." || part === "") ? "" : path;
}

/** A filter value that is matched, not interpreted: control characters out, length bounded. */
function safeFilterText(value: string | undefined): string {
  const text = String(value || "").replace(/[\0\n\r]/g, "").trim();
  return text.slice(0, 200);
}

function safeDate(value: string | undefined): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

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
        extra: f.length > 7 ? f.slice(7).map((field) => field.replace(/\n$/, "")) : undefined,
      };
    })
    .filter((c) => c.hash);
}

/**
 * Read up to `limit` commits (optionally skipping `skip`). Newest first — the order the graph walker expects.
 *
 * The filters are applied by GIT, not by hiding rows in the list. That is the whole point: a page holds a
 * few hundred commits, so a filter that only hides what is already loaded answers "no commits by Ada" when
 * what it means is "none in the last two hundred".
 */
export function readGitLog(root: string, options: GitLogFilter = {}): GitCommit[] {
  const limit = options.limit && options.limit > 0 ? Math.min(Math.trunc(options.limit), 2000) : 200;
  const path = safeLogPath(options.path);
  const follow = Boolean(options.follow) && Boolean(path);
  const branch = safeRefName(options.branch);
  const args = [
    "-c", "log.showSignature=false",
    "log", "--no-color",
  ];
  // History is a repository graph, not just the first-parent walk from the checked-out branch.
  // Topological order guarantees that every child is emitted before its parents, which is the
  // contract used by the renderer's lane allocator. Full decoration lets the UI distinguish local
  // branches from remotes even when either name contains slashes, independent of global Git settings.
  //
  // --follow is the exception: git refuses it alongside --all, and a file's history is a line of
  // renames rather than a graph, so that mode walks one ref.
  if (branch) args.push(branch);
  else if (follow || options.currentBranchOnly) args.push("HEAD");
  // Branches, tags and remotes — NOT --all, which also means refs/stash (and refs/notes), so every
  // stash appeared in the commit log as "On main: work in progress". The stash list is its own view.
  else args.push("--branches", "--tags", "--remotes", "HEAD");
  if (follow) args.push("--follow");
  else args.push("--topo-order", "--full-history");
  args.push("--decorate=full", "--date=iso-strict", PRETTY, "-n", String(limit));
  if (options.skip && options.skip > 0) args.push(`--skip=${Math.trunc(options.skip)}`);
  const author = safeFilterText(options.author);
  if (author) args.push(`--author=${author}`);
  const text = safeFilterText(options.text);
  // Fixed-strings and case-insensitive: a reviewer types words, not a regex, and an unbalanced bracket
  // should narrow nothing rather than make git exit non-zero.
  if (text) args.push("--fixed-strings", "--regexp-ignore-case", `--grep=${text}`);
  const content = safeFilterText(options.content);
  if (content) args.push(`-S${content}`);
  const since = safeDate(options.since);
  if (since) args.push(`--since=${since}`);
  const until = safeDate(options.until);
  if (until) args.push(`--until=${until}`);
  args.push("--", path || ".");
  return parseGitCommits(git(root, args));
}

/**
 * `git log -g`: where HEAD has actually been. The one view that still holds a commit after a reset or a
 * rebase dropped it — which is exactly when a reviewer needs to find it again.
 */
export function readGitReflog(root: string, options: { limit?: number } = {}): GitReflogEntry[] {
  const limit = options.limit && options.limit > 0 ? Math.min(Math.trunc(options.limit), 1000) : 200;
  const out = git(root, [
    "-c", "log.showSignature=false",
    "log", "-g", "--no-color", "--decorate=full", PRETTY_REFLOG, "-n", String(limit),
  ]);
  return parseGitCommits(out).map((commit, index) => ({
    ...commit,
    selector: commit.extra?.[0] ?? `HEAD@{${index}}`,
    action: commit.extra?.[1] ?? "",
  })).map(({ extra: _extra, ...entry }) => entry as GitReflogEntry);
}

/** `git stash list`. Read-only: kakapo shows what is stashed, it does not apply or drop it. */
export function readGitStashes(root: string): GitStashEntry[] {
  const out = git(root, [
    "stash", "list", "--no-color",
    `--pretty=format:%gd${FS}%H${FS}%P${FS}%an${FS}%aI${FS}%gs${RS}`,
  ]);
  if (!out) return [];
  return out
    .split(RS)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const fields = record.split(FS);
      return {
        selector: fields[0] || "",
        hash: fields[1] || "",
        parents: (fields[2] || "").trim() ? (fields[2] as string).trim().split(/\s+/) : [],
        author: fields[3] || "",
        date: fields[4] || "",
        subject: fields[5] || "",
      };
    })
    .filter((entry) => entry.hash);
}

/**
 * Resolves what someone typed into the log's search box — a full or abbreviated hash, a branch, a tag,
 * `HEAD~3` — to the commit it names, so "go to hash" can jump to it. Returns null when it names nothing,
 * which is how the box tells a revision from an ordinary text filter.
 */
export function resolveGitRevision(root: string, query: string): GitRevision | null {
  const ref = safeRefName(query);
  if (!ref) return null;
  const hash = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!/^[0-9a-fA-F]{40,64}$/.test(hash)) return null;
  const meta = git(root, [
    "show", "-s", "--decorate=full", `--pretty=format:%h${FS}%s${FS}%an${FS}%ad${FS}%D`, "--date=iso-strict", hash,
  ]);
  const fields = meta.split(FS);
  return {
    hash,
    short: fields[0] || hash.slice(0, 7),
    subject: fields[1] || "",
    author: fields[2] || "",
    date: fields[3] || "",
    refs: fields[4] || "",
  };
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
export async function readCommitDiff(root: string, sha: string): Promise<{
  hash: string;
  author: string;
  email: string;
  date: string;
  refs: string;
  message: string;
  diffHtml: string;
  // Real per-file status (added/deleted/renamed/modified), keyed by the path diff2html displays — lets
  // the renderer's changed-files tree show accurate status badges instead of assuming every file was
  // merely modified. A renamed file's diff2html label ("old -> new") won't match this key, so it falls
  // back to "modified" client-side; that is a known, acceptable gap rather than a lookup crash.
  fileStatus: Record<string, string>;
  isMerge: boolean;
} | null> {
  if (!sha || !isCommitSha(sha)) return null; // guard: only a hash reaches `git`
  const meta = git(root, ["show", "-s", "--decorate=full", `--pretty=format:%H${FS}%an${FS}%ae${FS}%ad${FS}%D${FS}%P${FS}%B`, "--date=iso-strict", sha]);
  if (!meta) return null;
  const f = meta.split(FS);
  const parents = (f[5] || "").trim() ? (f[5] as string).trim().split(/\s+/) : [];
  const diffText = git(root, ["show", "--no-textconv", "--relative", "--no-color", "--pretty=format:", sha, "--", "."]).replace(/^\n+/, "");
  const fileStatus = fileStatusFromDiff(diffText);
  return {
    hash: f[0] || sha,
    author: f[1] || "",
    email: f[2] || "",
    date: f[3] || "",
    refs: f[4] || "",
    message: (f[6] || "").trim(),
    diffHtml: await renderDiff2Html(diffText),
    fileStatus,
    isMerge: parents.length > 1,
  };
}

// Combined diff between two commits picked in the history view (shift-select). Endpoints semantics:
// `git diff <old> <new>` shows the state at old vs the state at new — i.e. everything that changed after
// the older patch set, up to the newer one. This answers "what changed between patch set A and B" when the
// work is already committed/merged and there is no working tree to compare against. Both args are commit
// SHAs owned by the history snapshot; validate them before they reach git. Returns the same shape as
// readCommitDiff (plus range fields) so the renderer can reuse the history diff workspace.
export async function readRangeDiff(root: string, oldSha: string, newSha: string): Promise<{
  range: true;
  oldHash: string;
  newHash: string;
  oldShort: string;
  newShort: string;
  oldSubject: string;
  newSubject: string;
  count: number;
  diffHtml: string;
  fileStatus: Record<string, string>;
  isMerge: false;
} | null> {
  if (!isCommitSha(oldSha) || !isCommitSha(newSha)) return null;
  const oldMeta = git(root, ["show", "-s", `--pretty=format:%h${FS}%s`, oldSha]);
  const newMeta = git(root, ["show", "-s", `--pretty=format:%h${FS}%s`, newSha]);
  if (!oldMeta || !newMeta) return null;
  const oldFields = oldMeta.split(FS);
  const newFields = newMeta.split(FS);
  // Commits introduced between the two endpoints (for the "N commits" header). Empty/0 for unrelated refs.
  const count = Number(git(root, ["rev-list", "--count", `${oldSha}..${newSha}`])) || 0;
  const diffText = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--relative", "--no-color", "--find-renames", oldSha, newSha, "--", "."]).replace(/^\n+/, "");
  const fileStatus = fileStatusFromDiff(diffText);
  return {
    range: true,
    oldHash: oldSha,
    newHash: newSha,
    oldShort: oldFields[0] || oldSha.slice(0, 7),
    newShort: newFields[0] || newSha.slice(0, 7),
    oldSubject: oldFields[1] || "",
    newSubject: newFields[1] || "",
    count,
    diffHtml: await renderDiff2Html(diffText),
    fileStatus,
    isMerge: false,
  };
}
