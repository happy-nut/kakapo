import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { basename, join, relative } from "node:path";
import type { DiffFile, DiffHunk, DiffLine, ReviewFileState, SourceFile } from "./types.js";
import {
  IMAGE_MAX_BYTES,
  SOURCE_MAX_FILE_BYTES,
  SOURCE_MAX_FILES,
  SOURCE_MAX_LAZY_FILE_BYTES,
  SOURCE_MAX_TOTAL_BYTES,
} from "./constants.js";
import { ByteBudgetCache, formatBytes, hashText, isLikelyBinary, languageForPath, stripDiffPath } from "./util.js";
import { canonicalWorkspaceRoot, git, repoRoot } from "./git.js";

// File content + signature cache, keyed by path and validated on (mtime, size). Under `watch` the app
// rebuilds every second; without this, collectSourceFiles re-reads + re-hashes EVERY tracked source
// file each tick (~1.3s for ~6k files on a large repo), pinning the Electron main process and starving
// IPC. With it an unchanged file costs a single statSync — the per-tick cost collapses to stat-only.
// Bounded, because the key is an absolute path and the value is the whole file: without a cap it retained the
// text of every file the process ever indexed, across every workspace, for as long as the app ran — heap that
// only ever grew as the reviewer moved between worktrees. Insertion order makes the Map its own LRU queue: a
// hit re-inserts, and an overflowing insert drops from the front.
// ponytail: one global byte budget, evicting oldest-first. Enough to hold the workspace you are actually in
// (the watch path is what this cache exists for); per-root budgets only if alternating two huge repos ever
// shows up as re-read cost.
type SourceContentEntry = { mtimeMs: number; size: number; content: string; signature: string };
// ponytail: one global budget, evicting oldest-first. Enough to hold the workspace you are actually in, which
// is what the watch path needs; per-root budgets only if alternating two huge repos shows up as re-read cost.
const sourceContentCache = new ByteBudgetCache<SourceContentEntry>(64_000_000, (entry) => entry.content.length);

// Diagnostics for the cache above, so the budget is observable rather than a claim in a comment.
export function sourceContentCacheStats(): { entries: number; bytes: number; limit: number } {
  return sourceContentCache.stats();
}

export function readUnifiedDiff(options: {
  base?: string;
  // Right/new side. When set, the review compares two revisions A..B (base vs target) instead of
  // base-vs-working-tree — used to review already-committed/merged patch sets. base is required here.
  target?: string;
  staged: boolean;
  context: number;
  includeUntracked: boolean;
  ignoreWhitespace?: boolean;
  root?: string;
}): string {
  // Run Git from the folder the user opened and ask it to rebase paths to that folder. Git still reads
  // the enclosing repository/index, but a monorepo package now behaves as an independent review
  // workspace: sibling changes are excluded and UI paths start at the selected folder.
  const root = canonicalWorkspaceRoot(options.root ?? process.cwd());
  const args = ["diff", "--no-ext-diff", "--find-renames", "--relative", `--unified=${options.context}`];
  if (options.ignoreWhitespace) args.push("--ignore-all-space");
  if (options.target) {
    // Two-revision compare: no working tree/index side, so no --cached and no untracked append.
    args.push(options.base ?? "HEAD", options.target);
  } else if (options.staged) {
    args.push("--cached");
  } else {
    args.push(options.base ?? "HEAD");
  }
  args.push("--", ".");

  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git diff failed");
  }

  const chunks = [result.stdout ?? ""];
  if (options.includeUntracked && !options.staged && !options.target) {
    chunks.push(readUntrackedDiff(root));
  }
  return chunks.filter(Boolean).join("\n");
}

function readUntrackedDiff(root: string): string {
  const files = git(root, ["ls-files", "--others", "--exclude-standard", "--", "."])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks: string[] = [];

  for (const file of files) {
    const absolute = join(root, file);
    // lstat, not stat: a symlink is a change in its own right, and statSync FOLLOWS it — so a link whose
    // target is missing (or lives outside this worktree) threw here and the file was dropped without a
    // trace. Git listed it as untracked, kakapo showed "no changed files", and the two disagreed with no
    // way to tell why. Git stores a symlink as a blob holding its target, so that is what the diff shows.
    let stats: Stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      let target = "";
      try { target = readlinkSync(absolute); } catch { /* unreadable link — still worth showing the path */ }
      chunks.push([
        `diff --git a/${file} b/${file}`,
        "new file mode 120000",
        "--- /dev/null",
        `+++ b/${file}`,
        "@@ -0,0 +1 @@",
        `+${target}`,
      ].join("\n"));
      continue;
    }
    if (!stats.isFile()) continue;
    const size = stats.size;
    if (size > 500_000 || isLikelyBinary(absolute)) {
      chunks.push([
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        `Binary files /dev/null and b/${file} differ`,
      ].join("\n"));
      continue;
    }

    const content = readFileSync(absolute, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    // A wholly-new (untracked) file is all additions — there are no context lines to trim, so every line is
    // emitted as a `+` hunk regardless of the context setting.
    chunks.push([
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n"));
  }

  return chunks.join("\n");
}

export function parseUnifiedDiff(content: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const oldPath = match?.[1] ?? "unknown";
      const newPath = match?.[2] ?? oldPath;
      current = {
        oldPath,
        newPath,
        displayPath: newPath === "/dev/null" ? oldPath : newPath,
        status: "modified",
        binary: false,
        hunks: [],
      };
      files.push(current);
      hunk = undefined;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.displayPath = current.newPath;
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = stripDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = stripDiffPath(line.slice(4));
      current.displayPath = current.newPath === "/dev/null" ? current.oldPath : current.newPath;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = {
        header: line,
        title: hunkMatch[5]?.trim() ?? "",
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      continue;
    }

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "delete", oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((file) => file.binary || file.hunks.length > 0);
}

// Files that get an inline base64 preview instead of source text: raster images, and PDFs — Chromium renders
// those itself, so "view the PDF" costs a mime type here and an <embed> in the renderer rather than a PDF
// library. SVG is intentionally excluded: it is text/markup, so it stays embedded as source (and can be
// syntax-highlighted / commented). Everything this returns a mime for is carried on SourceFile.image, which
// is also what tells find-in-files and diagnostics to leave the file alone — true for a PDF as much as a PNG.
function previewMimeForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    case "avif": return "image/avif";
    case "apng": return "image/apng";
    case "pdf": return "application/pdf";
    default: return null;
  }
}

// Working-tree git status per path (git status --porcelain) for IntelliJ-style sidebar coloring:
// untracked => "new" (red), index/staged change => "staged" (green, git add'd), unstaged worktree
// change => "edited" (blue). "git add까지 되었으면" the index column wins, so staged > new/edited.
function gitStatusMap(cwd: string): Map<string, "new" | "edited" | "staged"> {
  const map = new Map<string, "new" | "edited" | "staged">();
  let out = "";
  try {
    // Porcelain's leading index/worktree columns are significant. The general git() helper trims stdout,
    // which removes the first line's leading space and corrupts its status/path; preserve raw output here.
    const result = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd, encoding: "utf8" });
    if (result.status !== 0) return map;
    out = result.stdout ?? "";
  } catch {
    return map;
  }
  // The repo-root-relative prefix depends only on cwd — compute it ONCE. It used to be recomputed per
  // status line inside workspaceRelativeStatusPath, and each recompute spawned a `git rev-parse`
  // subprocess (repoRoot); a 120-file change therefore ran ~120 git spawns (~420ms) in this map alone.
  const workspace = canonicalWorkspaceRoot(cwd);
  const statusPrefix = relative(repoRoot(workspace), workspace).replace(/\\/g, "/");
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4); // rename: color the new path
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    path = statusPathRelativeToPrefix(statusPrefix, path);
    if (!path) continue;
    let kind: "new" | "edited" | "staged";
    if (x === "?" && y === "?") kind = "new";
    else if (x !== " " && x !== "?") kind = "staged";
    else kind = "edited";
    map.set(path, kind);
  }
  return map;
}

// Strip the monorepo-subdir prefix off a repo-root-relative git-status path so it matches the diff's
// `--relative` paths. Pure string math — the caller computes `prefix` once per status map (see gitStatusMap).
function statusPathRelativeToPrefix(prefix: string, gitPath: string): string {
  const normalized = gitPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!prefix || prefix === ".") return normalized;
  return normalized === prefix ? "" : normalized.startsWith(prefix + "/") ? normalized.slice(prefix.length + 1) : "";
}

// The change set derived purely from the diff: which paths changed and, per path, the added line numbers.
// Split from tree enumeration and content collection (below) so a future partial rebuild can pair a fresh
// change set with a cached project index instead of re-deriving the whole tree every watch tick.
export function computeChangeSet(diffFiles: DiffFile[]): { changed: Set<string>; changedLinesByPath: Map<string, number[]> } {
  const changed = new Set<string>();
  const changedLinesByPath = new Map<string, number[]>();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    changed.add(file.displayPath);
    const nums: number[] = [];
    for (const hunk of file.hunks) for (const line of hunk.lines) {
      if (line.kind === "add" && typeof line.newLine === "number") nums.push(line.newLine);
    }
    changedLinesByPath.set(file.displayPath, nums);
  }
  return { changed, changedLinesByPath };
}

// Enumerate the source paths to index: the project's tracked + untracked source candidates plus any changed
// path (review evidence must stay openable even under a filtered directory), sorted for stable output. This
// tree walk is the piece a cached project index would own across ticks — it rarely changes tick-to-tick.
export function enumerateProjectPaths(root: string, changed: Set<string>): string[] {
  const paths = new Set<string>();
  const gitFiles = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."]);
  for (const file of gitFiles.split(/\r?\n/)) {
    const path = file.trim();
    if (path && isSourceCandidate(path)) paths.add(path);
  }
  // Add changed paths even when isSourceCandidate would filter them (e.g. agent config under .claude/.omc):
  // the file under review must remain openable from Cmd+1, while unchanged siblings stay filtered above.
  for (const path of changed) paths.add(path);
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

export function collectSourceFiles(
  diffFiles: DiffFile[],
  rootArg?: string,
  options: {
    previewLargeText?: boolean;
    deferSourceContent?: boolean;
    maxTotalBytes?: number;
    maxFiles?: number;
    // A→B compare: serve the source content of each changed file from this revision (commit B) instead of
    // the working tree, so comments (remap / anchor / Cmd+1) reconcile against B. app-only path.
    target?: string;
    // Diff-first startup: index ONLY the changed files (skip the whole-tree `git ls-files` + per-file stat)
    // so the first paint isn't blocked on enumerating a large repo. The full index is built in a second
    // pass and pushed to the renderer (see buildDiffReview's deferFullIndex + app-main's phase 2).
    changedPathsOnly?: boolean;
  } = {},
): SourceFile[] {
  const maxFileBytes = options.previewLargeText ? SOURCE_MAX_LAZY_FILE_BYTES : SOURCE_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? SOURCE_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? SOURCE_MAX_FILES;
  const { changed, changedLinesByPath } = computeChangeSet(diffFiles);
  const root = canonicalWorkspaceRoot(rootArg ?? process.cwd());
  const target = options.target;
  // In A→B compare there is no working-tree status; color the Changes list from the diff's own file status.
  const vcsByPath = target ? diffStatusVcsMap(diffFiles) : gitStatusMap(root);
  for (const file of diffFiles) {
    const kind = vcsByPath.get(file.displayPath);
    if (kind) file.vcs = kind; // color the Changes list from the same status map
  }
  // changedPathsOnly restricts the index to the diff's own files (they bypass isSourceCandidate anyway, so
  // no filtering is lost); the full-tree enumeration is deferred to the second pass.
  const orderedPaths = options.changedPathsOnly
    ? Array.from(changed).sort((a, b) => a.localeCompare(b))
    : enumerateProjectPaths(root, changed);
  const sourceFiles: SourceFile[] = [];
  let embeddedFiles = 0;
  let embeddedBytes = 0;

  for (const path of orderedPaths) {
    const absolute = join(root, path);
    const base: SourceFile = {
      path,
      name: basename(path),
      language: languageForPath(path),
      content: "",
      size: 0,
      changed: changed.has(path),
      embedded: false,
      changedLines: changedLinesByPath.get(path) || [],
      signature: "",
      vcs: vcsByPath.get(path),
    };

    // A→B compare: changed files are served from commit B on demand (materializeDeferredSourceFile reads the
    // blob). Deferring keeps the read off the build path and reuses the existing lazy get-source IPC. Files
    // deleted in the working tree but present in B are therefore NOT skipped here.
    if (target && base.changed) {
      sourceFiles.push({ ...base, embedded: true, deferred: true, signature: hashText(`${path}\0target\0${target}`) });
      continue;
    }

    // One stat, not existsSync()+statSync() (two syscalls per file across the whole tree): statSync throws
    // for an absent/unreadable path — the same "missing" outcome existsSync guarded — and this also closes
    // the delete-between-the-two-calls race.
    let stats: Stats;
    try {
      stats = statSync(absolute);
    } catch {
      const skippedReason = "file is not present in the working tree";
      sourceFiles.push({ ...base, signature: hashText(`${path}\0missing\0${skippedReason}`), skippedReason });
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    const previewMime = previewMimeForPath(path);
    if (previewMime) {
      if (stats.size > IMAGE_MAX_BYTES) {
        const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
        sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0image-large\0${stats.size}`), skippedReason });
      } else if (options.deferSourceContent) {
        // Read the bytes only when the reviewer opens the image. Nothing needs the data URI before then:
        // get-project-index strips `image` and sourceFileMetadata blanks it, so the renderer sees it for the
        // first time in a get-source reply. Embedding it eagerly also escaped the byte budget below outright
        // — this branch `continue`s past that check — so every image in the tree, changed or not, sat in the
        // main process once per open window at 4/3 its file size. On a 44MB repo that measured 81MB of
        // base64 per window, more than the entire text index (47MB). Same lazy path as deferred text.
        sourceFiles.push({
          ...base,
          size: stats.size,
          embedded: true,
          deferred: true,
          signature: hashText(`${path}\0image-deferred\0${stats.size}\0${stats.mtimeMs}`),
        });
      } else {
        // Standalone HTML has no per-file IPC to fetch through: its images must ship inside the document.
        const dataUri = `data:${previewMime};base64,${readFileSync(absolute).toString("base64")}`;
        sourceFiles.push({ ...base, size: stats.size, image: dataUri, signature: hashText(`${path}\0image\0${stats.size}`) });
      }
      continue;
    }

    // A file we already cached as text (same mtime+size) can't have turned binary — skip the binary
    // sniff (an open+read per file, ~635ms across this repo) on the hot watch path.
    const cacheKey = absolute;
    const cached = sourceContentCache.get(cacheKey);
    const fresh = Boolean(cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size);
    if (!fresh && isLikelyBinary(absolute)) {
      const skippedReason = "binary file";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0binary\0${stats.size}`), skippedReason });
      continue;
    }

    if (stats.size > maxFileBytes) {
      const skippedReason = `larger than ${formatBytes(maxFileBytes)}`;
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0large\0${stats.size}`), skippedReason });
      continue;
    }

    // The budget is spent walking the tree in lexicographic order, so on a large repo it was exhausted by
    // whatever sorted first and the changed files — the entire point of the review — were starved of it: 196
    // of 280 on a 30-commit range here. A changed file is bounded by the diff and capped per-file by
    // maxFileBytes above, so it is read and kept regardless of what the walk has already spent.
    const changedFile = options.deferSourceContent && base.changed;
    if (!changedFile && (embeddedFiles >= maxFiles || embeddedBytes + stats.size > maxTotalBytes)) {
      // Electron already has a per-file IPC bridge. Once the eager cache budget is exhausted, retain an
      // openable metadata record instead of permanently disabling every later file in lexical order.
      // The main process reads only the explicitly opened file via materializeDeferredSourceFile().
      if (options.deferSourceContent) {
        sourceFiles.push({
          ...base,
          size: stats.size,
          embedded: true,
          deferred: true,
          signature: hashText(`${path}\0deferred\0${stats.size}\0${stats.mtimeMs}`),
        });
        continue;
      }
      const skippedReason = "source index budget reached";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0budget\0${stats.size}`), skippedReason });
      continue;
    }

    let content: string;
    let signature: string;
    if (fresh) {
      content = cached!.content; // unchanged since last build — skip the read + hash
      signature = cached!.signature;
    } else {
      content = readFileSync(absolute, "utf8");
      signature = hashText(`${path}\0${content}`);
      sourceContentCache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, content, signature });
    }
    embeddedFiles += 1;
    embeddedBytes += stats.size;
    // In Electron `content` is only ever a read cache for the get-source IPC — nothing else in the main
    // process reads it (get-project-index strips it, and the symbol index walks the tree from disk itself).
    // Since the budget above is spent in lexicographic order, that cache was 47MB per window of whichever
    // files happened to sort first, rather than the ones a review opens. Keep the changed files and hand the
    // rest over as deferred: identical to a budget-exhausted record, except it carries the content-derived
    // signature computed just above. That distinction is load-bearing — the deferred records above are files
    // this build never read, so they can only be signed by mtime+size, while the review signature (and the
    // watch fast-path built on it) must stay a function of content alone, or an untouched checkout in a
    // different directory would look like a change.
    if (options.deferSourceContent && !base.changed) {
      sourceFiles.push({ ...base, size: stats.size, embedded: true, deferred: true, signature });
      continue;
    }
    sourceFiles.push({
      ...base,
      content,
      size: stats.size,
      embedded: true,
      signature,
    });
  }

  return sourceFiles;
}

// Sidebar VCS badge for A→B compare, derived from the diff's own file status (no working-tree concept).
function diffStatusVcsMap(diffFiles: DiffFile[]): Map<string, "new" | "edited" | "staged"> {
  const map = new Map<string, "new" | "edited" | "staged">();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    map.set(file.displayPath, file.status === "added" ? "new" : "edited");
  }
  return map;
}

// Repo-root-relative prefix for the opened workspace, so git blob specs (`<rev>:<repo-path>`) resolve for a
// monorepo subfolder. Mirrors the prefixing in diff-context.ts.
function workspaceGitPrefix(root: string): string {
  const prefix = relative(repoRoot(root), root).replace(/\\/g, "/");
  return prefix && prefix !== "." ? prefix : "";
}

// Read one file's content from commit `target` (A→B compare) instead of the working tree. Returns a fully
// materialized SourceFile: image data URI, text content, or a skipped record (absent-in-B / binary / large).
function readTargetBlobSource(root: string, file: SourceFile, target: string): SourceFile {
  const prefix = workspaceGitPrefix(root);
  const spec = `${target}:${prefix ? prefix + "/" : ""}${file.path}`;
  const previewMime = previewMimeForPath(file.path);
  if (previewMime) {
    const out = spawnSync("git", ["show", spec], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 * 50 });
    if (out.status !== 0) {
      const skippedReason = "file is not present in this revision";
      return { ...file, content: "", embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0missing-target\0${target}`) };
    }
    const data = out.stdout as Buffer;
    if (data.length > IMAGE_MAX_BYTES) {
      const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
      return { ...file, content: "", size: data.length, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0image-large\0${data.length}`) };
    }
    return { ...file, content: "", size: data.length, deferred: false, image: `data:${previewMime};base64,${data.toString("base64")}`, signature: hashText(`${file.path}\0image-target\0${data.length}`) };
  }
  const out = spawnSync("git", ["show", spec], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
  if (out.status !== 0) {
    const skippedReason = "file is not present in this revision";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0missing-target\0${target}`) };
  }
  const content = out.stdout ?? "";
  if (content.includes("\0")) {
    const skippedReason = "binary file";
    return { ...file, content: "", size: content.length, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0binary-target\0${target}`) };
  }
  if (content.length > SOURCE_MAX_LAZY_FILE_BYTES) {
    const skippedReason = `larger than ${formatBytes(SOURCE_MAX_LAZY_FILE_BYTES)}`;
    return { ...file, content: "", size: content.length, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0large-target\0${content.length}`) };
  }
  return { ...file, content, size: content.length, embedded: true, deferred: false, skippedReason: undefined, signature: hashText(`${file.path}\0${content}`) };
}

// Materialize an app-only deferred source record after the reviewer opens it. The path is accepted only
// after app-main has resolved it from the window's sourceFiles map, so callers cannot use this helper as
// an arbitrary filesystem reader. Per-file size and binary guards remain enforced at request time in case
// the working-tree file changed since the project metadata was collected. In A→B compare, `target` serves
// the file's content from commit B instead of the working tree.
export function materializeDeferredSourceFile(rootArg: string, file: SourceFile, target?: string): SourceFile {
  if (!file.deferred) return file;
  const root = canonicalWorkspaceRoot(rootArg);
  if (target) return readTargetBlobSource(root, file, target);
  const absolute = join(root, file.path);
  if (!existsSync(absolute)) {
    const skippedReason = "file is not present in the working tree";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0missing\0${skippedReason}`) };
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    const skippedReason = "not a regular file";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0not-file`) };
  }
  // Images are deferred like everything else now, so this is where their data URI is built — before the
  // binary sniff below, which would otherwise reject every PNG as "binary file". Mirrors the A→B blob path
  // in readTargetBlobSource; the size guard is re-checked here in case the file grew since it was indexed.
  const previewMime = previewMimeForPath(file.path);
  if (previewMime) {
    if (stats.size > IMAGE_MAX_BYTES) {
      const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
      return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0image-large\0${stats.size}`) };
    }
    return {
      ...file,
      content: "",
      size: stats.size,
      deferred: false,
      skippedReason: undefined,
      image: `data:${previewMime};base64,${readFileSync(absolute).toString("base64")}`,
      signature: hashText(`${file.path}\0image\0${stats.size}`),
    };
  }
  if (stats.size > SOURCE_MAX_LAZY_FILE_BYTES) {
    const skippedReason = `larger than ${formatBytes(SOURCE_MAX_LAZY_FILE_BYTES)}`;
    return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0large\0${stats.size}`) };
  }
  if (isLikelyBinary(absolute)) {
    const skippedReason = "binary file";
    return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, signature: hashText(`${file.path}\0binary\0${stats.size}`) };
  }
  const content = readFileSync(absolute, "utf8");
  return {
    ...file,
    content,
    size: stats.size,
    embedded: true,
    deferred: false,
    skippedReason: undefined,
    signature: hashText(`${file.path}\0${content}`),
  };
}

export function collectReviewFileStates(diffFiles: DiffFile[], sourceFiles: SourceFile[]): ReviewFileState[] {
  const states = new Map<string, string>();
  for (const file of sourceFiles) {
    states.set(file.path, file.signature);
  }
  for (const file of diffFiles) {
    const hunkText = file.hunks
      .map((hunk) => [
        hunk.header,
        ...hunk.lines.map((line) => `${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${line.text}`),
      ].join("\n"))
      .join("\n---\n");
    states.set(file.displayPath, hashText(`${file.displayPath}\0${file.status}\0${file.binary}\0${hunkText}`));
  }
  return Array.from(states.entries())
    .map(([path, signature]) => ({ path, signature }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Reads IntelliJ-style HTTP Client environment files from the project root and
// merges them into { envName: { varName: value } }. The private file overrides
// the public one so secrets stay out of source control.
export function collectHttpEnvironments(root: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const fileName of ["http-client.env.json", "http-client.private.env.json"]) {
    const filePath = join(root, fileName);
    if (!existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [envName, rawVars] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rawVars || typeof rawVars !== "object") continue;
      const target = result[envName] ?? (result[envName] = {});
      for (const [key, value] of Object.entries(rawVars as Record<string, unknown>)) {
        if (typeof value === "string") target[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") target[key] = String(value);
      }
    }
  }
  return result;
}

function isSourceCandidate(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized) {
    return false;
  }
  const blocked = [
    ".git/",
    ".omc/",
    ".claude/",
    ".playwright-mcp/",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    "test-results/",
    "release/",
    ".next/",
    ".turbo/",
    ".cache/",
    ".granite/",
    ".pytest_cache/",
    "__pycache__/",
    "tmp/",
    "vendor/",
  ];
  if (blocked.some((part) => normalized === part.slice(0, -1) || normalized.includes(`/${part}`) || normalized.startsWith(part))) {
    return false;
  }
  const fileName = basename(normalized);
  if (fileName === ".DS_Store" || fileName.endsWith(".lockb")) {
    return false;
  }
  return true;
}
