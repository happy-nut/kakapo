import { createRequire } from "node:module";
import type { CompareState, DiffFile, ReviewFileState, SourceFile } from "./types.js";
import { escapeAttr, escapeHtml, jsonForScript } from "./util.js";
import { diff2HtmlCss, diffClientAsset, diffCss, diffScript } from "./assets.js";
import { MESSAGES, makeTranslator } from "./i18n.js";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { REVIEW_ISLAND } from "./viewer-contract.js";
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
export function renderWelcomeHtml(
  light = false,
  recent: { path: string; name: string }[] = [],
  t: Translate = makeTranslator("en"),
  locale = "en",
): string {
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
    ? `<div class="recents" id="recents"><div class="recents-title">${escapeHtml(t("welcome.recentProjects"))}</div>${recentItems}</div>`
    : "";
  return [
    "<!doctype html>",
    `<html lang="${escapeAttr(locale)}">`,
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
    `<h1>${escapeHtml(t("welcome.heading"))}</h1>`,
    `<p>${escapeHtml(t("welcome.subtitle"))}</p>`,
    `<button class="open-btn" id="open" type="button">${escapeHtml(t("welcome.openFolder"))}</button>`,
    '<p class="hint" id="hint"></p>',
    recentsBlock,
    "</div>",
    "<script>",
    "var btn = document.getElementById('open'), hint = document.getElementById('hint');",
    "btn.addEventListener('click', function () {",
    `  if (!(window.kakapoApp && window.kakapoApp.openFolder)) { hint.textContent = ${jsonForScript(t("welcome.unavailable"))}; return; }`,
    "  btn.disabled = true; hint.textContent = '';",
    "  window.kakapoApp.openFolder().then(function (r) {",
    "    btn.disabled = false;",
    "    if (r && r.ok) return;",
    `    if (r && r.error === 'not-git') hint.textContent = ${jsonForScript(t("welcome.notGit"))};`,
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
    `    if (r && r.error === 'missing') { item.remove(); hint.textContent = ${jsonForScript(t("welcome.projectMissing"))}; }`,
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

// A ref as the pill prints it: a 40-char SHA is unreadable at 11px, and a branch name is already short.
function compareRefLabel(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
// The pill's name and the accent it carries. `count` rides beside the name (rather than inside a translated
// sentence) so neither language needs interpolation — "Incoming 3" and "리모트에서 받음 3" are the same shape.
const COMPARE_NAMES: Record<CompareState["mode"], string> = {
  local: "Local changes",
  staged: "Staged",
  ahead: "Unpushed",
  incoming: "Incoming",
  manual: "Comparing",
};
// The right-hand side of local/staged is the live tree, not a ref — the one side of this that gets translated.
function compareRightSide(state: CompareState): string {
  if (state.mode === "local") return '<span class="compare-ref" data-i18n="compare.worktree">Working tree</span>';
  if (state.mode === "staged") return '<span class="compare-ref" data-i18n="compare.index">Index</span>';
  const right = state.right || "";
  if (!right) return '<span class="compare-ref" data-i18n="compare.worktree">Working tree</span>';
  return `<span class="compare-ref">${escapeHtml(compareRefLabel(right))}</span>`;
}

// The toolbar's review-status slot: ONE pill that answers both halves of "what am I looking at" in reading
// order — the state's name, then the two refs it stands for. They were drafted as two separate controls (a
// colored chip, a direction capsule) and merged deliberately: side by side they made the toolbar say the same
// fact twice, and in the incoming case three times with the banner below. Extracted so the in-place update
// path can re-render just this strip; renderDiffHtml wraps it in <div class="review-status">.
//
// (It replaces the file/hunk counts that used to live here and were removed for duplicating the Changes tab —
// which is why the slot was sitting empty, collapsed by `.review-status:empty`, ready for this.)
export function renderReviewStatus(input: { compare?: CompareState; app?: boolean }): string {
  const state = input.compare;
  if (!state) return "";
  const count = typeof state.count === "number" && state.count > 0
    ? `<span class="compare-count">${state.count}</span>`
    : "";
  // In the app the pill is the handle for the compare dropdown, so it has to be a real button — a <span>
  // with a click handler is unreachable by keyboard and announces nothing. A static export has no git
  // process behind it and keeps the plain, inert pill.
  const tag = input.app ? "button" : "span";
  const open = input.app
    ? '<button type="button" id="compare-pill" class="compare-pill compare-' + state.mode + '" aria-haspopup="menu" aria-expanded="false"'
      + ' data-i18n-title="compare.title" title="What this diff is comparing">'
    : `<span class="compare-pill compare-${state.mode}" data-i18n-title="compare.title" title="What this diff is comparing">`;
  return [
    open,
    '<span class="compare-dot" aria-hidden="true"></span>',
    `<span class="compare-name" data-i18n="compare.${state.mode}">${COMPARE_NAMES[state.mode]}</span>`,
    count,
    '<span class="compare-refs">',
    `<span class="compare-ref">${escapeHtml(compareRefLabel(state.left || "HEAD"))}</span>`,
    '<span class="compare-arrow" aria-hidden="true">→</span>',
    compareRightSide(state),
    "</span>",
    input.app ? '<span class="compare-caret" aria-hidden="true">⌄</span>' : "",
    `</${tag}>`,
  ].join("");
}

// The one state the pill cannot fully explain: the review moved to the remote because there was nothing of
// yours left to read, and no pill can say WHY. It says only that — the refs are on the pill directly above —
// plus the single place that leads anywhere from here. (The compare bar has nothing to offer in this state:
// its patch-set list is `branch point..HEAD`, which is empty when nothing is unpushed, so the bar hides
// itself. History is where the incoming commits can actually be read.)
export function renderCompareBanner(state: CompareState | undefined): string {
  if (!state || state.mode !== "incoming") return "";
  return [
    '<span class="compare-why-mark" aria-hidden="true">↓</span>',
    '<span class="compare-why-text" data-i18n="compare.incoming.why">',
    "Nothing local to review — showing what the remote is ahead by.",
    "</span>",
    '<button type="button" id="compare-open-history" class="compare-why-link" data-keyhint="⌘9"',
    ' data-i18n="compare.openHistory">History</button>',
  ].join("");
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
  compare?: CompareState; // what this diff compares — the toolbar pill and, for `incoming`, the banner
  signature?: string;
  generatedAt?: string;
}): string {
  const fileNav = renderDiffTree(input.files);
  // A transport-backed review asks the host for the project tree only when the user opens Files. Keeping
  // this empty here removes several megabytes of repeated tree markup from large-project startup.
  const sourceNav = input.lazyLoad ? "" : renderSourceTree(input.sourceFiles);
  const initialSourceFiles = input.lazyLoad ? initialReviewSources(input.files, input.sourceFiles) : input.sourceFiles;
  const initialSourcePaths = new Set(initialSourceFiles.map((file) => file.path));
  const initialFileStates = input.lazyLoad
    ? input.fileStates.filter((file) => initialSourcePaths.has(file.path))
    : input.fileStates;
  const brandMark = kakapoIconHtml("kakapo-mark");
  const analysisStatus = input.app
    ? `<span id="analysis-status" class="analysis-status is-idle" data-phase="idle" data-generation="0" title="Code analysis has not started"><span class="analysis-status-dot" aria-hidden="true"></span><span class="analysis-status-label">Analysis idle</span></span>`
    : `<span class="app-version" id="app-version" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}${packageVersion ? '<span class="app-version-text">v' + escapeHtml(packageVersion) + "</span>" : ""}</span>`;
  const settingsButton = '<button type="button" id="app-info-btn" class="brand-reveal brand-settings" aria-haspopup="dialog" data-i18n-aria="settings.title" aria-label="Settings" data-keyhint="⌘," data-i18n-title="settings.title" title="Settings"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 3.2h4.6l.5 2.1c.6.2 1.1.5 1.6.9l2-.7 2.3 4-1.6 1.4a7 7 0 0 1 0 2.2l1.6 1.4-2.3 4-2-.7c-.5.4-1 .7-1.6.9l-.5 2.1H9.7l-.5-2.1c-.6-.2-1.1-.5-1.6-.9l-2 .7-2.3-4 1.6-1.4a7 7 0 0 1 0-2.2L3.3 9.5l2.3-4 2 .7c.5-.4 1-.7 1.6-.9z"/><circle cx="12" cy="12" r="3"/></svg></button>';
  const revealButton = '<button type="button" class="brand-reveal" id="brand-reveal" data-keyhint="⌥F1" data-i18n-title="brand.revealFile" title="Reveal open file in the sidebar" aria-label="Reveal open file in the sidebar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.4"/><path d="M12 3v3.2"/><path d="M12 17.8V21"/><path d="M3 12h3.2"/><path d="M17.8 12H21"/></svg></button>';
  const brandLoader = `<span class="kakapo-loader kakapo-loader-boot" role="status" aria-label="Kakapo is loading">${brandMark}</span>`;
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

    "</style>",
    "</head>",
    // No `native-app` class: that layout hid the in-view activity rail because the shell window's title
    // bar mirrored its icons. The shell is gone, so this rail is the only one and the window keeps a
    // standard title bar above it.
    "<body>",
    // Boot overlay (removed by the renderer once bootstrap has painted) covers the blank gap after loadFile.
    `<div id="boot-overlay">${brandLoader}</div>`,
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
    // No sidebar footer any more: the usage quota moved to the rail (per-account, not per-workspace), the
    // version and its update-download ring moved to the rail's foot (per-app, not per-workspace), and the
    // "update available" flag that was the last thing left is now one dot on the rail's Settings gear. In the
    // static export there is no rail, so the header above keeps the version there and only there.
    "",
    // The sidebar's bottom toolbar. It holds the status/actions that used to sit in the header beside the
    // project name (and, before that, on the activity rail): analysis state on the left, the actions right.
    `<div class="sidebar-tools">${analysisStatus}<span class="sidebar-tools-spacer"></span>${settingsButton}${revealButton}</div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden">',
    '<div class="toolbar diff-toolbar">',
    '<div class="diff-toolbar-file"><span class="diff-file-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.5 1.75h5l4 4v8.5h-9z"/><path d="M8.5 1.75v4h4"/></svg></span><div class="breadcrumb" id="diff-breadcrumb"></div></div>',
    '<div class="diff-toolbar-meta">',
    `<div class="review-status">${renderReviewStatus({ compare: input.compare, app: input.app })}</div>`,
    // The compare dropdown the pill above opens (Electron only). Static markup, filled by 21-compare-menu.js
    // from kakapoGit.compareMenu() each time it opens — the branch list goes stale the moment anyone commits,
    // so it is fetched on open rather than baked into the page.
    input.app
      ? '<div id="compare-menu" class="compare-menu hidden" role="menu" data-i18n-aria="compare.menu.aria" aria-label="Compare options">'
        + '<div class="compare-menu-main">'
        // The key rides INSIDE the row. data-keyhint would have been the house style, but that attribute is
        // what the hover tooltip reads, and a tooltip that covers the menu it describes is worse than no hint.
        + '<button type="button" class="compare-menu-row" role="menuitemradio" aria-checked="false" data-mode="all">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.all">All changes</span>'
        + '<span class="compare-menu-note" id="compare-menu-against"></span>'
        + '<kbd class="compare-menu-key">\u2325A</kbd>'
        + '<span class="compare-menu-check" aria-hidden="true"></span>'
        + '</button>'
        + '<button type="button" class="compare-menu-row" role="menuitemradio" aria-checked="false" data-mode="uncommitted">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.uncommitted">Uncommitted changes</span>'
        + '<kbd class="compare-menu-key">\u2325U</kbd>'
        + '<span class="compare-menu-check" aria-hidden="true"></span>'
        + '</button>'
        + '<div class="compare-menu-sep" role="separator"></div>'
        + '<button type="button" class="compare-menu-row compare-menu-branch-open" data-panel="branches" aria-haspopup="menu" aria-expanded="false">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.target">Compare against</span>'
        + '<span class="compare-menu-note" id="compare-menu-ref"></span>'
        + '<kbd class="compare-menu-key">\u2325C</kbd>'
        + '<span class="compare-menu-chevron" aria-hidden="true">\u203a</span>'
        + '</button>'
        + '</div>'
        + '<div id="compare-menu-branches" class="compare-menu-branches hidden">'
        + '<input id="compare-branch-search" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="compare.menu.searchBranch" placeholder="Search branches">'
        + '<div id="compare-branch-list" class="compare-branch-list" role="listbox" data-i18n-aria="compare.menu.target" aria-label="Compare against"></div>'
        + '</div>'
        + '</div>'
      : '',
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
    // Why the review moved to the remote. Empty (and collapsed by :empty) in every other state, so this is a
    // strip the toolbar grows only when it has something to explain.
    `<div class="compare-why" id="compare-why">${renderCompareBanner(input.compare)}</div>`,
    // Patch-set compare bar (Electron only): numbered patch-set buttons split base-left / target-right to
    // match the side-by-side diff (old | new). The viewer module fills the two groups from
    // kakapoGit.patchSets(); each button hovers its commit message. Distinct from the per-file path
    // .diff-pane-header below, which the diff nav fills with the focused file's old→new path.
    input.app
      ? '<div class="patchset-bar" id="patchset-bar" role="group" data-i18n-aria="patchset.bar" aria-label="Compare patch sets">'
        + '<div class="patchset-side patchset-side-base">'
        + '<span class="patchset-kind" data-i18n="patchset.base">Base</span>'
        + '<div class="patchset-nums" id="patchset-base-nums" role="group" data-i18n-aria="patchset.pick" aria-label="Base patch set"></div>'
        + '</div>'
        + '<div class="patchset-side patchset-side-target">'
        + '<div class="patchset-nums" id="patchset-target-nums" role="group" data-i18n-aria="patchset.pickTarget" aria-label="Target patch set"></div>'
        + '<span class="patchset-kind" data-i18n="patchset.target">Target</span>'
        + '<button type="button" id="patchset-reset" class="patchset-reset hidden" data-i18n-title="patchset.exitCompare" title="Exit compare (back to working tree)" aria-label="Exit compare"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>'
        + '</div>'
        + '</div>'
      : '',
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
    input.app
      ? '<aside id="semantic-peek" class="semantic-peek hidden" aria-label="Semantic Peek">'
        + '<div class="semantic-peek-header"><div class="semantic-peek-heading"><div id="semantic-peek-title" class="semantic-peek-title">Semantic Peek</div><div id="semantic-peek-meta" class="semantic-peek-meta"></div></div>'
        + '</div><div id="semantic-peek-results" class="semantic-peek-results" role="listbox" tabindex="0" aria-label="Semantic locations"></div>'
        + '</aside>'
      : "",
    '<div id="quick-open" class="quick-open hidden" role="dialog" aria-modal="true" data-i18n-aria="quickopen.aria" aria-label="Quick open">',
    '<div class="quick-open-panel">',
    // The rail: one dialog, several searches, and a list of them down the left so none of them depends on
    // remembering a chord. It used to appear only in the ⌘E launcher; ⌘E and double-Shift are gone, so the
    // rail now rides along in every search mode and ⌘⇧F is the single door into all of them.
    // The review-comments dock is deliberately NOT listed: commenting happens in the code itself, so the
    // merged view is a legacy surface — reachable by ⌘⇧/ and its rail dispatch, but not advertised here.
    '<nav id="quick-open-side" class="quick-open-side" aria-label="Sections">',
    '<button type="button" class="quick-open-side-item" data-section="content" data-keyhint="⌘⇧F"><span data-i18n="quickopen.findInFiles">Find in Files</span></button>',
    '<button type="button" class="quick-open-side-item" data-section="all"><span data-i18n="quickopen.searchFiles">Search files</span></button>',
    '<button type="button" class="quick-open-side-item" data-section="recent"><span data-i18n="quickopen.recent">Recent files</span></button>',
    '<div class="quick-open-side-sep" aria-hidden="true"></div>',
    '<button type="button" class="quick-open-side-item" data-section="history" data-keyhint="⌘9"><span data-i18n="rail.history">History</span></button>',
    '</nav>',
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
    '<button type="button" id="settings-close" class="settings-close" aria-label="Close settings" title="Close (Esc)">×</button>',
    '<aside class="settings-nav">',
    `<div class="settings-nav-brand" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}<div class="settings-nav-brand-meta"><span class="settings-nav-brand-name">Kakapo</span><span class="settings-ver">${packageVersion ? "v" + escapeHtml(packageVersion) : ""}</span></div></div>`,
    '<div class="settings-nav-title" data-i18n="settings.title">Settings</div>',
    '<button type="button" class="settings-cat active" data-cat="general" data-i18n="settings.cat.general">General</button>',
    '<button type="button" class="settings-cat" data-cat="shortcuts" data-i18n="settings.cat.shortcuts">Shortcuts</button>',
    '</aside>',
    '<div class="settings-body">',
    '<section class="settings-section" data-cat="general">',
    // Update status + one-click self-update (Electron); harmless no-ops in the browser build. Shaped like every
    // other preference on this page — a labelled row with its control on the right — instead of the loose blue
    // headline over a full-width button it used to be, which read as an alert bar rather than a setting.
    // The installed version is the row's label, so the status line underneath only has to say what is going on.
    '<div class="settings-card">',
    '<div class="settings-card-title" data-i18n="settings.update">Update</div>',
    '<div class="settings-row">',
    `<div class="settings-row-text"><span class="settings-row-label">Kakapo${packageVersion ? " v" + escapeHtml(packageVersion) : ""}</span>`,
    `<span id="app-info-status" class="settings-row-hint app-info-status is-loading"><span class="kakapo-loader kakapo-loader-micro" aria-hidden="true">${brandMark}</span><span data-i18n="settings.checkingUpdates">Checking for updates…</span></span></div>`,
    '<button type="button" id="app-info-update" class="plain-button app-info-update hidden" data-i18n="settings.updateRestart">Update &amp; Restart</button>',
    '</div>',
    '</div>',
    // Appearance card: language + light/dark/system theme + code theme family, each a label/hint on the left and
    // the custom themable dropdown on the right (native <select> popups ignore the app theme).
    '<div class="settings-card">',
    '<div class="settings-card-title" data-i18n="settings.appearance">Appearance</div>',
    '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.language">Language</span></div><button type="button" id="settings-language" class="settings-select mc-select" data-i18n-aria="settings.language"></button></div>',
    // Theme is one pick, not two: the family (Kakapo / Darcula) and the light/dark appearance were separate
    // dropdowns whose product you had to assemble in your head. A swatch grid shows every real theme at once,
    // each previewing its own canvas and accent — the choice is visible, not described.
    '<div class="settings-row settings-row-stacked"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.theme">Theme</span></div>',
    '<div id="settings-theme-grid" class="theme-grid" role="radiogroup" data-i18n-aria="settings.theme"></div></div>',
    // One scale for the whole app rather than a code-font size: the review is chrome + tree + diff, and
    // sizing only the code leaves the rest mismatched. Applied by main as a Chromium zoom factor.
    '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.uiScale">Font size</span><span class="settings-row-hint" data-i18n="settings.uiScale.hint">Scales the whole interface.</span></div><button type="button" id="settings-ui-scale" class="settings-select mc-select" data-i18n-aria="settings.uiScale"></button></div>',
    '</div>',
    '</section>',
    // Keyboard shortcuts moved to their own category so General stays a short, scannable preferences page.
    '<section class="settings-section hidden" data-cat="shortcuts">',
    '<div class="app-info-keys">' +
    '<div class="app-info-keys-h" data-i18n="settings.kbd.title">Keyboard shortcuts</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.app">App</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘O</kbd><span data-i18n="kbd.openFolder">Open folder</span>' +
    '<kbd>⌘⇧O</kbd><span data-i18n="kbd.openNewWindow">Open in new window</span>' +
    '<kbd>⌘,</kbd><span data-i18n="kbd.openSettings">Settings</span>' +
    '<kbd>⌘9</kbd><span data-i18n="kbd.openHistory">Git history</span>' +
    '<kbd>⌥A / ⌥U</kbd><span data-i18n="kbd.compareMode">All changes / uncommitted changes</span>' +
    '<kbd>⌥C</kbd><span data-i18n="kbd.compareRef">Choose the branch to compare against</span>' +
    '<kbd>⌘L</kbd><span data-i18n="kbd.gotoLine">Go to line</span>' +
    '<kbd>⌥Enter</kbd><span data-i18n="kbd.rowActions">Sidebar file actions (path / file manager)</span>' +
    '<kbd>Esc</kbd><span data-i18n="kbd.closeDialog">Close dialog / cancel</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.nav">Navigation</div>' +
    '<div class="keys-grid">' +
    '<kbd>F7</kbd><span data-i18n="kbd.nextChange">Next change</span>' +
    '<kbd>⇧F7</kbd><span data-i18n="kbd.prevChange">Previous change</span>' +
    '<kbd>F8 / ⇧F8</kbd><span data-i18n="kbd.nextComment">Next / previous comment</span>' +
    '<kbd>⌘1 / ⌘0</kbd><span data-i18n="kbd.filesChangesTab">Files / Changes tab</span>' +
    '<kbd>&uarr;&darr; / Enter</kbd><span data-i18n="kbd.sidebarNavigate">Navigate / open sidebar row</span>' +
    '<kbd>Tab / ⇧Tab</kbd><span data-i18n="kbd.sidebarContent">Sidebar &harr; content / diff pane</span>' +
    '<kbd>⌘F</kbd><span data-i18n="kbd.findInFile">Find in current file</span>' +
    '<kbd>⌘G / ⌘⇧G</kbd><span data-i18n="kbd.findNextPrev">Next / previous match</span>' +
    '<kbd>⌘⇧F</kbd><span data-i18n="kbd.findInFiles">Find in files</span>' +
    '<kbd>⌥E</kbd><span data-i18n="kbd.searchExtensions">Focus extension filter</span>' +
    '<kbd>⌥P</kbd><span data-i18n="kbd.excludeSearchNoise">Exclude comments / tests</span>' +
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
    '<kbd>Space</kbd><span data-i18n="kbd.toggleViewed">Toggle viewed on selected Changes row</span>' +
    '<kbd>?</kbd><span data-i18n="kbd.addComment">Add a review comment</span>' +
    '<kbd>⌘⇧/</kbd><span data-i18n="kbd.allComments">All review comments</span>' +
    '<kbd>⌘⇧W</kbd><span data-i18n="kbd.ignoreWhitespace">Ignore whitespace</span>' +
    '<kbd>⌘Enter</kbd><span data-i18n="kbd.saveComment">Save comment</span>' +
    '<kbd>&uarr; / &darr;</kbd><span data-i18n="kbd.reviewStops">Step through comments / folded context</span>' +
    '<kbd>e</kbd><span data-i18n="kbd.editComment">Edit comment (when selected)</span>' +
    '<kbd>Backspace / Delete</kbd><span data-i18n="kbd.deleteComment">Delete comment (when selected)</span>' +
    '<kbd>⌥&uarr;/&darr;</kbd><span data-i18n="kbd.stepComments">Step between comments (merged)</span>' +
    '<kbd>⌥Enter</kbd><span data-i18n="kbd.mergedSend">Comment actions (merged)</span>' +
    '<kbd>⌘⇧&#39;</kbd><span data-i18n="kbd.maximizePanel">Maximize panel</span>' +
    '</div>' +
    '<div class="keys-cat" data-i18n="settings.kbd.cat.history">History</div>' +
    '<div class="keys-grid">' +
    '<kbd>⌘9</kbd><span data-i18n="kbd.openHistory">Open / close Git history</span>' +
    '<kbd>&uarr;&darr; / Enter</kbd><span data-i18n="kbd.historyNavigate">Select a commit, open it in the review</span>' +
    '<kbd>PageUp / PageDown</kbd><span data-i18n="kbd.pageUpDown">Page up / down</span>' +
    '</div>' +
    '</div>',
    "</section>",
    // Git history (Cmd+9): the commit graph owns the full canvas. Enter opens the selected commit's
    // message + diff in a large floating workspace instead of squeezing both views side by side.
    '<div id="history-view" class="history-view hidden" role="dialog" aria-modal="true" data-i18n-aria="history.title" aria-label="Git history">',
    '<div class="history-bar">',
    '<span class="history-title" data-i18n="history.title">History</span>',
    '<span id="history-scope" class="history-scope hidden"></span>',
    '<input id="history-search" type="search" class="history-search" autocomplete="off" spellcheck="false" data-i18n-ph="history.search" placeholder="Filter by message or author">',
    '<button type="button" id="history-close" class="dock-btn" data-keyhint="Esc" data-i18n-title="history.close" title="Close" aria-label="Close">&times;</button>',
    "</div>",
    // Selection/compare status strip: shows how to compare (hint) when one commit is selected, and the
    // pending two-commit compare (with Open/Clear) once a range is shift-selected. The visible affordance
    // for picking patch sets to compare.
    '<div id="history-select-bar" class="history-select-bar hidden" aria-live="polite"></div>',
    '<div class="history-body">',
    '<div id="history-list" class="history-list"></div>',
    "</div>",
    "</div>",
    input.diffIslands || "",
    `<script type="application/json" id="${REVIEW_ISLAND.meta}" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}" data-lazy="${input.lazy ? "true" : "false"}" data-lazy-load="${input.lazyLoad ? "true" : "false"}">{}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.i18n}">${jsonForScript(MESSAGES)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.sourceFiles}">${jsonForScript(input.lazyLoad ? initialSourceFiles.map(sourceFileMetadata) : initialSourceFiles)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.fileStates}">${jsonForScript(initialFileStates)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.httpEnv}">${jsonForScript(input.httpEnvironments)}</script>`,
    `<script>window.__KAKAPO_VERSION__=${JSON.stringify(packageVersion)};</script>`,
    // The Electron app serves the ~514KB client as an external, immutably-cached kakapo-asset:// script
    // (loaded from the file:// review page, the same scheme the lazy Markdown editor already uses) so the
    // review doc is ~40% smaller and the client is parsed/cached once across windows. serve/standalone have
    // no such scheme, so they keep the inline copy.
    input.app
      ? `<script src="kakapo-asset://app/${diffClientAsset().file}?v=${diffClientAsset().version}"></script>`
      : `<script>${diffScript()}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
