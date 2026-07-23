import type { DiffFile, SourceFile, SourceTreeNode } from "./types.js";
import { escapeAttr, escapeHtml } from "./util.js";

// Navigation rendering is kept separate from the review-document shell so tree semantics
// and file presentation can evolve without expanding the HTML composition root.
export function sourceFileMetadata(file: SourceFile): SourceFile {
  return { ...file, content: "", image: "" };
}

// Changed files are sufficient for the initial diff/source transition. A clean tree gets one inexpensive
// default record so it can still open a README/source immediately; everything else arrives on demand.
export function initialReviewSources(diffFiles: DiffFile[], sourceFiles: SourceFile[]): SourceFile[] {
  const changedPaths = new Set<string>();
  for (const file of diffFiles) {
    if (file.oldPath && file.oldPath !== "/dev/null") changedPaths.add(file.oldPath);
    if (file.newPath && file.newPath !== "/dev/null") changedPaths.add(file.newPath);
    if (file.displayPath) changedPaths.add(file.displayPath);
  }
  const changed = sourceFiles.filter((file) => file.changed || changedPaths.has(file.path));
  if (changed.length) return changed;
  const fallback = sourceFiles.find((file) => file.embedded && /^readme(?:\.|$)/i.test(file.name))
    ?? sourceFiles.find((file) => file.embedded)
    ?? sourceFiles[0];
  return fallback ? [fallback] : [];
}

export function renderDiffTree(files: DiffFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No changed files</div>';
  }

  let hunkIndex = 0;
  const rows = files.map((file, fileIndex) => {
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    const slash = file.displayPath.lastIndexOf("/");
    const name = slash >= 0 ? file.displayPath.slice(slash + 1) : file.displayPath;
    return [
      `<a class="file-link change-row${file.vcs ? " vcs-" + file.vcs : ""}" href="#file-${fileIndex}" data-hunk="${firstHunk}" data-file="${escapeAttr(file.displayPath)}" aria-label="${escapeAttr(file.displayPath + " — " + file.status)}">`,
      fileTypeIcon(file.displayPath),
      changeStatusBadge(file.status),
      `<span class="change-name"><span class="path">${escapeHtml(name)}</span></span>`,
      "</a>",
    ].join("");
  });
  return `<nav class="tree changes-flat">${rows.join("")}</nav>`;
}

function changeStatusBadge(status: string): string {
  const label = status ? status[0].toUpperCase() + status.slice(1) : "Changed";
  let icon: string;
  switch (status) {
    case "added":
      icon = '<path d="M8 3.5v9M3.5 8h9"/>';
      break;
    case "deleted":
      icon = '<path d="M3.5 8h9"/>';
      break;
    case "renamed":
      icon = '<path d="M3 5h8m-2.5-2.5L11 5 8.5 7.5M13 11H5m2.5-2.5L5 11l2.5 2.5"/>';
      break;
    case "modified":
      icon = '<path d="m3.2 11.8.6-2.7 6.6-6.6a1.2 1.2 0 0 1 1.7 0l1.4 1.4a1.2 1.2 0 0 1 0 1.7L6.9 12.2l-2.7.6zM9.5 3.4l3.1 3.1"/>';
      break;
    default:
      icon = '<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>';
  }
  return `<span class="status status-${escapeAttr(status)}" role="img" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></span>`;
}

export function renderSourceTree(files: SourceFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No source files indexed</div>';
  }

  const root: SourceTreeNode = { name: "", path: "", children: new Map() };
  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: currentPath, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }

    const leafName = parts[parts.length - 1] ?? file.path;
    node.children.set(`${leafName}\0${file.path}`, {
      name: leafName,
      path: file.path,
      children: new Map(),
      file,
    });
  });

  return `<nav class="tree source-tree">${renderSourceChildren(root, 0)}</nav>`;
}

function renderSourceChildren(node: SourceTreeNode, depth: number): string {
  return Array.from(node.children.values())
    .sort((a, b) => {
      if (Boolean(a.file) !== Boolean(b.file)) {
        return a.file ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((child) => renderSourceNode(child, depth))
    .join("\n");
}

function fileTypeColor(ext: string): string {
  const map: Record<string, string> = {
    ts: "#3178c6", tsx: "#3178c6", mts: "#3178c6", cts: "#3178c6", "d.ts": "#3178c6",
    js: "#e8bf6a", jsx: "#e8bf6a", mjs: "#e8bf6a", cjs: "#e8bf6a",
    json: "#cbcb41", jsonc: "#cbcb41",
    yaml: "#cb9b41", yml: "#cb9b41", toml: "#cb9b41", ini: "#cb9b41", env: "#cb9b41", conf: "#cb9b41",
    lock: "#9aa0a6", gitignore: "#9aa0a6", npmrc: "#9aa0a6", editorconfig: "#9aa0a6",
    html: "#e44d26", htm: "#e44d26", vue: "#41b883", svelte: "#ff3e00", xml: "#e8bf6a", svg: "#e8bf6a",
    css: "#42a5f5", scss: "#c6538c", sass: "#c6538c", less: "#2a6db5",
    md: "#9aa0a6", mdx: "#9aa0a6", txt: "#9aa0a6", rst: "#9aa0a6",
    go: "#00add8", rs: "#dea584", py: "#3572a5", rb: "#cc342d", java: "#b07219",
    kt: "#a97bff", kts: "#a97bff", php: "#8892bf", swift: "#ff8a00", cs: "#9b59b6",
    c: "#7aa6da", h: "#7aa6da", cpp: "#f34b7d", hpp: "#f34b7d",
    sh: "#89e051", bash: "#89e051", zsh: "#89e051",
    png: "#26a269", jpg: "#26a269", jpeg: "#26a269", gif: "#26a269", webp: "#26a269", ico: "#26a269", bmp: "#26a269",
  };
  return map[ext] || "#7f868d";
}

// Small file-type glyph (a tinted folded-corner document) for the Files tree, in place of a text badge.
function fileTypeCategory(ext: string): string {
  const sets: Record<string, string[]> = {
    code: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "rs", "py", "rb", "java", "kt", "kts", "php", "c", "h", "cpp", "hpp", "cs", "swift", "sh", "bash", "zsh"],
    data: ["json", "jsonc", "yaml", "yml", "toml", "ini", "env", "conf", "lock", "xml"],
    markup: ["html", "htm", "vue", "svelte"],
    style: ["css", "scss", "sass", "less"],
    doc: ["md", "mdx", "txt", "rst"],
    image: ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg"],
  };
  for (const cat of Object.keys(sets)) {
    if (sets[cat].includes(ext)) return cat;
  }
  return "generic";
}

// A small, distinct glyph per file-type category, tinted with the language color, for the file lists.
function fileTypeIcon(path: string): string {
  const base = (path.split("/").pop() || path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : (base.startsWith(".") ? base.slice(1).toLowerCase() : "");
  const c = fileTypeColor(ext);
  const stroke = `fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;
  let inner: string;
  switch (fileTypeCategory(ext)) {
    case "code": // < >
      inner = `<path d="M6 4.6 3 8l3 3.4M10 4.6 13 8l-3 3.4" ${stroke}/>`;
      break;
    case "markup": // </>
      inner = `<path d="M5.6 4.6 2.8 8l2.8 3.4M10.4 4.6 13.2 8l-2.8 3.4M9.3 3.6 6.7 12.4" ${stroke}/>`;
      break;
    case "data": // { }
      inner = `<path d="M7.4 3.6C6.3 3.6 6.3 4.8 6.3 5.8 6.3 6.8 5.6 7.4 4.8 7.4 5.6 7.4 6.3 8 6.3 9 6.3 10 6.3 11.4 7.4 11.4M8.6 3.6C9.7 3.6 9.7 4.8 9.7 5.8 9.7 6.8 10.4 7.4 11.2 7.4 10.4 7.4 9.7 8 9.7 9 9.7 10 9.7 11.4 8.6 11.4" fill="none" stroke="${c}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case "style": // #
      inner = `<path d="M6.4 4 5.2 12M10.2 4 9 12M3.9 6.6 12 6.6M3.4 9.4 11.5 9.4" ${stroke}/>`;
      break;
    case "doc": // page with text lines
      inner = `<path d="M4.5 2.5h4.4L11.5 5v8a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.8 2.6V5h2.6M5.8 8h4M5.8 10.2h2.7" fill="none" stroke="${c}" stroke-width="1.2" stroke-linecap="round"/>`;
      break;
    case "image": // framed picture
      inner = `<rect x="3" y="3.6" width="10" height="8.8" rx="1.4" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="1.2"/><circle cx="6" cy="6.4" r="1.05" fill="none" stroke="${c}" stroke-width="1.1"/><path d="M3.6 11.8 6.7 8.4l2 2.1 1.9-2.2 2.4 2.7" fill="none" stroke="${c}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    default: // folded-corner document
      inner = `<path d="M4 2.25a1 1 0 0 1 1-1h4.3L12.5 4.7v9.05a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.2 1.4v2.8a1 1 0 0 0 1 1h2.6" fill="none" stroke="${c}" stroke-width="1.1" stroke-linejoin="round"/>`;
  }
  return `<svg class="ftype" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;
}

function renderSourceNode(node: SourceTreeNode, depth: number): string {
  if (node.file) {
    const file = node.file;
    const classes = ["file-link", "source-link", "tree-file", file.embedded ? "" : "not-embedded", file.vcs ? "vcs-" + file.vcs : ""].filter(Boolean).join(" ");
    return [
      `<button type="button" class="${classes}" data-source-file="${escapeAttr(file.path)}" style="--depth:${depth}" aria-label="${escapeAttr(file.path)}">`,
      fileTypeIcon(file.path),
      `<span class="path">${escapeHtml(node.name)}</span>`,
      "</button>",
    ].join("");
  }

  let labelNode: SourceTreeNode = node;
  const names = [node.name];
  for (;;) {
    const entries = Array.from(labelNode.children.values());
    if (entries.length !== 1 || entries[0].file) break;
    names.push(entries[0].name);
    labelNode = entries[0];
  }

  return [
    `<details class="tree-dir source-dir" data-dir="${escapeAttr(labelNode.path)}" style="--depth:${depth}">`,
    `<summary><span class="folder-icon"><svg class="folder-ic fi-closed" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><svg class="folder-ic fi-open" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H21a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span><span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
    renderSourceChildren(labelNode, depth + 1),
    "</details>",
  ].join("\n");
}

export function diffSubtitle(options: {
  base?: string;
  baseLabel?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
}): string {
  const source = options.staged ? "staged changes" : `working tree vs ${options.baseLabel ?? options.base ?? "HEAD"}`;
  const untracked = options.includeUntracked ? "including untracked files" : "tracked files only";
  return `${source}; ${untracked}; ${options.context} context lines`;
}
