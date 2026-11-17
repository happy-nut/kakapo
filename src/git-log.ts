import { git, isCommitSha, RECORD_FS, RECORD_RS } from "./git.js";

export type GitCommit = {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  refs: string;
  subject: string;
  extra?: string[];
};

export type GitReflogEntry = GitCommit & { selector: string; action: string };

export type GitStashEntry = {
  selector: string;
  hash: string;
  /** Its first parent is where HEAD was when the stash was made — the base its diff is read against. */
  parents: string[];
  author: string;
  date: string;
  subject: string;
};

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
  date: string;
  summary: string;
};

const FS = RECORD_FS;
const RS = RECORD_RS;
const PRETTY = `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%ad${FS}%D${FS}%s`;
// The same record with the reflog's own two fields appended (%gd selector, %gs action).
//
// %aI, not %ad with --date=iso-strict: a date format applies to the reflog SELECTOR too, which turns
// `stash@{0}` into `stash@{2026-10-25T21:45:42+09:00}` — unusable as the name it is supposed to be.
const PRETTY_REFLOG = `--pretty=format:%H${FS}%P${FS}%an${FS}%ae${FS}%aI${FS}%D${FS}%gd${FS}%gs${FS}%s`;

/**
 * What the log view may ask for. Every field is renderer input, so each one is validated below before it
 * reaches argv — and each is attached to its flag (`--author=x`, never `--author x`), so a value that
 * starts with a dash is a value and not another option.
 */
export type GitLogFilter = {
  limit?: number;
  skip?: number;
  author?: string;
  path?: string;
  text?: string;
  /** Commits that changed the number of occurrences of this string (git's pickaxe, `-S`). */
  content?: string;
  since?: string;
  until?: string;
  branch?: string;
  currentBranchOnly?: boolean;
  /** With `path`: follow the file through renames (git refuses --follow with more than one path). */
  follow?: boolean;
};

function safeRefName(value: string | undefined): string {
  const ref = String(value || "");
  return /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(ref) && !ref.includes("..") ? ref : "";
}

function safeLogPath(value: string | undefined): string {
  const path = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\n")) return "";
  return path.split("/").some((part) => part === ".." || part === "") ? "" : path;
}

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

function parseGitCommits(out: string, extraFields = 0): GitCommit[] {
  if (!out) return [];
  return out
    .split(RS)
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
        extra: extraFields ? f.slice(6, 6 + extraFields) : undefined,
        subject: f.slice(6 + extraFields).join(FS),
      };
    })
    .filter((c) => isCommitSha(c.hash));
}

export function readGitLog(root: string, options: GitLogFilter = {}): GitCommit[] {
  const limit = options.limit && options.limit > 0 ? Math.min(Math.trunc(options.limit), 2000) : 200;
  const path = safeLogPath(options.path);
  const follow = Boolean(options.follow) && Boolean(path);
  const branch = safeRefName(options.branch);
  const args = [
    "-c", "log.showSignature=false",
    "log", "--no-color",
  ];
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

export function readGitReflog(root: string, options: { limit?: number } = {}): GitReflogEntry[] {
  const limit = options.limit && options.limit > 0 ? Math.min(Math.trunc(options.limit), 1000) : 200;
  const out = git(root, [
    "-c", "log.showSignature=false",
    "log", "-g", "--no-color", "--decorate=full", PRETTY_REFLOG, "-n", String(limit),
  ]);
  return parseGitCommits(out, 2).map((commit, index) => ({
    ...commit,
    selector: commit.extra?.[0] ?? `HEAD@{${index}}`,
    action: commit.extra?.[1] ?? "",
  })).map(({ extra: _extra, ...entry }) => entry as GitReflogEntry);
}

export function readGitStashes(root: string): GitStashEntry[] {
  const out = git(root, [
    "stash", "list", "--no-color",
    `--pretty=format:%gd${FS}%H${FS}%P${FS}%an${FS}%aI${FS}%gs`,
  ]);
  if (!out) return [];
  return out
    .split(RS)
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
    .filter((entry) => isCommitSha(entry.hash));
}

export function resolveGitRevision(root: string, query: string): GitRevision | null {
  const ref = safeRefName(query);
  if (!ref) return null;
  const hash = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!/^[0-9a-fA-F]{40,64}$/.test(hash)) return null;
  const meta = git(root, [
    "show", "-s", "--decorate=full", `--pretty=format:%h${FS}%an${FS}%ad${FS}%D${FS}%s`, "--date=iso-strict", hash,
  ]);
  const fields = meta.split(FS);
  return {
    hash,
    short: fields[0] || hash.slice(0, 7),
    author: fields[1] || "",
    date: fields[2] || "",
    refs: fields[3] || "",
    subject: fields.slice(4).join(FS),
  };
}

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
// so every committed annotation names a commit the history view can open.
export function readGitBlame(root: string, requestedPath: string, revision?: string): GitBlameLine[] {
  const path = trackedWorkspacePath(root, requestedPath);
  if (!path) return [];
  const requestedRevision = String(revision || "");
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
