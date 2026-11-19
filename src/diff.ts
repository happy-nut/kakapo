import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { DiffFile, DiffHunk, DiffLine, ReviewFileState, SourceFile, WhitespaceMode } from "./types.js";
import {
  IMAGE_MAX_BYTES,
  SOURCE_MAX_FILE_BYTES,
  SOURCE_MAX_FILES,
  SOURCE_MAX_LAZY_FILE_BYTES,
  SOURCE_MAX_TOTAL_BYTES,
} from "./constants.js";
import { ByteBudgetCache, decodeTextBuffer, formatBytes, hashText, isContainedRelativePath, isLikelyBinary, languageForPath, readTextFile, stripDiffPath, unquoteGitPath } from "./util.js";
import { canonicalWorkspaceRoot, git, isGitRepository, untrackedPaths, workspaceGitPrefix, RAW_PATHS } from "./git.js";

type SourceContentEntry = { mtimeMs: number; size: number; content: string; signature: string };
// ponytail: one global budget, evicting oldest-first. Enough to hold the workspace you are actually in, which
// is what the watch path needs; per-root budgets only if alternating two huge repos shows up as re-read cost.
const sourceContentCache = new ByteBudgetCache<SourceContentEntry>(64_000_000, (entry) => entry.content.length);

export function readUnifiedDiff(options: {
  base?: string;
  target?: string;
  staged: boolean;
  context: number;
  includeUntracked: boolean;
  ignoreWhitespace?: boolean;
  whitespace?: WhitespaceMode;
  root?: string;
  paths?: string[];
}): string {
  const root = canonicalWorkspaceRoot(options.root ?? process.cwd());
  if (!isGitRepository(root)) return "";
  // --no-ext-diff and --no-textconv: both `diff.<driver>.command` and `diff.<driver>.textconv` are config
  // the reviewed repository can set (.gitattributes picks the driver), and git runs them as commands.
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--relative", `--unified=${options.context}`];
  const whitespace = options.whitespace ?? (options.ignoreWhitespace ? "all" : "none");
  if (whitespace === "all") args.push("--ignore-all-space");
  else if (whitespace === "trim") args.push("--ignore-space-change", "--ignore-space-at-eol");
  if (options.target) {
    args.push(options.base ?? "HEAD", options.target);
  } else if (options.staged) {
    args.push("--cached");
  } else {
    args.push(options.base ?? "HEAD");
  }
  args.push("--");
  if (options.paths && options.paths.length) args.push(...options.paths);
  else args.push(".");

  const result = spawnSync("git", [...RAW_PATHS, ...args], {
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
  const files = untrackedPaths(root);
  const chunks: string[] = [];

  for (const file of files) {
    const absolute = join(root, file);
    let stats: Stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      let target = "";
      try { target = readlinkSync(absolute); } catch { }
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

    const content = readTextFile(absolute);
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
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
      const rest = line.slice("diff --git ".length);
      const span = rest.length >= 5 && (rest.length - 5) % 2 === 0 ? (rest.length - 5) / 2 : -1;
      const half = span >= 0 ? rest.slice(2, 2 + span) : "";
      const same = span >= 0 && rest === `a/${half} b/${half}` ? half : "";
      const match = same ? null : line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const quoted = same || match ? null : rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
      const oldPath = same ? same : match?.[1] ?? (quoted ? stripDiffPath(quoted[1]) : "unknown");
      const newPath = same ? same : match?.[2] ?? (quoted ? stripDiffPath(quoted[2]) : oldPath);
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

    if (hunk) {
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
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      current.modeChanged = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = unquoteGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = unquoteGitPath(line.slice("rename to ".length));
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
  }

  return files.filter((file) => (
    file.binary || file.hunks.length > 0 || file.modeChanged || file.status !== "modified"
  ));
}

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

function gitStatusMap(cwd: string): Map<string, "new" | "edited" | "staged"> {
  const map = new Map<string, "new" | "edited" | "staged">();
  let out = "";
  try {
    const result = spawnSync("git", [...RAW_PATHS, "status", "--porcelain", "--", "."], { cwd, encoding: "utf8" });
    if (result.status !== 0) return map;
    out = result.stdout ?? "";
  } catch {
    return map;
  }
  const workspace = canonicalWorkspaceRoot(cwd);
  const statusPrefix = workspaceGitPrefix(workspace);
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = unquoteGitPath(path);
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

function statusPathRelativeToPrefix(prefix: string, gitPath: string): string {
  const normalized = gitPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!prefix || prefix === ".") return normalized;
  return normalized === prefix ? "" : normalized.startsWith(prefix + "/") ? normalized.slice(prefix.length + 1) : "";
}

export function computeChangeSet(diffFiles: DiffFile[]): { changed: Set<string>; changedLinesByPath: Map<string, number[]> } {
  const changed = new Set<string>();
  const changedLinesByPath = new Map<string, number[]>();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    if (!isContainedRelativePath(file.displayPath)) continue;
    changed.add(file.displayPath);
    const nums: number[] = [];
    for (const hunk of file.hunks) for (const line of hunk.lines) {
      if (line.kind === "add" && typeof line.newLine === "number") nums.push(line.newLine);
    }
    changedLinesByPath.set(file.displayPath, nums);
  }
  return { changed, changedLinesByPath };
}

const UNWALKED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache", ".gradle", ".idea", "vendor"]);
const WALK_FILE_LIMIT = 20_000;

function walkProjectPaths(root: string): string[] {
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length && out.length < WALK_FILE_LIMIT) {
    const relativeDir = queue.shift() as string;
    let entries;
    try { entries = readdirSync(join(root, relativeDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) queue.push(path);
      } else if (entry.isFile() && isSourceCandidate(path)) {
        out.push(path);
        if (out.length >= WALK_FILE_LIMIT) break;
      }
    }
  }
  return out;
}

export function enumerateProjectPaths(root: string, changed: Set<string>): string[] {
  const paths = new Set<string>();
  const gitFiles = isGitRepository(root)
    ? git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."]).split(/\r?\n/)
    : walkProjectPaths(root);
  for (const file of gitFiles) {
    const path = file.trim();
    if (path && isSourceCandidate(path)) paths.add(path);
  }
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
    target?: string;
    changedPathsOnly?: boolean;
  } = {},
): SourceFile[] {
  const maxFileBytes = options.previewLargeText ? SOURCE_MAX_LAZY_FILE_BYTES : SOURCE_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? SOURCE_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? SOURCE_MAX_FILES;
  const { changed, changedLinesByPath } = computeChangeSet(diffFiles);
  const root = canonicalWorkspaceRoot(rootArg ?? process.cwd());
  const target = options.target;
  const vcsByPath = target ? diffStatusVcsMap(diffFiles) : gitStatusMap(root);
  for (const file of diffFiles) {
    const kind = vcsByPath.get(file.displayPath);
    if (kind) file.vcs = kind;
  }
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

    if (target && base.changed) {
      sourceFiles.push({ ...base, embedded: true, deferred: true, signature: hashText(`${path}\0target\0${target}`) });
      continue;
    }

    let stats: Stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      const skippedReason = "file is not present in the working tree";
      sourceFiles.push({ ...base, signature: hashText(`${path}\0missing\0${skippedReason}`), skippedReason, skippedKind: "missing" });
      continue;
    }
    if (stats.isSymbolicLink()) {
      let link = "";
      try { link = readlinkSync(absolute); } catch { }
      sourceFiles.push({
        ...base,
        size: Buffer.byteLength(link),
        embedded: true,
        symlink: true,
        content: link,
        signature: hashText(`${path}\0symlink\0${link}`),
      });
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    const previewMime = previewMimeForPath(path);
    if (previewMime) {
      if (stats.size > IMAGE_MAX_BYTES) {
        const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
        sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0image-large\0${stats.size}`), skippedReason, skippedKind: "imageLarge" });
      } else if (options.deferSourceContent) {
        sourceFiles.push({
          ...base,
          size: stats.size,
          embedded: true,
          deferred: true,
          signature: hashText(`${path}\0image-deferred\0${stats.size}\0${stats.mtimeMs}`),
        });
      } else {
        const dataUri = `data:${previewMime};base64,${readFileSync(absolute).toString("base64")}`;
        sourceFiles.push({ ...base, size: stats.size, image: dataUri, signature: hashText(`${path}\0image\0${stats.size}`) });
      }
      continue;
    }

    const cacheKey = absolute;
    const cached = sourceContentCache.get(cacheKey);
    const fresh = Boolean(cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size);
    if (!fresh && isLikelyBinary(absolute)) {
      const skippedReason = "binary file";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0binary\0${stats.size}`), skippedReason, skippedKind: "binary" });
      continue;
    }

    if (stats.size > maxFileBytes) {
      const skippedReason = `larger than ${formatBytes(maxFileBytes)}`;
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0large\0${stats.size}`), skippedReason, skippedKind: "large" });
      continue;
    }

    const changedFile = options.deferSourceContent && base.changed;
    if (!changedFile && (embeddedFiles >= maxFiles || embeddedBytes + stats.size > maxTotalBytes)) {
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
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0budget\0${stats.size}`), skippedReason, skippedKind: "budget" });
      continue;
    }

    let content: string;
    let signature: string;
    if (fresh) {
      content = cached!.content;
      signature = cached!.signature;
    } else {
      content = readTextFile(absolute);
      signature = hashText(`${path}\0${content}`);
      sourceContentCache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, content, signature });
    }
    embeddedFiles += 1;
    embeddedBytes += stats.size;
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

function diffStatusVcsMap(diffFiles: DiffFile[]): Map<string, "new" | "edited" | "staged"> {
  const map = new Map<string, "new" | "edited" | "staged">();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    map.set(file.displayPath, file.status === "added" ? "new" : "edited");
  }
  return map;
}

function missingTargetSource(file: SourceFile, target: string): SourceFile {
  const skippedReason = `revision ${target} is no longer in this repository`;
  return {
    ...file, content: "", embedded: false, deferred: false, skippedReason,
    skippedKind: "missingTarget", skippedDetail: target,
    signature: hashText(`${file.path}\0missing-revision\0${target}`),
  };
}

function revisionExists(root: string, target: string): boolean {
  const out = spawnSync("git", [...RAW_PATHS, "rev-parse", "--verify", "--quiet", `${target}^{commit}`], {
    cwd: root, encoding: "utf8",
  });
  return out.status === 0;
}

function readTargetBlobSource(root: string, file: SourceFile, target: string): SourceFile {
  const prefix = workspaceGitPrefix(root);
  const spec = `${target}:${prefix ? prefix + "/" : ""}${file.path}`;
  const previewMime = previewMimeForPath(file.path);
  if (previewMime) {
    const out = spawnSync("git", [...RAW_PATHS, "show", "--no-textconv", spec], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 * 50 });
    if (out.status !== 0) {
      if (!revisionExists(root, target)) return missingTargetSource(file, target);
      const skippedReason = "file is not present in this revision";
      return { ...file, content: "", embedded: false, deferred: false, skippedReason, skippedKind: "missingRevision", signature: hashText(`${file.path}\0missing-target\0${target}`) };
    }
    const data = out.stdout as Buffer;
    if (data.length > IMAGE_MAX_BYTES) {
      const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
      return { ...file, content: "", size: data.length, embedded: false, deferred: false, skippedReason, skippedKind: "imageLarge", signature: hashText(`${file.path}\0image-large\0${data.length}`) };
    }
    return { ...file, content: "", size: data.length, deferred: false, image: `data:${previewMime};base64,${data.toString("base64")}`, signature: hashText(`${file.path}\0image-target\0${data.length}`) };
  }
  const out = spawnSync("git", [...RAW_PATHS, "show", "--no-textconv", spec], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 * 50 });
  if (out.status !== 0) {
    if (!revisionExists(root, target)) return missingTargetSource(file, target);
    const skippedReason = "file is not present in this revision";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, skippedKind: "missingRevision", signature: hashText(`${file.path}\0missing-target\0${target}`) };
  }
  const content = decodeTextBuffer((out.stdout as Buffer | undefined) ?? Buffer.alloc(0));
  const bytes = Buffer.byteLength(content, "utf8");
  if (content.slice(0, 8192).includes("\0")) {
    const skippedReason = "binary file";
    return { ...file, content: "", size: bytes, embedded: false, deferred: false, skippedReason, skippedKind: "binary", signature: hashText(`${file.path}\0binary-target\0${target}`) };
  }
  if (bytes > SOURCE_MAX_LAZY_FILE_BYTES) {
    const skippedReason = `larger than ${formatBytes(SOURCE_MAX_LAZY_FILE_BYTES)}`;
    return { ...file, content: "", size: bytes, embedded: false, deferred: false, skippedReason, skippedKind: "large", signature: hashText(`${file.path}\0large-target\0${bytes}`) };
  }
  return { ...file, content, size: bytes, embedded: true, deferred: false, skippedReason: undefined, signature: hashText(`${file.path}\0${content}`) };
}

export function materializeDeferredSourceFile(rootArg: string, file: SourceFile, target?: string): SourceFile {
  if (!file.deferred) return file;
  const root = canonicalWorkspaceRoot(rootArg);
  if (target) return readTargetBlobSource(root, file, target);
  const absolute = join(root, file.path);
  if (!existsSync(absolute)) {
    const skippedReason = "file is not present in the working tree";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, skippedKind: "missing", signature: hashText(`${file.path}\0missing\0${skippedReason}`) };
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    const skippedReason = "not a regular file";
    return { ...file, content: "", embedded: false, deferred: false, skippedReason, skippedKind: "notFile", signature: hashText(`${file.path}\0not-file`) };
  }
  const previewMime = previewMimeForPath(file.path);
  if (previewMime) {
    if (stats.size > IMAGE_MAX_BYTES) {
      const skippedReason = `file larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
      return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, skippedKind: "imageLarge", signature: hashText(`${file.path}\0image-large\0${stats.size}`) };
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
    return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, skippedKind: "large", signature: hashText(`${file.path}\0large\0${stats.size}`) };
  }
  if (isLikelyBinary(absolute)) {
    const skippedReason = "binary file";
    return { ...file, content: "", size: stats.size, embedded: false, deferred: false, skippedReason, skippedKind: "binary", signature: hashText(`${file.path}\0binary\0${stats.size}`) };
  }
  const content = readTextFile(absolute);
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

export function collectHttpEnvironments(root: string, httpPaths: string[] = []): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const dirs: string[] = [""];
  for (const path of httpPaths) {
    const normalized = String(path).replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) continue;
    const relativeDir = normalized.replace(/\/[^/]*$/, "");
    if (relativeDir && relativeDir !== normalized && !dirs.includes(relativeDir)) dirs.push(relativeDir);
  }
  dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const assign = (target: Record<string, string>, rawVars: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(rawVars)) {
      if (typeof value === "string") target[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") target[key] = String(value);
    }
  };
  for (const dir of dirs) {
    for (const fileName of [".env", ".env.local"]) {
      const filePath = join(root, dir, fileName);
      if (!existsSync(filePath)) continue;
      const target = result.$dotenv ?? (result.$dotenv = {});
      try {
        for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
          const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (!match || line.trim().startsWith("#")) continue;
          target[match[1]] = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
        }
      } catch { }
    }
    for (const fileName of ["http-client.env.json", "http-client.private.env.json"]) {
      const filePath = join(root, dir, fileName);
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
        const { SSLConfiguration: ssl, Security: _security, ...variables } = rawVars as Record<string, unknown>;
        assign(target, variables);
        if (ssl && typeof ssl === "object") {
          const store = result.$ssl ?? (result.$ssl = {});
          store[envName] = JSON.stringify(ssl);
        }
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
