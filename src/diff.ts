import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DiffFile, DiffHunk, DiffLine, ReviewFileState, SourceFile } from "./types.js";
import { FLOW_DIR, IMAGE_MAX_BYTES, SOURCE_MAX_FILE_BYTES, SOURCE_MAX_FILES, SOURCE_MAX_TOTAL_BYTES } from "./constants.js";
import { formatBytes, hashText, isLikelyBinary, languageForPath, stripDiffPath } from "./util.js";
import { git } from "./git.js";

export function readUnifiedDiff(options: {
  base?: string;
  staged: boolean;
  context: number;
  includeUntracked: boolean;
  ignoreWhitespace?: boolean;
}): string {
  const args = ["diff", "--no-ext-diff", "--find-renames", `--unified=${options.context}`];
  if (options.ignoreWhitespace) args.push("--ignore-all-space");
  if (options.staged) {
    args.push("--cached");
  } else {
    args.push(options.base ?? "HEAD");
  }
  args.push("--");

  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git diff failed");
  }

  const chunks = [result.stdout ?? ""];
  if (options.includeUntracked && !options.staged) {
    chunks.push(readUntrackedDiff(options.context));
  }
  return chunks.filter(Boolean).join("\n");
}

function readUntrackedDiff(context: number): string {
  const files = git(process.cwd(), ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(`${FLOW_DIR}/`));
  const chunks: string[] = [];

  for (const file of files) {
    const absolute = join(process.cwd(), file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      continue;
    }
    const size = statSync(absolute).size;
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
    const limited = context > 0 ? lines : lines;
    chunks.push([
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${limited.length} @@`,
      ...limited.map((line) => `+${line}`),
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

// Raster image extensions that get an inline base64 preview. SVG is intentionally excluded:
// it is text/markup, so it stays embedded as source (and can be syntax-highlighted / commented).
function imageMimeForPath(path: string): string | null {
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
    default: return null;
  }
}

export function collectSourceFiles(diffFiles: DiffFile[]): SourceFile[] {
  const changed = new Set(
    diffFiles
      .map((file) => file.displayPath)
      .filter((path) => path && path !== "/dev/null"),
  );
  const changedLinesByPath = new Map<string, number[]>();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    const nums: number[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && typeof line.newLine === "number") nums.push(line.newLine);
      }
    }
    changedLinesByPath.set(file.displayPath, nums);
  }
  const paths = new Set<string>();
  const gitFiles = git(process.cwd(), ["ls-files", "--cached", "--others", "--exclude-standard"]);
  for (const file of gitFiles.split(/\r?\n/)) {
    const path = file.trim();
    if (path && isSourceCandidate(path)) {
      paths.add(path);
    }
  }
  for (const path of changed) {
    if (isSourceCandidate(path)) {
      paths.add(path);
    }
  }

  const sourceFiles: SourceFile[] = [];
  let embeddedFiles = 0;
  let embeddedBytes = 0;

  for (const path of Array.from(paths).sort((a, b) => a.localeCompare(b))) {
    const absolute = join(process.cwd(), path);
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
    };

    if (!existsSync(absolute)) {
      const skippedReason = "file is not present in the working tree";
      sourceFiles.push({ ...base, signature: hashText(`${path}\0missing\0${skippedReason}`), skippedReason });
      continue;
    }

    const stats = statSync(absolute);
    if (!stats.isFile()) {
      continue;
    }

    const imageMime = imageMimeForPath(path);
    if (imageMime) {
      if (stats.size <= IMAGE_MAX_BYTES) {
        const dataUri = `data:${imageMime};base64,${readFileSync(absolute).toString("base64")}`;
        sourceFiles.push({ ...base, size: stats.size, image: dataUri, signature: hashText(`${path}\0image\0${stats.size}`) });
      } else {
        const skippedReason = `image larger than ${formatBytes(IMAGE_MAX_BYTES)}`;
        sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0image-large\0${stats.size}`), skippedReason });
      }
      continue;
    }

    if (isLikelyBinary(absolute)) {
      const skippedReason = "binary file";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0binary\0${stats.size}`), skippedReason });
      continue;
    }

    if (stats.size > SOURCE_MAX_FILE_BYTES) {
      const skippedReason = `larger than ${formatBytes(SOURCE_MAX_FILE_BYTES)}`;
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0large\0${stats.size}`), skippedReason });
      continue;
    }

    if (embeddedFiles >= SOURCE_MAX_FILES || embeddedBytes + stats.size > SOURCE_MAX_TOTAL_BYTES) {
      const skippedReason = "source index budget reached";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0budget\0${stats.size}`), skippedReason });
      continue;
    }

    const content = readFileSync(absolute, "utf8");
    sourceFiles.push({
      ...base,
      content,
      size: stats.size,
      embedded: true,
      signature: hashText(`${path}\0${content}`),
    });
    embeddedFiles += 1;
    embeddedBytes += stats.size;
  }

  return sourceFiles;
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
  if (!normalized || normalized.startsWith(`${FLOW_DIR}/`)) {
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
