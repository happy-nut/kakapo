import { createRequire } from "node:module";
import type { DiffFile, ReviewFileState, SourceFile, SourceTreeNode } from "./types.js";
import { escapeAttr, escapeHtml, jsonForScript } from "./util.js";
import { diff2HtmlCss, diffCss, diffScript } from "./assets.js";
import { MESSAGES } from "./i18n.js";

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
    "<title>kakapo</title>",
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
    '<div class="badge">kakapo</div>',
    "<h1>Not a Git repository</h1>",
    "<p>kakapo reviews changes tracked by Git, but this folder isn't a Git repository yet.</p>",
    "<p>Run <code>git init</code> in this folder, then reopen kakapo.</p>",
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
    "* { box-sizing: border-box; }",
    // The same hiddenInset BrowserWindow hosts this screen. Auto margins center a short project list, but
    // collapse to zero when twelve recents make the card tall, so it scrolls from below the traffic lights
    // instead of overflowing upward underneath them.
    `body { margin: 0; min-height: 100vh; display: flex; padding: 40px 24px 24px; overflow: auto; background: ${bg}; color: ${fg}; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }`,
    ".card { width: 520px; max-width: 100%; padding: 40px; margin: auto; text-align: center; }",
    ".card .badge { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #808080; }",
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
    '<div class="badge">kakapo</div>',
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
  // the "viewed" toggle is a separate button outside this strip, so it stays. `.review-status:empty`
  // collapses the now-empty strip so it takes no space next to the breadcrumb.
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
    diff2HtmlCss(),
    diffCss(),
    "</style>",
    "</head>",
    `<body${integratedTitleBar ? ' class="native-app"' : ""}>`,
    // Boot overlay (removed by the renderer once bootstrap has painted) covers the blank gap after loadFile.
    '<div id="boot-overlay"><div class="boot-spinner"></div><div>kakapo</div></div>',
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
    `<div class="sidebar-footer"><span class="app-version">kakapo${packageVersion ? " v" + escapeHtml(packageVersion) : ""}</span>${input.app ? '<span id="analysis-status" class="analysis-status is-idle" data-phase="idle" data-generation="0" title="Code analysis has not started"><span class="analysis-status-dot" aria-hidden="true"></span><span class="analysis-status-label">Analysis idle</span></span>' : ""}<span id="app-update-flag" class="app-update-flag hidden" data-i18n="sidebar.updateAvailable" data-i18n-title="settings.updateAvailable" title="Update available">update available</span></div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden">',
    '<div class="toolbar diff-toolbar">',
    '<div class="diff-toolbar-file"><span class="diff-file-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.5 1.75h5l4 4v8.5h-9z"/><path d="M8.5 1.75v4h4"/></svg></span><div class="breadcrumb" id="diff-breadcrumb"></div></div>',
    '<div class="diff-review-controls" role="group" data-i18n-aria="diff.navigation" aria-label="Change navigation">',
    '<button type="button" id="diff-sidebar-toggle" class="diff-tool-button" data-keyhint="⌘0" data-tooltip="Hide changed files" aria-pressed="false" title="Hide changed files (⌘0)" aria-label="Hide changed files"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.25"/><path d="M5.25 2.5v11"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-prev-change" class="diff-tool-button" data-keyhint="⇧F7" data-i18n-title="diff.previous" data-i18n-aria="diff.previous" title="Previous change (Shift+F7)" aria-label="Previous change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button>',
    '<span id="diff-change-counter" class="diff-change-counter" aria-live="polite">—</span>',
    '<button type="button" id="diff-next-change" class="diff-tool-button" data-keyhint="F7" data-i18n-title="diff.next" data-i18n-aria="diff.next" title="Next change (F7)" aria-label="Next change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-open-source" class="diff-tool-button" data-keyhint="⌘↓" data-i18n-title="diff.openSource" data-i18n-aria="diff.openSource" title="Open source (Cmd/Ctrl+Down)" aria-label="Open source"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h4l1.5 2h5.5v9h-11z"/><path d="m6 10 2 2 2-2M8 7v5"/></svg></button>',
    '</div>',
    '<div class="diff-toolbar-meta">',
    `<div class="review-status">${renderReviewStatus({ files: input.files.length, hunks: totalHunks, embeddedFiles, sourceFileCount: input.sourceFiles.length, ignoreWhitespace: input.ignoreWhitespace, watch: input.watch, generatedAt: input.generatedAt })}</div>`,
    '<button type="button" id="diff-viewed-toggle" class="diff-viewed-toggle" data-keyhint="⇧," aria-pressed="false" data-i18n="btn.viewed" data-i18n-title="btn.viewed.title" title="Toggle viewed (Shift+,)" hidden>Viewed</button>',
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
    '<button type="button" id="render-toggle" class="plain-button hidden" aria-pressed="false">Raw</button>',
    '<button type="button" id="back-to-diff" class="plain-button" data-keyhint="F7" data-i18n="btn.diff" data-i18n-title="btn.diff.title" title="Back to diff (F7)">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty" data-i18n="source.selectFile">Select a file from the Files tab.</div>',
    "</section>",
    '<div id="file-find" class="file-find hidden" role="search" data-i18n-aria="find.aria" aria-label="Find in current file">',
    '<input id="file-find-input" class="file-find-input" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="find.placeholder" placeholder="Find in current file">',
    '<span id="file-find-count" class="file-find-count" aria-live="polite">0/0</span>',
    '<button type="button" id="file-find-prev" class="file-find-button" data-i18n-title="find.previous" data-i18n-aria="find.previous" title="Previous match (Shift+Enter)" aria-label="Previous match">&#8593;</button>',
    '<button type="button" id="file-find-next" class="file-find-button" data-i18n-title="find.next" data-i18n-aria="find.next" title="Next match (Enter)" aria-label="Next match">&#8595;</button>',
    '<button type="button" id="file-find-close" class="file-find-button file-find-close" data-i18n-title="find.close" data-i18n-aria="find.close" title="Close (Esc)" aria-label="Close">&times;</button>',
    '</div>',
    "</main>",
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
    `<div class="settings-h">kakapo <span class="settings-ver">${packageVersion ? "v" + escapeHtml(packageVersion) : ""}</span></div>`,
    '<div id="app-info-status" class="app-info-status" data-i18n="settings.checkingUpdates">Checking for updates…</div>',
    '<button type="button" id="app-info-update" class="plain-button app-info-update hidden" data-i18n="settings.updateRestart">Update &amp; Restart</button>',
    '<label class="settings-label" for="settings-language" data-i18n="settings.language">Language</label>',
    '<button type="button" id="settings-language" class="settings-select mc-select" data-i18n-aria="settings.language"></button>',
    '<label class="settings-label" for="settings-theme" data-i18n="settings.theme">Appearance</label>',
    '<button type="button" id="settings-theme" class="settings-select mc-select" data-i18n-aria="settings.theme"></button>',
    '<label class="settings-label" for="settings-syntax-theme" data-i18n="settings.syntaxTheme">Theme family</label>',
    '<button type="button" id="settings-syntax-theme" class="settings-select mc-select" data-i18n-aria="settings.syntaxTheme"></button>',
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
    '<kbd>⌥Enter</kbd><span data-i18n="kbd.rowActions">Sidebar file actions (path / Finder / Terminal)</span>' +
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
    '<kbd>⌘⇧M</kbd><span data-i18n="kbd.toggleRendered">Rendered / raw Markdown or CSV</span>' +
    '<kbd>⌘W</kbd><span data-i18n="kbd.closeTab">Close tab</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.review">Review</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘8</kbd><span data-i18n="kbd.changeImpact">Change Impact</span>' +
    '<kbd>⇧,</kbd><span data-i18n="kbd.toggleViewed">Toggle viewed</span>' +
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
    '</div>',
    "</section>",
    '<section class="settings-section hidden" data-cat="prompts">',
    '<div class="settings-h" data-i18n="mergePrompts.title">Merge prompts</div>',
    '<div class="settings-desc" data-i18n="mergePrompts.desc">Headings prepended to the prompts you send to the agent. The plan contract is prepended to change requests (⌘⇧.) and to the prompt memo. Leave any field blank to use the default.</div>',
    '<label class="settings-label" for="settings-prompt-plan" data-i18n="mergePrompts.planHeading">Plan contract (change requests + memo)</label>',
    '<textarea id="settings-prompt-plan" class="settings-textarea" rows="5" spellcheck="false"></textarea>',
    '<label class="settings-label" for="settings-prompt-q" data-i18n="mergePrompts.qHeading">Questions heading</label>',
    '<textarea id="settings-prompt-q" class="settings-textarea" rows="4" spellcheck="false"></textarea>',
    '<label class="settings-label" for="settings-prompt-c" data-i18n="mergePrompts.cHeading">Change-requests heading</label>',
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
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function sourceFileMetadata(file: SourceFile): SourceFile {
  return { ...file, content: "", image: "" };
}

// Changed files are sufficient for the initial diff/source transition. A clean tree gets one inexpensive
// default record so it can still open a README/source immediately; everything else arrives on demand.
function initialReviewSources(diffFiles: DiffFile[], sourceFiles: SourceFile[]): SourceFile[] {
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
    const dir = slash > 0 ? file.displayPath.slice(0, slash) : "";
    return [
      `<a class="file-link change-row${file.vcs ? " vcs-" + file.vcs : ""}" href="#file-${fileIndex}" data-hunk="${firstHunk}" data-file="${escapeAttr(file.displayPath)}" aria-label="${escapeAttr(file.displayPath + " — " + file.status)}">`,
      fileTypeIcon(file.displayPath),
      changeStatusBadge(file.status),
      `<span class="change-name"><span class="path">${escapeHtml(name)}</span>${dir ? `<span class="change-dir">${escapeHtml(dir)}</span>` : ""}</span>`,
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
