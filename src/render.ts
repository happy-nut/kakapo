import { createRequire } from "node:module";
import type { DiffFile, ReviewFileState, SourceFile, SourceTreeNode } from "./types.js";
import { escapeAttr, escapeHtml, jsonForScript } from "./util.js";
import { diff2HtmlCss, diffCss, diffScript } from "./assets.js";

const nodeRequire = createRequire(import.meta.url);

const packageVersion: string = (() => {
  try {
    const pkg = nodeRequire("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();

export function renderNotGitRepoHtml(root: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>monacori</title>",
    "<style>",
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #2b2b2b; color: #a9b7c6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }",
    ".card { max-width: 560px; padding: 40px; text-align: center; }",
    ".card .badge { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #808080; }",
    ".card h1 { font-size: 22px; margin: 10px 0 16px; color: #ffc66d; }",
    ".card p { font-size: 14px; line-height: 1.7; margin: 10px 0; }",
    ".card code { background: #3c3f41; padding: 3px 9px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #6a8759; }",
    ".card .path { color: #808080; font-size: 12px; word-break: break-all; margin-top: 22px; }",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    '<div class="badge">monacori</div>',
    "<h1>Not a Git repository</h1>",
    "<p>monacori reviews changes tracked by Git, but this folder isn't a Git repository yet.</p>",
    "<p>Open a terminal here, run <code>git init</code>, then reopen monacori.</p>",
    `<p class="path">${escapeHtml(root)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

// Above a size threshold the diff is rendered "lazily": each file's heavy body
// (the side-by-side tables — hundreds of thousands of rows on big repos) is moved
// out of the live DOM into an inert <script type="text/html"> island, leaving only
// a lightweight wrapper + header. The renderer materializes a file's body on demand
// (scroll-into-view / navigation), so the browser never parses + lays out a giant DOM
// up front; the UI opens instantly and shortcuts work immediately. Small repos and
// tests stay on the eager path (below threshold) and are byte-for-byte unchanged.
export function shouldLazyRender(fileCount: number, totalLines: number): boolean {
  return fileCount > 60 || totalLines > 4000;
}

export function splitDiffForLazy(diffHtml: string, files: DiffFile[]): { container: string; islands: string; bodies: string[] } {
  const parts = diffHtml.split(/(?=<div [^>]*class="d2h-file-wrapper")/).filter((p) => p.includes('class="d2h-file-wrapper"'));
  const shells: string[] = [];
  const islands: string[] = [];
  const bodies: string[] = []; // dense, one per file index — used by lazy-LOAD (served on demand)
  let hunkIndex = 0;
  parts.forEach((part, i) => {
    const file = files[i];
    const firstHunk = hunkIndex;
    const hunkCount = file ? file.hunks.length : 0;
    hunkIndex += hunkCount;
    const marker = '<div class="d2h-files-diff">';
    const open = part.indexOf(marker);
    if (open < 0) {
      shells.push(part); // no diff body (e.g. binary / pure rename) — leave it materialized
      bodies.push("");
      return;
    }
    const before = part.slice(0, open);
    const after = part.slice(open + marker.length);
    const body = after.replace(/<\/div>\s*<\/div>\s*$/, "");
    const path = file ? file.displayPath : "";
    const shell =
      before.replace(
        /<div id="[^"]*" class="d2h-file-wrapper"/,
        `<div id="file-${i}" class="d2h-file-wrapper" data-path="${escapeAttr(path)}" data-first-hunk="${firstHunk}" data-hunk-count="${hunkCount}"`,
      ) + '<div class="d2h-files-diff" data-lazy="1"></div></div>';
    shells.push(shell);
    bodies.push(body);
    islands.push(`<script type="text/html" id="diff-body-${i}">${body}</script>`);
  });
  return { container: shells.join("\n"), islands: islands.join("\n"), bodies };
}

export function renderDiffHtml(input: {
  files: DiffFile[];
  diffHtml: string;
  diffIslands?: string;
  lazy?: boolean;
  lazyLoad?: boolean;
  sourceFiles: SourceFile[];
  fileStates: ReviewFileState[];
  httpEnvironments: Record<string, Record<string, string>>;
  title: string;
  subtitle: string;
  projectName: string;
  projectPath: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  signature?: string;
  generatedAt?: string;
}): string {
  const totalHunks = input.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const fileNav = renderDiffTree(input.files);
  const sourceNav = renderSourceTree(input.sourceFiles);
  const embeddedFiles = input.sourceFiles.filter((file) => file.embedded).length;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(input.title)} - ${escapeHtml(input.projectName)}</title>`,
    "<style>",
    diff2HtmlCss(),
    diffCss(),
    "</style>",
    "</head>",
    "<body>",
    '<aside class="sidebar" aria-label="Review navigation">',
    '<div class="sidebar-scroll">',
    `<div class="sidebar-brand" title="${escapeAttr(input.projectPath)}"><span class="brand-mark">monacori</span><span class="brand-project">${escapeHtml(input.projectName)}</span></div>`,
    input.lazy
      ? '<div class="tabs"><button type="button" class="tab active" data-tab="changes">Changes</button><button type="button" class="tab" data-tab="files">Files</button></div>'
      : '<div class="tabs"><button type="button" class="tab" data-tab="changes">Changes</button><button type="button" class="tab active" data-tab="files">Files</button></div>',
    `<div class="tab-panel${input.lazy ? "" : " hidden"}" id="changes-panel">${fileNav}</div>`,
    // Big repos: defer the (potentially huge) source tree — ship it as an inert island, materialized on
    // the first Files-tab open, so it never builds/lays-out at startup. Small repos render it inline.
    input.lazy
      ? `<div class="tab-panel hidden" id="files-panel"></div><script type="text/html" id="files-tree-html">${sourceNav}</script>`
      : `<div class="tab-panel" id="files-panel">${sourceNav}</div>`,
    "</div>",
    `<div class="sidebar-footer"><span class="app-version">monacori${packageVersion ? " v" + escapeHtml(packageVersion) : ""}</span><span id="app-update-flag" class="app-update-flag hidden" title="Update available">update available</span><button type="button" id="app-info-btn" class="settings-btn" aria-haspopup="dialog" aria-label="About monacori" title="About monacori">⚙</button></div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden">',
    '<div class="toolbar">',
    '<div class="breadcrumb" id="diff-breadcrumb"></div>',
    `<div class="review-status"><span>${input.files.length} files</span><span>${totalHunks} hunks</span>${input.ignoreWhitespace ? '<span class="ws-ignored" title="Whitespace ignored — Cmd/Ctrl+Shift+W">ws ignored</span>' : ""}<span class="index-status" id="index-status" title="Go-to-definition index">${embeddedFiles}/${input.sourceFiles.length} indexed</span><span class="index-progress hidden" id="index-progress" aria-hidden="true"><span class="index-progress-bar"></span></span><span class="live-status ${input.watch ? "watching" : ""}" id="live-status">${input.watch ? "watching" : escapeHtml(input.generatedAt ?? new Date().toISOString())}</span></div>`,
    '<button type="button" id="diff-viewed-toggle" class="diff-viewed-toggle" aria-pressed="false" title="Toggle viewed (<)" hidden>Viewed</button>',
    "</div>",
    `<div id="diff2html-container" class="diff2html-container">${input.diffHtml || '<div class="empty">No diff to review.</div>'}</div>`,
    "</section>",
    '<section id="source-viewer" class="source-viewer">',
    '<div id="source-tabs" class="source-tabs hidden" role="tablist"></div>',
    '<div class="toolbar source-toolbar">',
    '<div class="source-file-meta"><span id="source-type-icon" class="source-type-icon" aria-hidden="true"></span><span id="source-title">Source</span><span id="source-meta">Select a file from the Files tab.</span></div>',
    '<select id="http-env-select" class="http-env-select hidden" title="HTTP Client environment" aria-label="HTTP environment"></select>',
    '<button type="button" id="back-to-diff" class="plain-button">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty">Select a file from the Files tab.</div>',
    "</section>",
    "</main>",
    `<div id="app-info" class="app-info hidden" role="dialog" aria-modal="false" aria-label="About monacori"><div class="app-info-head">monacori <span class="app-info-ver">${packageVersion ? "v" + escapeHtml(packageVersion) : ""}</span></div><div id="app-info-status" class="app-info-status">Checking for updates…</div><button type="button" id="app-info-update" class="plain-button app-info-update hidden">Update &amp; Restart</button><div class="app-info-cmd"><code>npm i -g @happy-nut/monacori</code><button type="button" id="app-info-copy" class="plain-button">Copy</button></div><div class="app-info-keys"><div class="app-info-keys-h">Keyboard shortcuts</div><div class="keys-grid"><kbd>F7</kbd><span>Next change</span><kbd>Shift+F7</kbd><span>Previous change</span><kbd>Cmd/Ctrl+[ / ]</kbd><span>Cursor back / forward</span><kbd>Shift Shift</kbd><span>Find file</span><kbd>Cmd/Ctrl+Shift+F</kbd><span>Find in files</span><kbd>Cmd/Ctrl+E</kbd><span>Recent files</span><kbd>Cmd/Ctrl+B</kbd><span>Definition / usages</span><kbd>Cmd/Ctrl+&darr;</kbd><span>Go to definition</span><kbd>Cmd/Ctrl+1 / 0</kbd><span>Files / Changes tab</span><kbd>Tab</kbd><span>Sidebar &harr; content</span><kbd>Opt/Alt+&larr;/&rarr;</kbd><span>Word jump (vim w)</span><kbd>Cmd/Ctrl+&larr;/&rarr;</kbd><span>Line start / end</span><kbd>Shift+arrows</kbd><span>Extend selection</span><kbd>&lt;</kbd><span>Toggle viewed</span><kbd>? &nbsp;&gt;</kbd><span>Add question / change</span><kbd>Cmd/Ctrl+Shift+/ .</kbd><span>All questions / changes</span><kbd>Cmd/Ctrl+Shift+W</kbd><span>Ignore whitespace</span><kbd>Cmd/Ctrl+Enter</kbd><span>Save comment</span></div></div></div>`,
    '<div id="quick-open" class="quick-open hidden" role="dialog" aria-modal="true" aria-label="Quick open">',
    '<div class="quick-open-panel">',
    '<div class="quick-open-title"><span id="quick-open-mode">Search files</span></div>',
    '<input id="quick-open-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search files">',
    '<div id="quick-open-results" class="quick-open-results"></div>',
    '<div id="quick-open-preview" class="quick-open-preview"></div>',
    "</div>",
    "</div>",
    '<div id="usages" class="quick-open hidden" role="dialog" aria-modal="true" aria-label="Usages">',
    '<div class="quick-open-panel">',
    '<div class="quick-open-title"><span id="usages-title">Usages</span></div>',
    '<div id="usages-results" class="quick-open-results"></div>',
    "</div>",
    "</div>",
    input.diffIslands || "",
    `<script type="application/json" id="review-meta" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}" data-lazy="${input.lazy ? "true" : "false"}" data-lazy-load="${input.lazyLoad ? "true" : "false"}">{}</script>`,
    `<script type="application/json" id="source-files-data">${jsonForScript(input.lazyLoad ? input.sourceFiles.map((f) => ({ ...f, content: "", image: "" })) : input.sourceFiles)}</script>`,
    `<script type="application/json" id="file-state-data">${jsonForScript(input.fileStates)}</script>`,
    `<script type="application/json" id="http-env-data">${jsonForScript(input.httpEnvironments)}</script>`,
    `<script>window.__MONACORI_VERSION__=${JSON.stringify(packageVersion)};</script>`,
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderDiffTree(files: DiffFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No changed files</div>';
  }

  let hunkIndex = 0;
  const rows = files.map((file, fileIndex) => {
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") adds += 1;
        else if (line.kind === "delete") dels += 1;
      }
    }
    const slash = file.displayPath.lastIndexOf("/");
    const name = slash >= 0 ? file.displayPath.slice(slash + 1) : file.displayPath;
    const dir = slash > 0 ? file.displayPath.slice(0, slash) : "";
    return [
      `<a class="file-link change-row" href="#file-${fileIndex}" data-hunk="${firstHunk}" data-file="${escapeAttr(file.displayPath)}" title="${escapeAttr(file.displayPath + " — " + file.status)}">`,
      fileTypeIcon(file.displayPath),
      `<span class="status status-${escapeAttr(file.status)}">${escapeHtml(file.status)}</span>`,
      `<span class="change-name"><span class="path" title="${escapeAttr(file.displayPath)}">${escapeHtml(name)}</span>${dir ? `<span class="change-dir">${escapeHtml(dir)}</span>` : ""}</span>`,
      `<span class="diffstat">${adds ? `<span class="adds">+${adds}</span>` : ""}${dels ? `<span class="dels">−${dels}</span>` : ""}</span>`,
      "</a>",
    ].join("");
  });
  return `<nav class="tree changes-flat">${rows.join("")}</nav>`;
}

function renderSourceTree(files: SourceFile[]): string {
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
    const classes = ["file-link", "source-link", "tree-file", file.embedded ? "" : "not-embedded"].filter(Boolean).join(" ");
    const tip = file.path + (file.embedded ? "" : " — not embedded");
    return [
      `<button type="button" class="${classes}" data-source-file="${escapeAttr(file.path)}" style="--depth:${depth}" title="${escapeAttr(tip)}">`,
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
    `<summary><span class="folder-icon">v</span><span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
    renderSourceChildren(labelNode, depth + 1),
    "</details>",
  ].join("\n");
}

export function diffSubtitle(options: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
}): string {
  const source = options.staged ? "staged changes" : `working tree vs ${options.base ?? "HEAD"}`;
  const untracked = options.includeUntracked ? "including untracked files" : "tracked files only";
  return `${source}; ${untracked}; ${options.context} context lines`;
}
