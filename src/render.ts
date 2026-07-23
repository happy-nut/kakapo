import { createRequire } from "node:module";
import type { DiffFile, ReviewFileState, SourceFile } from "./types.js";
import { escapeAttr, escapeHtml, jsonForScript } from "./util.js";
import { diff2HtmlCss, diffCss, diffScript, xtermCss, xtermScript } from "./assets.js";
import { MESSAGES } from "./i18n.js";
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import {
  initialReviewSources,
  renderDiffTree,
  renderSourceTree,
  sourceFileMetadata,
} from "./render-tree.js";
export { diffSubtitle, renderDiffTree, renderSourceTree } from "./render-tree.js";

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
  const brandMark = kakapoIconHtml("brand-mark", "Kakapo");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>kakapo</title>",
    "<style>",
    `:root { ${kakapoIconCssVariable()}; }`,
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #2b2b2b; color: #a9b7c6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }",
    ".card { max-width: 560px; padding: 40px; text-align: center; }",
    ".brand-mark { display: inline-block; width: 42px; height: 42px; background: var(--kakapo-ui-icon) center/contain no-repeat; }",
    ".card h1 { font-size: 22px; margin: 10px 0 16px; color: #ffc66d; }",
    ".card p { font-size: 14px; line-height: 1.7; margin: 10px 0; }",
    ".card code { background: #3c3f41; padding: 3px 9px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #6a8759; }",
    ".card .path { color: #808080; font-size: 12px; word-break: break-all; margin-top: 22px; }",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    brandMark,
    "<h1>Not a Git repository</h1>",
    "<p>This app reviews changes tracked by Git, but this folder isn't a Git repository yet.</p>",
    "<p>Run <code>git init</code> in this folder, then reopen the app.</p>",
    `<p class="path">${escapeHtml(root)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

// Welcome screen for the packaged .app (double-clicked, no cwd): an "Open Folder" button that asks the main
// process (window.kakapoApp.openFolder, exposed via preload) to pick a git repo and load its review.
export function renderWelcomeHtml(light = false, recent: { path: string; name: string }[] = []): string {
  const bg = light ? "#ffffff" : "#2b2b2b";
  const fg = light ? "#1f2328" : "#a9b7c6";
  const brandMark = kakapoIconHtml("brand-mark", "Kakapo");
  // Recent projects (IntelliJ-style): one click reopens a previously reviewed repo. Each row carries its
  // absolute path in data-path; the click handler hands it to kakapoApp.openRecent.
  const recentItems = recent
    .map(
      (p) =>
        `<button class="recent" type="button" data-path="${escapeAttr(p.path)}">` +
        `<span class="recent-name">${escapeHtml(p.name)}</span>` +
        `<span class="recent-path">${escapeHtml(p.path)}</span>` +
        "</button>",
    )
    .join("");
  const recentsBlock = recent.length
    ? `<div class="recents" id="recents"><div class="recents-title">Recent projects</div>${recentItems}</div>`
    : "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Kakapo</title>",
    "<style>",
    `:root { ${kakapoIconCssVariable()}; }`,
    "* { box-sizing: border-box; }",
    // The same hiddenInset BrowserWindow hosts this screen. Auto margins center a short project list, but
    // collapse to zero when twelve recents make the card tall, so it scrolls from below the traffic lights
    // instead of overflowing upward underneath them.
    `body { margin: 0; min-height: 100vh; display: flex; padding: 40px 24px 24px; overflow: auto; background: ${bg}; color: ${fg}; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }`,
    ".card { width: 520px; max-width: 100%; padding: 40px; margin: auto; text-align: center; }",
    ".brand-mark { display: inline-block; width: 48px; height: 48px; background: var(--kakapo-ui-icon) center/contain no-repeat; }",
    ".card h1 { font-size: 24px; margin: 12px 0 14px; color: #4a88c7; }",
    ".card p { font-size: 14px; line-height: 1.7; margin: 10px 0; }",
    ".open-btn { margin-top: 22px; padding: 10px 24px; font-size: 14px; font-weight: 600; color: #fff; background: #4a88c7; border: 0; border-radius: 8px; cursor: pointer; }",
    ".open-btn:hover { background: #3f78b3; }",
    ".open-btn:disabled { opacity: 0.6; cursor: default; }",
    ".hint { color: #d36c6c; font-size: 12px; min-height: 16px; margin-top: 16px; }",
    // Recent projects list: left-aligned rows below the Open Folder button.
    ".recents { margin-top: 28px; text-align: left; }",
    ".recents-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #808080; margin: 0 0 8px; padding: 0 4px; }",
    ".recent { display: block; width: 100%; text-align: left; padding: 9px 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; font: inherit; }",
    ".recent:hover { background: rgba(74, 136, 199, 0.16); }",
    ".recent:disabled { opacity: 0.5; cursor: default; }",
    ".recent-name { display: block; font-size: 13px; font-weight: 600; }",
    ".recent-path { display: block; font-size: 11px; color: #808080; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    brandMark,
    "<h1>Review a Git repository</h1>",
    "<p>Pick a folder under Git version control to review its changes.</p>",
    '<button class="open-btn" id="open" type="button">Open Folder…</button>',
    '<p class="hint" id="hint"></p>',
    recentsBlock,
    "</div>",
    "<script>",
    "var btn = document.getElementById('open'), hint = document.getElementById('hint');",
    "btn.addEventListener('click', function () {",
    "  if (!(window.kakapoApp && window.kakapoApp.openFolder)) { hint.textContent = 'Open Folder is unavailable.'; return; }",
    "  btn.disabled = true; hint.textContent = '';",
    "  window.kakapoApp.openFolder().then(function (r) {",
    "    btn.disabled = false;",
    "    if (r && r.ok) return;",
    "    if (r && r.error === 'not-git') hint.textContent = 'That folder is not a Git repository.';",
    "  }).catch(function () { btn.disabled = false; });",
    "});",
    // Recent Projects: click a row to reopen that repo in this window. A removed/non-git folder drops out.
    "var recents = document.getElementById('recents');",
    "if (recents) recents.addEventListener('click', function (e) {",
    "  var item = e.target.closest ? e.target.closest('.recent') : null;",
    "  if (!item) return;",
    "  var path = item.getAttribute('data-path');",
    "  if (!path || !(window.kakapoApp && window.kakapoApp.openRecent)) return;",
    "  item.disabled = true; hint.textContent = '';",
    "  window.kakapoApp.openRecent(path).then(function (r) {",
    "    if (r && r.ok) return;",
    "    item.disabled = false;",
    "    if (r && r.error === 'missing') { item.remove(); hint.textContent = 'That project folder is no longer available.'; }",
    "  }).catch(function () { item.disabled = false; });",
    "});",
    "</script>",
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

export function renderLazyDiffShells(files: DiffFile[]): string {
  let hunkIndex = 0;
  return files
    .map((file, i) => {
      const firstHunk = hunkIndex;
      const hunkCount = file.hunks.length;
      hunkIndex += hunkCount;
      const path = file.displayPath;
      return [
        `<div id="file-${i}" class="d2h-file-wrapper" data-path="${escapeAttr(path)}" data-first-hunk="${firstHunk}" data-hunk-count="${hunkCount}">`,
        `<div class="d2h-file-header"><span class="d2h-file-name">${escapeHtml(path)}</span></div>`,
        '<div class="d2h-files-diff" data-lazy="1"></div>',
        "</div>",
      ].join("");
    })
    .join("\n");
}

export function extractLazyDiffBody(diffHtml: string): string {
  const marker = '<div class="d2h-files-diff">';
  const open = diffHtml.indexOf(marker);
  if (open < 0) return "";
  const after = diffHtml.slice(open + marker.length);
  return after.replace(/<\/div>\s*<\/div>\s*$/, "");
}

// The toolbar's review-status row (file/hunk counts, index + live status). Extracted so the in-place
// update path can re-render just this strip; renderDiffHtml wraps it in <div class="review-status">.
export function renderReviewStatus(_input: {
  files: number;
  hunks: number;
  embeddedFiles: number;
  sourceFileCount: number;
  ignoreWhitespace?: boolean;
  watch?: boolean;
  generatedAt?: string;
}): string {
  // Deliberately empty. The reviewer asked for a clean header: file/hunk counts duplicate the Changes
  // tab, the raw generatedAt ISO string is unreadable, and "<embedded>/<total> indexed" is a STATIC
  // ratio (not a live counter), so it reads as a frozen/broken progress number. Symbol analysis now runs
  // outside the renderer and reports its selected engine inside the Change Impact panel;
  // Viewed state is intentionally changed only from the keyboard-selected row in the Changes sidebar.
  // `.review-status:empty` collapses the now-empty strip so it takes no space next to the breadcrumb.
  return "";
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
  branch?: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  app?: boolean; // Electron app — enable app-only review features such as Git history
  signature?: string;
  generatedAt?: string;
}): string {
  const totalHunks = input.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const fileNav = renderDiffTree(input.files);
  // A transport-backed review asks the host for the project tree only when the user opens Files. Keeping
  // this empty here removes several megabytes of repeated tree markup from large-project startup.
  const sourceNav = input.lazyLoad ? "" : renderSourceTree(input.sourceFiles);
  const embeddedFiles = input.sourceFiles.filter((file) => file.embedded).length;
  const initialSourceFiles = input.lazyLoad ? initialReviewSources(input.files, input.sourceFiles) : input.sourceFiles;
  const initialSourcePaths = new Set(initialSourceFiles.map((file) => file.path));
  const initialFileStates = input.lazyLoad
    ? input.fileStates.filter((file) => initialSourcePaths.has(file.path))
    : input.fileStates;
  const integratedTitleBar = input.app && process.platform === "darwin";
  const brandMark = kakapoIconHtml("kakapo-mark");
  const brandLoader = `<span class="kakapo-loader kakapo-loader-boot" role="status" aria-label="Kakapo is loading">${brandMark}</span>`;

  // IntelliJ-style activity rail: an icon per view; click navigates, hover shows a tooltip with the
  // shortcut. data-view drives both the click handler and the active-state highlight (see syncRail).
  const railButton = (view: string, labelKey: string, defaultLabel: string, kbd: string, svg: string): string =>
    `<button type="button" class="rail-btn" data-view="${view}" data-i18n-aria="${labelKey}" aria-label="${escapeAttr(defaultLabel)}">` +
    `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>` +
    `<span class="rail-tip"><span data-i18n="${labelKey}">${escapeHtml(defaultLabel)}</span><kbd>${escapeHtml(kbd)}</kbd></span>` +
    "</button>";
  const activityRail = [
    '<nav class="activity-rail" aria-label="Views">',
    '<div class="rail-group">',
    railButton("changes", "tab.changes", "Changes", "⌘0", '<circle cx="12" cy="12" r="3.2"/><line x1="3.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="20.5" y2="12"/>'),
    railButton("files", "tab.files", "Files", "⌘1", '<path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/>'),
    input.app
      ? railButton("impact", "rail.impact", "Change Impact", "⌘8", '<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 11.2l7.6-4.1M8.2 12.8l7.6 4.1"/>')
      : "",
    railButton("q", "rail.questions", "Questions", "⌘⇧/", '<path d="M5.5 5.5h13c.8 0 1.5.7 1.5 1.5v6.4c0 .8-.7 1.5-1.5 1.5H12l-4.5 3.6V16.4H5.5c-.8 0-1.5-.7-1.5-1.5V7c0-.8.7-1.5 1.5-1.5z"/><text x="12" y="13" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor" stroke="none">?</text>'),
    railButton("c", "rail.changeRequests", "Change requests", "⌘⇧.", '<path d="M14.5 5.5l4 4"/><path d="M4.5 19.5l1-4 10-10 3 3-10 10z"/>'),
    railButton("memo", "memo.title", "Markdown memo", "⌘⇧N", '<rect x="5.5" y="4" width="13" height="16" rx="1.5"/><line x1="8.5" y1="9" x2="15.5" y2="9"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/><line x1="8.5" y1="16" x2="12.5" y2="16"/>'),
    "</div>",
    '<div class="rail-group rail-bottom">',
    // Terminal (Electron only; #terminal-toggle stays hidden until a pty exists). Keeps its own id-based
    // handler in the terminal client slice rather than the data-view rail dispatcher.
    input.app
      ? '<button type="button" id="terminal-toggle" class="rail-btn terminal-toggle hidden" data-i18n-aria="terminal.title" aria-label="Terminal"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7l4 5-4 5"/><path d="M13 17h6"/></svg><span class="rail-tip"><span data-i18n="terminal.title">Terminal</span><kbd>⌃`</kbd></span></button>'
      : "",
    // History (Cmd+9): Electron only — the git-log bridge (window.kakapoGit) is exposed there.
    input.app
      ? railButton("history", "rail.history", "History", "⌘9", '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.4v5l3.2 1.9"/>')
      : "",
    // Settings gear (#app-info-btn) — existing click handler binds by id.
    '<button type="button" id="app-info-btn" class="rail-btn" aria-haspopup="dialog" data-i18n-aria="settings.title" aria-label="Settings"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 3.2h4.6l.5 2.1c.6.2 1.1.5 1.6.9l2-.7 2.3 4-1.6 1.4a7 7 0 0 1 0 2.2l1.6 1.4-2.3 4-2-.7c-.5.4-1 .7-1.6.9l-.5 2.1H9.7l-.5-2.1c-.6-.2-1.1-.5-1.6-.9l-2 .7-2.3-4 1.6-1.4a7 7 0 0 1 0-2.2L3.3 9.5l2.3-4 2 .7c.5-.4 1-.7 1.6-.9z"/><circle cx="12" cy="12" r="3"/></svg><span class="rail-tip"><span data-i18n="settings.title">Settings</span><kbd>⌘,</kbd></span></button>',
    "</div>",
    "</nav>",
  ].join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(input.title)} - ${escapeHtml(input.projectName)}</title>`,
    "<style>",
    `:root { ${kakapoIconCssVariable()}; }`,
    diff2HtmlCss(),
    diffCss(),
    input.app ? xtermCss() : "",
    "</style>",
    "</head>",
    `<body${integratedTitleBar ? ' class="native-app"' : ""}>`,
    // Boot overlay (removed by the renderer once bootstrap has painted) covers the blank gap after loadFile.
    `<div id="boot-overlay">${brandLoader}</div>`,
    activityRail,
    '<aside class="sidebar" aria-label="Review navigation">',
    `<div class="sidebar-brand" title="${escapeAttr(input.projectPath)}"><span class="brand-project">${escapeHtml(input.projectName)}</span><span class="brand-branch${input.branch ? "" : " hidden"}" data-i18n-title="rail.branch" title="Current branch"><svg class="brand-branch-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="8.5" r="2.2"/><path d="M6.5 8.2v7.6"/><path d="M17.5 10.7c0 3.2-2.2 4.4-5.5 4.9"/></svg><span class="brand-branch-name" id="brand-branch-name">${escapeHtml(input.branch || "")}</span></span></div>`,
    '<div class="sidebar-scroll">',
    input.lazy
      ? '<div class="tabs"><button type="button" class="tab active" data-tab="changes" data-i18n="tab.changes" data-i18n-title="tab.changes.title" title="Changes (⌘0)">Changes</button><button type="button" class="tab" data-tab="files" data-i18n="tab.files" data-i18n-title="tab.files.title" title="Files (⌘1)">Files</button></div>'
      : '<div class="tabs"><button type="button" class="tab" data-tab="changes" data-i18n="tab.changes" data-i18n-title="tab.changes.title" title="Changes (⌘0)">Changes</button><button type="button" class="tab active" data-tab="files" data-i18n="tab.files" data-i18n-title="tab.files.title" title="Files (⌘1)">Files</button></div>',
    `<div class="tab-panel${input.lazy ? "" : " hidden"}" id="changes-panel">${fileNav}</div>`,
    // Transport-backed reviews do not even embed an inert tree island: parsing its multi-megabyte text was
    // the dominant startup cost. Static lazy reviews retain the self-contained island fallback.
    input.lazy
      ? input.lazyLoad
        ? '<div class="tab-panel hidden" id="files-panel" data-project-index="deferred"></div>'
        : `<div class="tab-panel hidden" id="files-panel"></div><script type="text/html" id="files-tree-html">${sourceNav}</script>`
      : `<div class="tab-panel" id="files-panel">${sourceNav}</div>`,
    "</div>",
    `<div class="sidebar-footer"><span class="app-version" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}${packageVersion ? '<span class="app-version-text">v' + escapeHtml(packageVersion) + "</span>" : ""}</span>${input.app ? `<span id="analysis-status" class="analysis-status is-idle" data-phase="idle" data-generation="0" title="Code analysis has not started"><span class="analysis-status-dot" aria-hidden="true"></span><span class="analysis-status-loader" aria-hidden="true">${brandMark}</span><span class="analysis-status-label">Analysis idle</span></span>` : ""}<span id="app-update-flag" class="app-update-flag hidden" data-i18n="sidebar.updateAvailable" data-i18n-title="settings.updateAvailable" title="Update available">update available</span></div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden">',
    '<div class="toolbar diff-toolbar">',
    '<div class="diff-toolbar-file"><span class="diff-file-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.5 1.75h5l4 4v8.5h-9z"/><path d="M8.5 1.75v4h4"/></svg></span><div class="breadcrumb" id="diff-breadcrumb"></div></div>',
    '<div class="diff-toolbar-meta">',
    `<div class="review-status">${renderReviewStatus({ files: input.files.length, hunks: totalHunks, embeddedFiles, sourceFileCount: input.sourceFiles.length, ignoreWhitespace: input.ignoreWhitespace, watch: input.watch, generatedAt: input.generatedAt })}</div>`,
    '<button type="button" id="diff-line-wrap-toggle" class="source-line-wrap-toggle diff-line-wrap-toggle" role="checkbox" aria-checked="false" data-keyhint="⌥W" data-i18n="source.lineWrap" data-i18n-title="source.lineWrap.title" title="Toggle line wrap (Option+W)">Line wrap</button>',
    '</div>',
    '<div class="diff-review-controls" role="group" data-i18n-aria="diff.navigation" aria-label="Change navigation">',
    '<button type="button" id="diff-sidebar-toggle" class="diff-tool-button" data-keyhint="⌘0" data-tooltip="Hide changed files" aria-pressed="false" title="Hide changed files (⌘0)" aria-label="Hide changed files"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.25"/><path d="M5.25 2.5v11"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-prev-change" class="diff-tool-button" data-keyhint="⇧F7" data-i18n-title="diff.previous" data-i18n-aria="diff.previous" title="Previous change (Shift+F7)" aria-label="Previous change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button>',
    '<button type="button" id="diff-next-change" class="diff-tool-button" data-keyhint="F7" data-i18n-title="diff.next" data-i18n-aria="diff.next" title="Next change (F7)" aria-label="Next change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-open-source" class="diff-tool-button" data-keyhint="⌘↓" data-i18n-title="diff.openSource" data-i18n-aria="diff.openSource" title="Open source (Cmd/Ctrl+Down)" aria-label="Open source"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h4l1.5 2h5.5v9h-11z"/><path d="m6 10 2 2 2-2M8 7v5"/></svg></button>',
    '</div>',
    "</div>",
    '<div class="diff-pane-header" data-i18n-aria="diff.panes" aria-label="Diff panes">',
    '<div class="diff-pane diff-pane-base"><span class="diff-pane-kind" data-i18n="diff.base">Base</span><span id="diff-before-path" class="diff-pane-path"></span></div>',
    '<div class="diff-pane diff-pane-working"><span class="diff-pane-kind" data-i18n="diff.workingTree">Working tree</span><span id="diff-after-path" class="diff-pane-path"></span></div>',
    '</div>',
    `<div id="diff2html-container" class="diff2html-container">${input.diffHtml || '<div class="empty" data-i18n="diff.noDiff">No diff to review.</div>'}</div>`,
    "</section>",
    '<section id="source-viewer" class="source-viewer">',
    '<div id="source-tabs" class="source-tabs hidden" role="tablist"></div>',
    '<div class="toolbar source-toolbar">',
    '<div class="source-file-meta"><span id="source-type-icon" class="source-type-icon" aria-hidden="true"></span><span id="source-title" data-i18n="source.title">Source</span><span id="source-meta" data-i18n="source.selectFile">Select a file from the Files tab.</span></div>',
    '<select id="http-env-select" class="http-env-select hidden" data-i18n-title="http.env.title" data-i18n-aria="http.env.aria" title="HTTP Client environment" aria-label="HTTP environment"></select>',
    '<button type="button" id="render-toggle" class="plain-button hidden" data-keyhint="⌥R" title="Rendered / raw Markdown or CSV (Option+R)" aria-pressed="false">Raw</button>',
    '<button type="button" id="line-wrap-toggle" class="source-line-wrap-toggle hidden" role="checkbox" aria-checked="false" data-keyhint="⌥W" data-i18n="source.lineWrap" data-i18n-title="source.lineWrap.title" title="Toggle line wrap (Option+W)">Line wrap</button>',
    '<button type="button" id="back-to-diff" class="plain-button" data-keyhint="F7" data-i18n="btn.diff" data-i18n-title="btn.diff.title" title="Back to diff (F7)">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty" data-i18n="source.selectFile">Select a file from the Files tab.</div>',
    "</section>",
    '<div id="file-find" class="file-find hidden" role="search" data-i18n-aria="find.aria" aria-label="Find in current file">',
    '<input id="file-find-input" class="file-find-input" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="find.placeholder" placeholder="Find in current file">',
    '<span id="file-find-count" class="file-find-count" aria-live="polite">0/0</span>',
    '<button type="button" id="file-find-prev" class="file-find-button" data-keyhint="⇧↵" data-i18n-title="find.previous" data-i18n-aria="find.previous" title="Previous match (Shift+Enter)" aria-label="Previous match">&#8593;</button>',
    '<button type="button" id="file-find-next" class="file-find-button" data-keyhint="↵" data-i18n-title="find.next" data-i18n-aria="find.next" title="Next match (Enter)" aria-label="Next match">&#8595;</button>',
    '<button type="button" id="file-find-close" class="file-find-button file-find-close" data-keyhint="Esc" data-i18n-title="find.close" data-i18n-aria="find.close" title="Close (Esc)" aria-label="Close">&times;</button>',
    '</div>',
    "</main>",
    // Integrated terminal (Electron only): a floating xterm overlay with split panes, revealed by the rail
    // toggle / Ctrl+`. A direct body child (NOT inside .content) so send-mode dimming of .content can't make
    // this fixed panel see-through. Hidden until first opened; the client mounts xterm into #terminal-host.
    input.app
      ? '<div id="terminal-panel" class="terminal-panel hidden"><div class="terminal-resizer" aria-hidden="true"></div><div class="terminal-bar"><span class="terminal-title" data-i18n="terminal.title">Terminal</span><button type="button" id="terminal-close" class="terminal-x" data-i18n-title="terminal.close" title="Close terminal" aria-label="Close terminal">&times;</button></div><div id="terminal-host" class="terminal-host"></div></div>'
      : "",
    input.app
      ? '<aside id="impact-panel" class="impact-panel hidden" aria-label="Change Impact">'
        + '<div class="impact-header"><div><div class="impact-title" data-i18n="impact.title">Change Impact</div><div id="impact-engine" class="impact-engine"></div></div>'
        + '<button type="button" id="impact-close" class="dock-btn" data-keyhint="Esc" data-i18n-title="impact.close" title="Close" aria-label="Close">&times;</button></div>'
        + '<div id="impact-body" class="impact-body"><div class="impact-empty" data-i18n="impact.empty">Place the caret on a changed symbol to inspect its impact.</div></div>'
        + '</aside>'
      : "",
    input.app
      ? '<aside id="semantic-peek" class="semantic-peek hidden" aria-label="Semantic Peek">'
        + '<div class="semantic-peek-header"><div class="semantic-peek-heading"><div id="semantic-peek-title" class="semantic-peek-title">Semantic Peek</div><div id="semantic-peek-meta" class="semantic-peek-meta"></div></div>'
        + '</div><div id="semantic-peek-results" class="semantic-peek-results" role="listbox" tabindex="0" aria-label="Semantic locations"></div>'
        + '</aside>'
      : "",
    '<div id="quick-open" class="quick-open hidden" role="dialog" aria-modal="true" data-i18n-aria="quickopen.aria" aria-label="Quick open">',
    '<div class="quick-open-panel">',
    '<div class="quick-open-title"><span id="quick-open-mode" data-i18n="quickopen.searchFiles">Search files</span><span id="quick-open-filter" class="quick-open-filter"></span></div>',
    '<input id="quick-open-input" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="quickopen.searchFiles" placeholder="Search files">',
    '<div id="quick-open-search-options" class="quick-open-search-options">',
    '<label class="quick-open-extension-field" for="quick-open-extensions"><span data-i18n="quickopen.extensions">Extensions</span><input id="quick-open-extensions" type="text" autocomplete="off" spellcheck="false" data-i18n-ph="quickopen.extensionsPlaceholder" placeholder="All · .py, .ts" title="Filter extensions (Option+E)"></label>',
    '<button type="button" id="quick-open-exclude-noise" class="quick-open-option-toggle" aria-pressed="false" data-keyhint="⌥P"><span class="quick-open-option-check" aria-hidden="true"></span><span data-i18n="quickopen.excludeNoise">Exclude comments &amp; tests</span></button>',
    '</div>',
    '<div id="quick-open-results" class="quick-open-results"></div>',
    '<div id="quick-open-preview" class="quick-open-preview"></div>',
    "</div>",
    "</div>",
    '<div id="usages" class="quick-open hidden" role="dialog" aria-modal="true" data-i18n-aria="usages.aria" aria-label="Usages">',
    '<div class="quick-open-panel">',
    '<div class="quick-open-title"><span id="usages-title" data-i18n="usages.title">Usages</span></div>',
    '<div id="usages-results" class="quick-open-results"></div>',
    "</div>",
    "</div>",
    '<div id="settings-modal" class="settings-modal hidden" role="dialog" aria-modal="true" data-i18n-aria="settings.aria" aria-label="Settings">',
    '<div class="settings-panel">',
    '<aside class="settings-nav"><div class="settings-nav-title" data-i18n="settings.title">Settings</div><button type="button" class="settings-cat active" data-cat="general" data-i18n="settings.cat.general">General</button><button type="button" class="settings-cat" data-cat="prompts" data-i18n="settings.cat.prompts">Merge prompts</button></aside>',
    '<div class="settings-body">',
    '<section class="settings-section" data-cat="general">',
    `<div class="settings-h settings-brand" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}<span class="settings-ver">${packageVersion ? "v" + escapeHtml(packageVersion) : ""}</span></div>`,
    `<div id="app-info-status" class="app-info-status is-loading"><span class="kakapo-loader kakapo-loader-inline" aria-hidden="true">${brandMark}</span><span data-i18n="settings.checkingUpdates">Checking for updates…</span></div>`,
    '<button type="button" id="app-info-update" class="plain-button app-info-update hidden" data-i18n="settings.updateRestart">Update &amp; Restart</button>',
    '<label class="settings-label" for="settings-language" data-i18n="settings.language">Language</label>',
    '<button type="button" id="settings-language" class="settings-select mc-select" data-i18n-aria="settings.language"></button>',
    '<label class="settings-label" for="settings-theme" data-i18n="settings.theme">Appearance</label>',
    '<button type="button" id="settings-theme" class="settings-select mc-select" data-i18n-aria="settings.theme"></button>',
    '<label class="settings-label" for="settings-syntax-theme" data-i18n="settings.syntaxTheme">Theme family</label>',
    '<button type="button" id="settings-syntax-theme" class="settings-select mc-select" data-i18n-aria="settings.syntaxTheme"></button>',
    // Integrated-terminal bell → native notification opt-out (Electron only).
    input.app
      ? '<label class="settings-check"><input type="checkbox" id="set-bell-notify"><span data-i18n="settings.bellNotify">Notify when a terminal task finishes (bell)</span></label>'
      : "",
    '<div class="app-info-keys">' +
    '<div class="app-info-keys-h" data-i18n="settings.kbd.title">Keyboard shortcuts</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.app">App</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘O</kbd><span data-i18n="kbd.openFolder">Open folder</span>' +
    '<kbd>⌘⇧O</kbd><span data-i18n="kbd.openNewWindow">Open in new window</span>' +
    '<kbd>⌘,</kbd><span data-i18n="kbd.openSettings">Settings</span>' +
    '<kbd>⌘9</kbd><span data-i18n="kbd.openHistory">Git history</span>' +
    '<kbd>⌘L</kbd><span data-i18n="kbd.gotoLine">Go to line</span>' +
    '<kbd>⌘K</kbd><span data-i18n="kbd.copyLocation">Copy file:line</span>' +
    '<kbd>⌥Enter</kbd><span data-i18n="kbd.rowActions">Sidebar file actions (path / file manager / terminal)</span>' +
    '<kbd>Esc</kbd><span data-i18n="kbd.closeDialog">Close dialog / cancel</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.nav">Navigation</div>' +
    '<div class="keys-grid">' +
    '<kbd>F7</kbd><span data-i18n="kbd.nextChange">Next change</span>' +
    '<kbd>⇧F7</kbd><span data-i18n="kbd.prevChange">Previous change</span>' +
    '<kbd>⌘1 / ⌘0</kbd><span data-i18n="kbd.filesChangesTab">Files / Changes tab</span>' +
    '<kbd>&uarr;&darr; / Enter</kbd><span data-i18n="kbd.sidebarNavigate">Navigate / open sidebar row</span>' +
    '<kbd>Tab / ⇧Tab</kbd><span data-i18n="kbd.sidebarContent">Sidebar &harr; content / diff pane</span>' +
    '<kbd>⇧ ⇧</kbd><span data-i18n="kbd.findFile">Find file</span>' +
    '<kbd>⌘F</kbd><span data-i18n="kbd.findInFile">Find in current file</span>' +
    '<kbd>⌘G / ⌘⇧G</kbd><span data-i18n="kbd.findNextPrev">Next / previous match</span>' +
    '<kbd>⌘⇧F</kbd><span data-i18n="kbd.findInFiles">Find in files</span>' +
    '<kbd>⌥E</kbd><span data-i18n="kbd.searchExtensions">Focus extension filter</span>' +
    '<kbd>⌥P</kbd><span data-i18n="kbd.excludeSearchNoise">Exclude comments / tests</span>' +
    '<kbd>⌘E</kbd><span data-i18n="kbd.recentFiles">Recent files</span>' +
    '<kbd>⌘B</kbd><span data-i18n="kbd.defUsages">Definition / usages</span>' +
    '<kbd>⌘⌥B</kbd><span data-i18n="kbd.goToImplementation">Go to implementation</span>' +
    '<kbd>⌘⌥O</kbd><span data-i18n="kbd.workspaceSymbol">Workspace symbol</span>' +
    '<kbd>⌘&darr;</kbd><span data-i18n="kbd.goToDef">Go to definition</span>' +
    '<kbd>⌘.</kbd><span data-i18n="kbd.toggleFold">Toggle code fold</span>' +
    '<kbd>⌘⇧[ / ]</kbd><span data-i18n="kbd.prevNextTab">Prev / next tab</span>' +
    '<kbd>⌘[ / ]</kbd><span data-i18n="kbd.cursorBackForward">Cursor back / forward</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.editor">Editor</div>' +
    '<div class="keys-grid">' +
    '<kbd>&larr;&uarr;&darr;&rarr;</kbd><span data-i18n="kbd.moveCaret">Move caret</span>' +
    '<kbd>⌥&larr;/&rarr;</kbd><span data-i18n="kbd.wordJump">Word jump (vim w)</span>' +
    '<kbd>⌘&larr;/&rarr;</kbd><span data-i18n="kbd.lineStartEnd">Line start / end</span>' +
    '<kbd>⇧&larr;&uarr;&darr;&rarr;</kbd><span data-i18n="kbd.extendSelection">Extend selection</span>' +
    '<kbd>⌘A</kbd><span data-i18n="kbd.selectEditor">Select editor content</span>' +
    '<kbd>PageUp / PageDown</kbd><span data-i18n="kbd.pageUpDown">Page up / down</span>' +
    '<kbd>Space</kbd><span data-i18n="kbd.expandDiffFold">Expand selected diff context</span>' +
    '<kbd>⌘Enter / ⌥Enter</kbd><span data-i18n="kbd.runHttp">Run HTTP request (.http)</span>' +
    '<kbd>⌥R</kbd><span data-i18n="kbd.toggleRendered">Rendered / raw Markdown or CSV</span>' +
    '<kbd>⌥W</kbd><span data-i18n="kbd.toggleLineWrap">Toggle line wrap</span>' +
    '<kbd>⌘W</kbd><span data-i18n="kbd.closeTab">Close tab</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.review">Review</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘8</kbd><span data-i18n="kbd.changeImpact">Change Impact</span>' +
    '<kbd>Space</kbd><span data-i18n="kbd.toggleViewed">Toggle viewed on selected Changes row</span>' +
    '<kbd>? &nbsp;&gt;</kbd><span data-i18n="kbd.addQuestionChange">Add question / change</span>' +
    '<kbd>⌘⇧/ .</kbd><span data-i18n="kbd.allQuestionsChanges">All questions / changes</span>' +
    '<kbd>⌘⇧W</kbd><span data-i18n="kbd.ignoreWhitespace">Ignore whitespace</span>' +
    '<kbd>⌘Enter</kbd><span data-i18n="kbd.saveComment">Save comment</span>' +
    '<kbd>&uarr; / &darr;</kbd><span data-i18n="kbd.reviewStops">Step through comments / folded context</span>' +
    '<kbd>e</kbd><span data-i18n="kbd.editComment">Edit comment (when selected)</span>' +
    '<kbd>Backspace / Delete</kbd><span data-i18n="kbd.deleteComment">Delete comment (when selected)</span>' +
    '<kbd>⌥&uarr;/&darr;</kbd><span data-i18n="kbd.stepComments">Step between comments (merged)</span>' +
    '<kbd>⌥Enter</kbd><span data-i18n="kbd.mergedSend">Comment actions (merged)</span>' +
    '<kbd>⌘⇧N</kbd><span data-i18n="kbd.promptMemo">Prompt memo</span>' +
    '<kbd>⌘⇧&#39;</kbd><span data-i18n="kbd.maximizePanel">Maximize panel</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.history">History</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘9</kbd><span data-i18n="kbd.openHistory">Open / close Git history</span>' +
    '<kbd>&uarr;&darr; / Enter</kbd><span data-i18n="kbd.historyNavigate">Select / open commit or file</span>' +
    '<kbd>⌘0</kbd><span data-i18n="kbd.historyFiles">Focus changed files</span>' +
    '<kbd>F7 / ⇧F7</kbd><span data-i18n="kbd.historyHunks">Next / previous commit hunk</span>' +
    '<kbd>⇧Tab</kbd><span data-i18n="kbd.historyDiffPane">Switch diff pane</span>' +
    '<kbd>M</kbd><span data-i18n="kbd.historyMessage">Show / hide commit message</span>' +
    '<kbd>⌘A</kbd><span data-i18n="kbd.historySelectDiff">Select commit diff</span>' +
    '<kbd>PageUp / PageDown</kbd><span data-i18n="kbd.pageUpDown">Page up / down</span>' +
    '</div>' +
    (input.app
      ? '<div class="keys-cat" data-i18n="settings.kbd.cat.terminal">Terminal</div>' +
        '<div class="keys-grid">' +
        '<kbd>⌃` / ⌥F12</kbd><span data-i18n="kbd.toggleTerminal">Toggle terminal</span>' +
        '<kbd>⌘D</kbd><span data-i18n="kbd.splitPane">Split pane</span>' +
        '<kbd>⌘⌥[ / ]</kbd><span data-i18n="kbd.focusPane">Focus prev / next pane</span>' +
        '<kbd>⌘⌥R</kbd><span data-i18n="kbd.renamePane">Rename pane</span>' +
        '<kbd>⌘W</kbd><span data-i18n="kbd.closeTerminal">Close terminal (when focused)</span>' +
        '</div>'
      : '') +
    '</div>',
    "</section>",
    '<section class="settings-section hidden" data-cat="prompts">',
    '<div class="settings-h" data-i18n="mergePrompts.title">Merge prompts</div>',
    '<div class="settings-desc" data-i18n="mergePrompts.desc">These editable defaults are prepended to prompts sent to the agent and are saved automatically. The plan contract is prepended to change requests (⌘⇧.) and to the prompt memo.</div>',
    '<label class="settings-label" for="settings-prompt-plan" data-i18n="mergePrompts.planHeading">Plan contract (change requests + memo)</label>',
    '<textarea id="settings-prompt-plan" class="settings-textarea" rows="5" spellcheck="false"></textarea>',
    '<label class="settings-label" for="settings-prompt-q" data-i18n="mergePrompts.qHeading">Questions heading</label>',
    '<textarea id="settings-prompt-q" class="settings-textarea" rows="4" spellcheck="false"></textarea>',
    '<label class="settings-label" for="settings-prompt-c" data-i18n="mergePrompts.cHeading">Change-request instructions</label>',
    '<textarea id="settings-prompt-c" class="settings-textarea" rows="4" spellcheck="false"></textarea>',
    '<div class="settings-actions"><button type="button" id="settings-reset" class="plain-button" data-i18n="mergePrompts.reset">Reset to defaults</button><span id="settings-saved" class="settings-saved"></span></div>',
    "</section>",
    "</div>",
    "</div>",
    "</div>",
    // Git history (Cmd+9): the commit graph owns the full canvas. Enter opens the selected commit's
    // message + diff in a large floating workspace instead of squeezing both views side by side.
    '<div id="history-view" class="history-view hidden" role="dialog" aria-modal="true" data-i18n-aria="history.title" aria-label="Git history">',
    '<div class="history-bar">',
    '<span class="history-title" data-i18n="history.title">History</span>',
    '<span id="history-scope" class="history-scope hidden"></span>',
    '<input id="history-search" type="search" class="history-search" autocomplete="off" spellcheck="false" data-i18n-ph="history.search" placeholder="Filter by message or author">',
    '<button type="button" id="history-close" class="dock-btn" data-keyhint="Esc" data-i18n-title="history.close" title="Close" aria-label="Close">&times;</button>',
    "</div>",
    '<div class="history-body">',
    '<div id="history-list" class="history-list"></div>',
    '<div id="history-detail-backdrop" class="history-detail-backdrop hidden" aria-hidden="true"></div>',
    '<div id="history-detail" class="history-detail hidden" role="document" aria-hidden="true"></div>',
    "</div>",
    "</div>",
    input.diffIslands || "",
    `<script type="application/json" id="review-meta" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}" data-lazy="${input.lazy ? "true" : "false"}" data-lazy-load="${input.lazyLoad ? "true" : "false"}">{}</script>`,
    `<script type="application/json" id="i18n-data">${jsonForScript(MESSAGES)}</script>`,
    `<script type="application/json" id="source-files-data">${jsonForScript(input.lazyLoad ? initialSourceFiles.map(sourceFileMetadata) : initialSourceFiles)}</script>`,
    `<script type="application/json" id="file-state-data">${jsonForScript(initialFileStates)}</script>`,
    `<script type="application/json" id="http-env-data">${jsonForScript(input.httpEnvironments)}</script>`,
    `<script>window.__KAKAPO_VERSION__=${JSON.stringify(packageVersion)};</script>`,
    // xterm ships as an inert island (type=text/html, not parsed at startup) and is injected into a real
    // <script> by the terminal client on first open, so the ~490 KB bundle never costs a cold launch.
    input.app ? `<script type="text/html" id="xterm-code">${xtermScript()}</script>` : "",
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}
