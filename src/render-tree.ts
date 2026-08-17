import type { DiffFile, DiffTreeNode, SourceFile, SourceTreeNode } from "./types.js";
import { escapeAttr, escapeHtml } from "./util.js";

// The two-state (closed/open) folder glyph shared by the Changes and Files trees. CSS toggles which SVG
// shows based on the parent <details>[open] state, so both are always emitted.
const FOLDER_ICON =
  '<span class="folder-icon"><svg class="folder-ic fi-closed" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><svg class="folder-ic fi-open" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H21a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span>';

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
  // A clean tree opens straight to a README, so pick the project-root one — breadth-first (fewest path
  // segments), not the lexicographically-first match. `sourceFiles` is sorted by localeCompare, so a deep
  // `pkg/a/b/README.md` sorts before the root `README.md` and would otherwise hijack the initial open. This
  // is the ONLY README the client receives in the lazy-load path, so the depth choice must happen here.
  const readmes = sourceFiles.filter((file) => file.embedded && /^readme(?:\.|$)/i.test(file.name));
  const depth = (file: SourceFile) => file.path.split("/").length;
  const rootReadme = readmes.reduce<SourceFile | undefined>(
    (best, file) => (!best || depth(file) < depth(best) ? file : best),
    undefined,
  );
  const fallback = rootReadme
    ?? sourceFiles.find((file) => file.embedded)
    ?? sourceFiles[0];
  return fallback ? [fallback] : [];
}

// The changed-files navigation mirrors renderSourceTree's folder hierarchy so a reviewer can see where
// changes cluster and collapse whole directories, instead of scanning one flat list. Leaves keep the same
// href/data-hunk/data-file contract the diff caret and click handler rely on.
export function renderDiffTree(files: DiffFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav changes-empty">'
      + '<svg class="empty-nav-icon" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="m9.5 13.5 2 2 3.5-3.5"/></svg>'
      + '<span class="empty-nav-text" data-i18n="changes.empty">No changed files</span>'
      + '</div>';
  }

  const root: DiffTreeNode = { name: "", path: "", children: new Map() };
  let hunkIndex = 0;
  files.forEach((file, fileIndex) => {
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    const parts = file.displayPath.split("/").filter(Boolean);
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

    const leafName = parts[parts.length - 1] ?? file.displayPath;
    node.children.set(`${leafName}\0${file.displayPath}`, {
      name: leafName,
      path: file.displayPath,
      children: new Map(),
      file,
      fileIndex,
      firstHunk,
    });
  });

  return `<nav class="tree changes-tree">${renderDiffChildren(root, 0)}</nav>`;
}

function renderDiffChildren(node: DiffTreeNode, depth: number): string {
  return Array.from(node.children.values())
    .sort((a, b) => {
      if (Boolean(a.file) !== Boolean(b.file)) {
        return a.file ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((child) => renderDiffNode(child, depth))
    .join("");
}

function renderDiffNode(node: DiffTreeNode, depth: number): string {
  if (node.file) {
    const file = node.file;
    // The change type rides on the ROW, because that is what colours the name: IntelliJ says green for added,
    // blue for modified, grey for deleted, and nothing else needs saying. The working-tree state (vcs-*) used
    // to colour it instead, which put "staged" green on a DELETED file — a row that read as added and deleted
    // at the same time. Staging still colours the Files tree, where there is no change type to show.
    const classes = ["file-link", "change-row", "tree-file", "ch-" + (file.status || "modified")].join(" ");
    // Counted here and carried on the row, because the row exists for every changed file and is already the
    // client's per-file record (data-file/data-hunk). The diff BODY is materialized on demand, so counting
    // rendered +/- rows in the DOM would report nothing for any file nobody has scrolled to yet.
    const { added, deleted } = diffLineTotals(file);
    return [
      `<a class="${classes}" href="#file-${node.fileIndex}" data-hunk="${node.firstHunk}" data-file="${escapeAttr(file.displayPath)}" data-added="${added}" data-deleted="${deleted}" style="--depth:${depth}" aria-label="${escapeAttr(file.displayPath + " — " + file.status)}">`,
      viewedBox(),
      fileTypeIcon(file.displayPath),
      `<span class="change-name"><span class="path">${escapeHtml(node.name)}</span></span>`,
      "</a>",
    ].join("");
  }

  // Collapse single-child directory chains ("a/b/c") into one summary row, exactly as renderSourceNode does,
  // so a lone nested folder does not cost a click to expand.
  let labelNode: DiffTreeNode = node;
  const names = [node.name];
  for (;;) {
    const entries = Array.from(labelNode.children.values());
    if (entries.length !== 1 || entries[0].file) break;
    names.push(entries[0].name);
    labelNode = entries[0];
  }

  // Changed-file folders default to open — a review wants every change visible up front; 04-source-tree.js
  // restores any folder the reviewer chose to collapse.
  return [
    `<details class="tree-dir changes-dir" data-dir="${escapeAttr(labelNode.path)}" style="--depth:${depth}" open>`,
    `<summary>${FOLDER_ICON}<span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
    renderDiffChildren(labelNode, depth + 1),
    "</details>",
  ].join("");
}

// Added and deleted LINES for one file. Kakapo has never carried a diffstat: the Changes tree deliberately
// omits it (one number per row, on a list where every row already means "changed", is noise), but the diff
// toolbar shows exactly one file at a time and the size of that file's change is the thing you are about to
// read.
function diffLineTotals(file: DiffFile): { added: number; deleted: number } {
  let added = 0, deleted = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "delete") deleted += 1;
    }
  }
  return { added, deleted };
}

// "Reviewed this one" is a thing you DO to a row, so the row shows the control you do it with — an empty box
// on every changed file, not a mark that only exists once the state is already set. Left of the file icon,
// where a checkbox goes and where the eye can run straight down the column to see what is left.
// Drawn rather than an <input type=checkbox>: macOS paints the native control with the system chrome and
// ignores the surrounding CSS (the same reason the New-workspace dialog has no <select>), and this one lives
// inside the row's own <a>, where a real input would fight the anchor for the click.
// It replaces the status chip that used to sit here: that element rendered nothing on a modified file and
// existed, by its own comment, only to hold the viewed ✓ and to keep the filenames aligned. The box does
// both. What CHANGED is still said by the colour of the name (.change-row.ch-* in viewer.css).
function viewedBox(): string {
  return '<span class="viewed-box" role="checkbox" aria-checked="false" data-i18n-aria="tree.markViewed"></span>';
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
    `<summary>${FOLDER_ICON}<span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
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
