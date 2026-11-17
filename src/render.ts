import { createRequire } from "node:module";
import type { CompareState, DiffFile, ReviewFileState, SourceFile } from "./types.js";
import { escapeAttr, escapeHtml, jsonForScript } from "./util.js";
import { diff2HtmlCss, diffClientAsset, diffCss, diffScript } from "./assets.js";
import { MESSAGES, makeTranslator } from "./i18n.js";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { EMPTY_PROJECT_LAYOUT, type ProjectLayout } from "./project-layout.js";
import { REVIEW_ISLAND } from "./viewer-contract.js";
import { SHORTCUTS, SHORTCUT_GROUPS } from "./shortcuts.js";

function keyHint(ref: string): string {
  const [id, index] = ref.split(":");
  const def = SHORTCUTS.find((s) => s.id === id);
  const chord = def?.keys[Number(index || 0)];
  if (!chord) throw new Error(`keyHint: no combination "${ref}"`);
  return ` data-keyhint-id="${escapeAttr(ref)}" data-keyhint="${escapeAttr(chord)}"`;
}
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

const MODIFIER_GLYPHS = new Set(["⌘", "⇧", "⌥", "⌃"]);
function keyChips(combo: string): string {
  return combo.split(" / ").map((group) => {
    const chips: string[] = [];
    let rest = group.trim();
    while (rest.length && MODIFIER_GLYPHS.has(rest[0])) {
      chips.push(rest[0]);
      rest = rest.slice(1);
    }
    if (/^[←↑↓→]+$/.test(rest)) chips.push(...rest.split(""));
    else if (rest.length) chips.push(rest);
    return `<span class="keys-combo">${chips.map((c) => `<kbd>${escapeHtml(c)}</kbd>`).join("")}</span>`;
  }).join('<span class="keys-or">/</span>');
}
function shortcutRow(combo: string, i18nKey: string, label: string, id = "", fixed = ""): string {
  const attrs = id ? ` data-shortcut="${escapeAttr(id)}"${fixed ? ` data-fixed="${escapeAttr(fixed)}"` : ""}` : "";
  return `<div class="keys-row"${attrs}><span class="keys-label" data-i18n="${i18nKey}">${escapeHtml(label)}</span>`
    + `<span class="keys-keys">${keyChips(combo)}</span></div>`;
}

function enLabel(key: string): string {
  const text = (MESSAGES.en as Record<string, string>)[key];
  if (!text) throw new Error(`shortcut sheet: no English string for "${key}"`);
  return text;
}

function shortcutSheetHtml(): string {
  return SHORTCUT_GROUPS.map((group) => {
    const rows = group.ids.map((id) => {
      const def = SHORTCUTS.find((s) => s.id === id);
      if (!def) throw new Error(`shortcut group "${group.i18n}" references unknown id "${id}"`);
      return shortcutRow(def.keys.join(" / "), def.i18n, enLabel(def.i18n), def.id, def.fixed ?? "");
    }).join("");
    return `<div class="keys-cat" data-i18n="${group.i18n}">${escapeHtml(enLabel(group.i18n))}</div>`
      + `<div class="keys-grid">${rows}</div>`;
  }).join("");
}

export function renderWelcomeHtml(
  light = false,
  recent: { path: string; name: string }[] = [],
  t: Translate = makeTranslator("en"),
  locale = "en",
): string {
  const bg = light ? "#ffffff" : "#2b2b2b";
  const fg = light ? "#1f2328" : "#a9b7c6";
  const brandMark = kakapoIconHtml("brand-mark", "Kakapo");
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
    `body { margin: 0; min-height: 100vh; display: flex; padding: 40px 24px 24px; overflow: auto; background: ${bg}; color: ${fg}; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }`,
    ".card { width: 520px; max-width: 100%; padding: 40px; margin: auto; text-align: center; }",
    ".brand-mark { display: inline-block; width: 48px; height: 48px; background: var(--kakapo-ui-icon) center/contain no-repeat; }",
    ".card h1 { font-size: 24px; margin: 12px 0 14px; color: #4a88c7; }",
    ".card p { font-size: 14px; line-height: 1.7; margin: 10px 0; }",
    ".open-btn { margin-top: 22px; padding: 10px 24px; font-size: 14px; font-weight: 600; color: #fff; background: #4a88c7; border: 0; border-radius: 8px; cursor: pointer; }",
    ".open-btn:hover { background: #3f78b3; }",
    ".open-btn:disabled { opacity: 0.6; cursor: default; }",
    ".hint { color: #d36c6c; font-size: 12px; min-height: 16px; margin-top: 16px; }",
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
    `    if (r && r.error === 'unopenable') hint.textContent = ${jsonForScript(t("welcome.unopenable"))};`,
    "  }).catch(function () { btn.disabled = false; });",
    "});",
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

export function shouldLazyRender(fileCount: number, totalLines: number): boolean {
  return fileCount > 60 || totalLines > 4000;
}

function diffWrapperOpenTag(index: number, file: DiffFile | undefined, firstHunk: number, hunkCount: number): string {
  const path = file ? file.displayPath : "";
  return `<div id="file-${index}" class="d2h-file-wrapper" data-path="${escapeAttr(path)}"`
    + ` data-first-hunk="${firstHunk}" data-hunk-count="${hunkCount}"`;
}

export function annotateDiffWrappers(diffHtml: string, files: DiffFile[]): string {
  const parts = diffHtml.split(/(?=<div [^>]*class="d2h-file-wrapper")/);
  let hunkIndex = 0;
  let fileIndex = 0;
  return parts
    .map((part) => {
      if (!part.includes('class="d2h-file-wrapper"')) return part;
      const file = files[fileIndex];
      const firstHunk = hunkIndex;
      const hunkCount = file ? file.hunks.length : 0;
      hunkIndex += hunkCount;
      const tag = diffWrapperOpenTag(fileIndex, file, firstHunk, hunkCount);
      fileIndex += 1;
      return part.replace(/<div id="[^"]*" class="d2h-file-wrapper"/, tag);
    })
    .join("");
}

export function splitDiffForLazy(diffHtml: string, files: DiffFile[]): { container: string; islands: string; bodies: string[] } {
  const parts = diffHtml.split(/(?=<div [^>]*class="d2h-file-wrapper")/).filter((p) => p.includes('class="d2h-file-wrapper"'));
  const shells: string[] = [];
  const islands: string[] = [];
  const bodies: string[] = [];
  let hunkIndex = 0;
  parts.forEach((part, i) => {
    const file = files[i];
    const firstHunk = hunkIndex;
    const hunkCount = file ? file.hunks.length : 0;
    hunkIndex += hunkCount;
    const marker = '<div class="d2h-files-diff">';
    const open = part.indexOf(marker);
    if (open < 0) {
      shells.push(part);
      bodies.push("");
      return;
    }
    const before = part.slice(0, open);
    const after = part.slice(open + marker.length);
    const body = after.replace(/<\/div>\s*<\/div>\s*$/, "");
    const shell =
      before.replace(
        /<div id="[^"]*" class="d2h-file-wrapper"/,
        diffWrapperOpenTag(i, file, firstHunk, hunkCount),
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

function compareRefLabel(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
const COMPARE_NAMES: Record<CompareState["mode"], string> = {
  local: "Local changes",
  staged: "Staged",
  ahead: "Unpushed",
  incoming: "Incoming",
  manual: "Comparing",
};
function compareRightSide(state: CompareState): string {
  if (state.mode === "local") return '<span class="compare-ref" data-i18n="compare.worktree">Working tree</span>';
  if (state.mode === "staged") return '<span class="compare-ref" data-i18n="compare.index">Index</span>';
  const right = state.right || "";
  if (!right) return '<span class="compare-ref" data-i18n="compare.worktree">Working tree</span>';
  return `<span class="compare-ref">${escapeHtml(compareRefLabel(right))}</span>`;
}

function branchChip(branch?: string): string {
  return `<span class="brand-branch${branch ? "" : " hidden"}" data-i18n-title="rail.branch" title="Current branch">`
    + `${BRANCH_ICON}<span class="brand-branch-name" title="${escapeAttr(branch || "")}">${escapeHtml(branch || "")}</span></span>`;
}
const BRANCH_ICON = '<svg class="brand-branch-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="8.5" r="2.2"/><path d="M6.5 8.2v7.6"/><path d="M17.5 10.7c0 3.2-2.2 4.4-5.5 4.9"/></svg>';

export function renderReviewStatus(input: { compare?: CompareState; app?: boolean }): string {
  const state = input.compare;
  if (!state) return "";
  const count = typeof state.count === "number" && state.count > 0
    ? `<span class="compare-count">${state.count}</span>`
    : "";
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

export function renderCompareBanner(state: CompareState | undefined): string {
  if (!state || state.mode !== "incoming") return "";
  return [
    '<span class="compare-why-mark" aria-hidden="true">↓</span>',
    '<span class="compare-why-text" data-i18n="compare.incoming.why">',
    "Nothing local to review — showing what the remote is ahead by.",
    "</span>",
    '<button type="button" id="compare-open-history" class="compare-why-link"' + keyHint('openHistory') + '',
    ' data-i18n="compare.openHistory">History</button>',
  ].join("");
}

const SWITCH_ICONS: Record<string, string> = {
  changes: '<rect x="1.75" y="2.75" width="5" height="10.5" rx="1"/><rect x="9.25" y="2.75" width="5" height="10.5" rx="1"/>',
  files: '<path d="M3 2.5v8.5a1 1 0 0 0 1 1h2"/><path d="M3 6.5h3"/><path d="M8 4.5h5M8 8.5h5M8 12.5h5"/>',
};
function sidebarSwitch(active: string): string {
  const item = (id: string, label: string, hint: string): string => [
    `<button type="button" class="sidebar-switch-item${id === active ? " active" : ""}" data-tab="${id}"`,
    ` role="tab" aria-selected="${id === active ? "true" : "false"}" aria-controls="${id}-panel"`,
    ` data-i18n-title="tab.${id}.title" data-i18n-aria="tab.${id}" title="${escapeAttr(label)} (${hint})" aria-label="${escapeAttr(label)}">`,
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"',
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SWITCH_ICONS[id]}</svg>`,
    "</button>",
  ].join("");
  return '<div class="sidebar-switch" role="tablist" data-i18n-aria="sidebar.switch" aria-label="Sidebar tree">'
    + item("changes", "Changes", "⌘2") + item("files", "All files", "⌘1") + "</div>";
}

export function renderDiffHtml(input: {
  files: DiffFile[];
  collisions?: Map<string, "conflict" | "diverged">;
  diffHtml: string;
  diffIslands?: string;
  lazy?: boolean;
  lazyLoad?: boolean;
  sourceFiles: SourceFile[];
  fileStates: ReviewFileState[];
  httpEnvironments: Record<string, Record<string, string>>;
  projectLayout?: ProjectLayout;
  title: string;
  subtitle: string;
  projectName: string;
  projectPath: string;
  branch?: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  app?: boolean;
  compare?: CompareState;
  openPath?: string;
  signature?: string;
  generatedAt?: string;
}): string {
  const fileNav = renderDiffTree(input.files, input.collisions, input.projectLayout?.modules ?? []);
  const sourceNav = input.lazyLoad ? "" : renderSourceTree(input.sourceFiles, input.projectLayout?.modules ?? []);
  const initialSourceFiles = input.lazyLoad
    ? initialReviewSources(input.files, input.sourceFiles, input.openPath)
    : input.sourceFiles;
  const initialSourcePaths = new Set(initialSourceFiles.map((file) => file.path));
  const initialFileStates = input.lazyLoad
    ? input.fileStates.filter((file) => initialSourcePaths.has(file.path))
    : input.fileStates;
  const brandMark = kakapoIconHtml("kakapo-mark");
  const analysisStatus = input.app
    ? `<span id="analysis-status" class="analysis-status is-idle" role="status" aria-live="polite" data-phase="idle" data-generation="0" title="Code analysis has not started"><span class="analysis-status-dot" aria-hidden="true"></span><span class="analysis-status-label">Analysis idle</span></span>`
    : `<span class="app-version" id="app-version" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}${packageVersion ? '<span class="app-version-text">v' + escapeHtml(packageVersion) + "</span>" : ""}</span>`;
  const settingsButton = '<button type="button" id="app-info-btn" class="brand-reveal brand-settings" aria-haspopup="dialog" data-i18n-aria="settings.title" aria-label="Settings" ' + keyHint('openSettings') + ' data-i18n-title="settings.title" title="Settings"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 3.2h4.6l.5 2.1c.6.2 1.1.5 1.6.9l2-.7 2.3 4-1.6 1.4a7 7 0 0 1 0 2.2l1.6 1.4-2.3 4-2-.7c-.5.4-1 .7-1.6.9l-.5 2.1H9.7l-.5-2.1c-.6-.2-1.1-.5-1.6-.9l-2 .7-2.3-4 1.6-1.4a7 7 0 0 1 0-2.2L3.3 9.5l2.3-4 2 .7c.5-.4 1-.7 1.6-.9z"/><circle cx="12" cy="12" r="3"/></svg></button>';
  const revealButton = '<button type="button" class="brand-reveal" id="brand-reveal"' + keyHint('revealInTree') + ' data-i18n-title="brand.revealFile" title="Reveal open file in the sidebar" data-i18n-aria="brand.revealFile" aria-label="Reveal open file in the sidebar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.4"/><path d="M12 3v3.2"/><path d="M12 17.8V21"/><path d="M3 12h3.2"/><path d="M17.8 12H21"/></svg></button>';
  const brandLoader = `<span class="kakapo-loader kakapo-loader-boot" role="status" data-i18n-aria="app.loading" aria-label="Kakapo is loading">${brandMark}</span>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(input.projectName)}${input.title.endsWith("(dev)") ? " (dev)" : ""}</title>`,
    "<style>",
    `:root { ${kakapoIconCssVariable()}; }`,
    diff2HtmlCss(),
    diffCss(),

    "</style>",
    "</head>",
    "<body>",
    `<div id="boot-overlay">${brandLoader}</div>`,
    '<aside class="sidebar" data-i18n-aria="a11y.reviewNav" aria-label="Review navigation">',
    `<div class="sidebar-brand" title="${escapeAttr(input.projectPath)}"><span class="brand-project">${escapeHtml(input.projectName)}</span>${sidebarSwitch(input.lazy ? "changes" : "files")}</div>`,
    '<div class="sidebar-scroll">',
    `<div class="tab-panel${input.lazy ? "" : " hidden"}" id="changes-panel">${fileNav}</div>`,
    input.lazy
      ? input.lazyLoad
        ? '<div class="tab-panel hidden" id="files-panel" data-project-index="deferred"></div>'
        : `<div class="tab-panel hidden" id="files-panel"></div><script type="text/html" id="files-tree-html">${sourceNav}</script>`
      : `<div class="tab-panel" id="files-panel">${sourceNav}</div>`,
    '<div id="archive-panel" class="archive-panel hidden" data-i18n-aria="a11y.archivedReviews" aria-label="Archived reviews"></div>',
    "</div>",
    "",
    `<div class="sidebar-tools">${analysisStatus}<span class="sidebar-tools-spacer"></span>${settingsButton}${revealButton}</div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden" data-i18n-aria="region.diff" aria-label="Diff">',
    '<div class="toolbar diff-toolbar" role="group" data-i18n-aria="region.diffToolbar" aria-label="Diff actions">',
    '<div class="diff-toolbar-file">'
      + '<div class="diff-commit-context hidden" id="diff-commit-context"></div>'
      + '<span class="diff-file-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3.5 1.75h5l4 4v8.5h-9z"/><path d="M8.5 1.75v4h4"/></svg></span>'
      + '<div class="breadcrumb" id="diff-breadcrumb"></div>'
      + branchChip(input.branch)
      + '</div>',
    '<div class="diff-toolbar-meta">',
    `<div class="review-status">${renderReviewStatus({ compare: input.compare, app: input.app })}</div>`,
    input.app
      ? '<div id="compare-menu" class="compare-menu hidden" role="menu" data-i18n-aria="compare.menu.aria" aria-label="Compare options">'
        + '<div class="compare-menu-main" role="group">'
        + '<button type="button" class="compare-menu-row compare-menu-since hidden" role="menuitemradio" aria-checked="false" data-mode="since">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.since">Since you last read</span>'
        + '<span class="compare-menu-note" id="compare-menu-since-note"></span>'
        + '<kbd class="compare-menu-key">\u2325N</kbd>'
        + '<span class="compare-menu-check" aria-hidden="true"></span>'
        + '</button>'
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
        + '<button type="button" class="compare-menu-row" role="menuitemradio" aria-checked="false" data-mode="tip">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.tip">vs branch tip</span>'
        + '<kbd class="compare-menu-key">\u2325T</kbd>'
        + '<span class="compare-menu-check" aria-hidden="true"></span>'
        + '</button>'
        + '<div class="compare-menu-sep" role="separator"></div>'
        + '<button type="button" class="compare-menu-row compare-menu-branch-open" data-panel="branches" aria-haspopup="listbox" aria-expanded="false">'
        + '<span class="compare-menu-label" data-i18n="compare.menu.target">Compare against</span>'
        + '<span class="compare-menu-note" id="compare-menu-ref"></span>'
        + '<kbd class="compare-menu-key">\u2325C</kbd>'
        + '<span class="compare-menu-chevron" aria-hidden="true">\u203a</span>'
        + '</button>'
        + '</div>'
        + '<div id="compare-menu-branches" class="compare-menu-branches hidden" role="group" data-i18n-aria="compare.menu.target" aria-label="Compare against">'
        + '<input id="compare-branch-search" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="compare.menu.searchBranch" placeholder="Search branches">'
        + '<div id="compare-branch-list" class="compare-branch-list" role="listbox" data-i18n-aria="compare.menu.target" aria-label="Compare against"></div>'
        + '</div>'
        + '</div>'
      : '',
    '<button type="button" id="diff-line-wrap-toggle" class="diff-tool-button source-line-wrap-toggle diff-line-wrap-toggle" role="checkbox" aria-checked="false"' + keyHint('toggleLineWrap') + ' data-i18n-title="source.lineWrap.title" data-i18n-aria="source.lineWrap" title="Toggle line wrap" aria-label="Line wrap"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.75h12"/><path d="M2 8h9a2.5 2.5 0 0 1 0 5H6"/><path d="m7.75 11.25-2 1.75 2 1.75"/></svg></button>',
    '</div>',
    '<div class="diff-review-controls" role="group" data-i18n-aria="diff.navigation" aria-label="Change navigation">',
    '<button type="button" id="diff-sidebar-toggle" class="diff-tool-button"' + keyHint('filesChangesTab:1') + ' data-tooltip="Hide changed files" aria-pressed="false" data-i18n-title="diff.hideSidebar" data-i18n-aria="diff.hideSidebar" title="Hide changed files" aria-label="Hide changed files"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.25"/><path d="M5.25 2.5v11"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-prev-change" class="diff-tool-button"' + keyHint('prevChange') + ' data-i18n-title="diff.previous" data-i18n-aria="diff.previous" title="Previous change" aria-label="Previous change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button>',
    '<button type="button" id="diff-next-change" class="diff-tool-button"' + keyHint('nextChange') + ' data-i18n-title="diff.next" data-i18n-aria="diff.next" title="Next change" aria-label="Next change"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>',
    '<button type="button" id="diff-prev-file" class="diff-tool-button"' + keyHint('diffFileStep:1') + ' data-i18n-title="diff.previousFile" data-i18n-aria="diff.previousFile" title="Previous file" aria-label="Previous file"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 8.5 4-4 4 4"/><path d="M4 12h8"/></svg></button>',
    '<button type="button" id="diff-next-file" class="diff-tool-button"' + keyHint('diffFileStep') + ' data-i18n-title="diff.nextFile" data-i18n-aria="diff.nextFile" title="Next file" aria-label="Next file"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h8"/><path d="m4 7.5 4 4 4-4"/></svg></button>',
    '<span class="diff-tool-separator" aria-hidden="true"></span>',
    '<button type="button" id="diff-open-source" class="diff-tool-button"' + keyHint('goToDef') + ' data-i18n-title="diff.openSource" data-i18n-aria="diff.openSource" title="Open source" aria-label="Open source"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h4l1.5 2h5.5v9h-11z"/><path d="m6 10 2 2 2-2M8 7v5"/></svg></button>',
    '</div>',
    "</div>",
    `<div class="compare-why" id="compare-why">${renderCompareBanner(input.compare)}</div>`,
    input.app
      ? '<div class="patchset-bar" id="patchset-bar" role="group" data-i18n-aria="patchset.bar" aria-label="Compare patch sets">'
        + '<button type="button" class="patchset-name" id="patchset-ledger-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="patchset-ledger" data-i18n="patchset.name" data-i18n-title="patchset.ledgerOpen" title="What each patch set did">Patch sets</button>'
        + '<div class="patchset-ledger hidden" id="patchset-ledger" role="listbox" data-i18n-aria="patchset.ledger" aria-label="Patch sets"></div>'
        + '<div class="patchset-side patchset-side-base">'
        + '<span class="patchset-kind" data-i18n="patchset.base">Base</span>'
        + '<div class="patchset-nums" id="patchset-base-nums" role="group" data-i18n-aria="patchset.pick" aria-label="Base patch set"></div>'
        + '</div>'
        + '<div class="patchset-summary" id="patchset-summary" aria-live="polite"></div>'
        + '<div class="patchset-side patchset-side-target">'
        + '<div class="patchset-nums" id="patchset-target-nums" role="group" data-i18n-aria="patchset.pickTarget" aria-label="Target patch set"></div>'
        + '<span class="patchset-kind" data-i18n="patchset.target">Target</span>'
        + '<button type="button" id="patchset-reset" class="patchset-reset hidden" data-i18n-title="patchset.exitCompare" title="Exit compare (back to working tree)" data-i18n-aria="patchset.exitCompare" aria-label="Exit compare"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>'
        + '</div>'
        + '</div>'
      : '',
    '<div class="diff-pane-header" data-i18n-aria="diff.panes" aria-label="Diff panes">',
    '<div class="diff-pane diff-pane-base"><span class="diff-pane-kind" data-i18n="diff.base">Base</span><span id="diff-before-path" class="diff-pane-path"></span></div>',
    '<div class="diff-pane diff-pane-working"><span id="diff-after-kind" class="diff-pane-kind" data-i18n="diff.workingTree">Working tree</span><span id="diff-after-path" class="diff-pane-path"></span></div>',
    '</div>',
    `<div id="diff2html-container" class="diff2html-container">${input.diffHtml || '<div class="empty"><p class="empty-title" data-i18n="diff.noDiff">No diff to review.</p><p class="empty-hint" data-i18n="diff.noDiff.hint">If this is not what you meant to review, change it with the compare control in the toolbar.</p></div>'}</div>`,
    "</section>",
    '<section id="source-viewer" class="source-viewer" data-i18n-aria="region.source" aria-label="Source file">',
    '<div id="source-tabs" class="source-tabs hidden" role="tablist"></div>',
    '<div class="toolbar source-toolbar" role="group" data-i18n-aria="region.sourceToolbar" aria-label="Source actions">',
    '<div class="source-file-meta">'
      + '<div class="diff-commit-context hidden" id="source-commit-context"></div>'
      + '<span id="source-type-icon" class="source-type-icon" aria-hidden="true"></span>'
      + '<span id="source-title" data-i18n="source.title">Source</span>'
      + '<span id="source-meta" data-i18n="source.selectFile">Select a file from the Files tab.</span>'
      + branchChip(input.branch)
      + '</div>',
    '<select id="http-env-select" class="http-env-select hidden" data-i18n-title="http.env.title" data-i18n-aria="http.env.aria" title="HTTP Client environment" aria-label="HTTP environment"></select>',
    '<button type="button" id="render-toggle" class="plain-button hidden"' + keyHint('toggleRendered') + ' data-i18n-title="btn.renderToggle" title="Rendered / raw Markdown or CSV">Raw</button>',
    '<button type="button" id="line-wrap-toggle" class="diff-tool-button source-line-wrap-toggle hidden" role="checkbox" aria-checked="false"' + keyHint('toggleLineWrap') + ' data-i18n-title="source.lineWrap.title" data-i18n-aria="source.lineWrap" title="Toggle line wrap" aria-label="Line wrap"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.75h12"/><path d="M2 8h9a2.5 2.5 0 0 1 0 5H6"/><path d="m7.75 11.25-2 1.75 2 1.75"/></svg></button>',
    '<button type="button" id="back-to-diff" class="plain-button"' + keyHint('nextChange') + ' data-i18n="btn.diff" data-i18n-title="btn.diff.title" title="Back to diff">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty" data-i18n="source.selectFile">Select a file from the Files tab.</div>',
    "</section>",
    '<div id="file-find" class="file-find hidden" role="search" data-i18n-aria="find.aria" aria-label="Find in current file">',
    '<input id="file-find-input" class="file-find-input" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="find.placeholder" placeholder="Find in current file">',
    '<span id="file-find-count" class="file-find-count" aria-live="polite">0/0</span>',
    '<span class="file-find-options">',
    '<button type="button" id="file-find-match-case" class="file-find-option" aria-pressed="false"' + keyHint('searchMatchCase') + ' data-i18n-title="quickopen.matchCase" data-i18n-aria="quickopen.matchCase" title="Match case" aria-label="Match case"><span aria-hidden="true">Cc</span></button>',
    '<button type="button" id="file-find-whole-words" class="file-find-option" aria-pressed="false"' + keyHint('searchWholeWords') + ' data-i18n-title="quickopen.wholeWords" data-i18n-aria="quickopen.wholeWords" title="Whole words" aria-label="Whole words"><span aria-hidden="true">W</span></button>',
    '<button type="button" id="file-find-regex" class="file-find-option" aria-pressed="false"' + keyHint('searchRegex') + ' data-i18n-title="quickopen.regex" data-i18n-aria="quickopen.regex" title="Regular expression" aria-label="Regular expression"><span aria-hidden="true">.*</span></button>',
    '<button type="button" id="file-find-in-selection" class="file-find-option" aria-pressed="false"' + keyHint('findInSelection') + ' data-i18n-title="find.inSelection" data-i18n-aria="find.inSelection" title="Search in selection" aria-label="Search in selection"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true"><path d="M4 2.5H2.5v11H4"/><path d="M12 2.5h1.5v11H12"/><path d="M6 8h4"/></svg></button>',
    '<button type="button" id="file-find-changes-only" class="file-find-option" aria-pressed="false"' + keyHint('searchChangesOnly') + ' data-i18n-title="find.changesOnly" data-i18n-aria="find.changesOnly" title="Search in changes" aria-label="Search in changes"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h4"/><path d="M5 2.5v4"/><path d="M9 11.5h4"/><path d="M2.5 13.5 13.5 2.5"/></svg></button>',
    '</span>',
    '<button type="button" id="file-find-prev" class="file-find-button" data-keyhint-id="findEnter:1" data-i18n-title="find.previous" data-i18n-aria="find.previous" title="Previous match" aria-label="Previous match">&#8593;</button>',
    '<button type="button" id="file-find-next" class="file-find-button" data-keyhint-id="findEnter" data-i18n-title="find.next" data-i18n-aria="find.next" title="Next match (Enter)" aria-label="Next match">&#8595;</button>',
    '<button type="button" id="file-find-close" class="file-find-button file-find-close" data-keyhint-id="closeDialog" data-i18n-title="find.close" data-i18n-aria="find.close" title="Close (Esc)" aria-label="Close">&times;</button>',
    '</div>',
    "</main>",
    input.app
      ? '<aside id="semantic-peek" class="semantic-peek hidden" data-i18n-aria="peek.aria" aria-label="Semantic Peek">'
        + '<div class="semantic-peek-header"><div class="semantic-peek-heading"><div id="semantic-peek-title" class="semantic-peek-title">Semantic Peek</div><div id="semantic-peek-meta" class="semantic-peek-meta"></div></div>'
        + '</div><div id="semantic-peek-results" class="semantic-peek-results" role="listbox" tabindex="0" data-i18n-aria="peek.list" aria-label="Semantic locations"></div>'
        + '</aside>'
        + '<aside id="quick-doc" class="quick-doc hidden" role="dialog" data-i18n-aria="quickdoc.aria" aria-label="Quick documentation">'
        + '<div class="quick-doc-head"><span id="quick-doc-title" class="quick-doc-title"></span><span id="quick-doc-meta" class="quick-doc-meta"></span></div>'
        + '<div id="quick-doc-body" class="quick-doc-body" tabindex="0"></div>'
        + '</aside>'
      : "",
    '<div id="quick-open" class="quick-open hidden" role="dialog" aria-modal="true" data-i18n-aria="quickopen.aria" aria-label="Quick open">',
    '<div class="quick-open-panel">',
    '<nav id="quick-open-side" class="quick-open-side" data-i18n-aria="a11y.quickOpenSections" aria-label="Sections">',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="everywhere"' + keyHint('searchEverywhere') + '><span data-i18n="quickopen.everywhere">All</span></button>',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="classes"' + keyHint('goToClass') + '><span data-i18n="quickopen.tabClasses">Classes</span></button>',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="all"' + keyHint('searchFiles') + '><span data-i18n="quickopen.tabFiles">Files</span></button>',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="symbol"' + keyHint('workspaceSymbol') + '><span data-i18n="quickopen.tabSymbols">Symbols</span></button>',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="actions"' + keyHint('findAction') + '><span data-i18n="quickopen.tabActions">Actions</span></button>',
    '<button type="button" class="quick-open-side-item" data-se-tab data-section="content"' + keyHint('findInFiles') + '><span data-i18n="quickopen.tabText">Text</span></button>',
    '<div class="quick-open-side-sep" aria-hidden="true"></div>',
    '<button type="button" class="quick-open-side-item" data-section="recent"' + keyHint('recentFiles') + '><span data-i18n="quickopen.recent">Recent files</span></button>',
    '<button type="button" class="quick-open-side-item" data-section="history"' + keyHint('openHistory') + '><span data-i18n="rail.history">History</span></button>',
    '</nav>',
    '<div class="quick-open-title"><span id="quick-open-mode">Search files</span><span id="quick-open-filter" class="quick-open-filter"></span></div>',
    '<input id="quick-open-input" type="search" autocomplete="off" spellcheck="false" aria-labelledby="quick-open-mode">',
    '<div id="quick-open-search-options" class="quick-open-search-options">',
    '<label class="quick-open-extension-field" for="quick-open-extensions"><span data-i18n="quickopen.fileMask">File mask</span><input id="quick-open-extensions" type="text" autocomplete="off" spellcheck="false" data-i18n-ph="quickopen.fileMaskPlaceholder" placeholder="All · *.ts, !*.d.ts"' + keyHint('searchExtensions') + ' data-i18n-title="quickopen.fileMask" title="File mask"></label>',
    '<button type="button" id="quick-open-exclude-noise" class="quick-open-option-toggle" aria-pressed="false"' + keyHint('excludeSearchNoise') + '><span class="quick-open-option-check" aria-hidden="true"></span><span data-i18n="quickopen.excludeNoise">Exclude comments &amp; tests</span></button>',
    '<label class="quick-open-scope-field" for="quick-open-scope"><span data-i18n="quickopen.scope">Scope</span>'
      + '<select id="quick-open-scope"' + keyHint('searchScope') + '></select></label>',
    '<span class="quick-open-option-glyphs">',
    '<button type="button" id="quick-open-match-case" class="quick-open-option-glyph" aria-pressed="false"' + keyHint('searchMatchCase') + ' data-i18n-title="quickopen.matchCase" data-i18n-aria="quickopen.matchCase" title="Match case" aria-label="Match case"><span aria-hidden="true">Cc</span></button>',
    '<button type="button" id="quick-open-whole-words" class="quick-open-option-glyph" aria-pressed="false"' + keyHint('searchWholeWords') + ' data-i18n-title="quickopen.wholeWords" data-i18n-aria="quickopen.wholeWords" title="Whole words" aria-label="Whole words"><span aria-hidden="true">W</span></button>',
    '<button type="button" id="quick-open-regex" class="quick-open-option-glyph" aria-pressed="false"' + keyHint('searchRegex') + ' data-i18n-title="quickopen.regex" data-i18n-aria="quickopen.regex" title="Regular expression" aria-label="Regular expression"><span aria-hidden="true">.*</span></button>',
    '</span>',
    '<span id="quick-open-usage-options" class="quick-open-usage-options">',
    '<button type="button" class="quick-open-usage-icon" data-usage-tree="expand" data-i18n-title="usagegroup.expandAll" data-i18n-aria="usagegroup.expandAll" title="Expand all" aria-label="Expand all"><span aria-hidden="true">▾</span></button>',
    '<button type="button" class="quick-open-usage-icon" data-usage-tree="collapse" data-i18n-title="usagegroup.collapseAll" data-i18n-aria="usagegroup.collapseAll" title="Collapse all" aria-label="Collapse all"><span aria-hidden="true">▸</span></button>',
    '<span class="quick-open-usage-label" data-i18n="usagegroup.title">Group by</span>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="scope" aria-pressed="false"' + keyHint('usageGroupScope') + ' data-i18n="usagegroup.by.scope">Production/Test</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="type" aria-pressed="false"' + keyHint('usageGroupType') + ' data-i18n="usagegroup.by.type">Usage type</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="module" aria-pressed="false"' + keyHint('usageGroupModule') + ' data-i18n="usagegroup.by.module">Module</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="flatten" aria-pressed="false"' + keyHint('usageFlattenModules') + ' data-i18n="usagegroup.by.flatten">Flatten</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="directory" aria-pressed="false"' + keyHint('usageGroupDirectory') + ' data-i18n="usagegroup.by.directory">Directory</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="file" aria-pressed="false"' + keyHint('usageGroupFile') + ' data-i18n="usagegroup.by.file">File</button>',
    '<span class="quick-open-usage-label" data-i18n="usagefilter.title">Show</span>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="read" aria-pressed="true"' + keyHint('usageFilterRead') + ' data-i18n="usagefilter.read">Read</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="write" aria-pressed="true"' + keyHint('usageFilterWrite') + ' data-i18n="usagefilter.write">Write</button>',
    '<button type="button" class="quick-open-usage-chip" data-usage-toggle="imports" aria-pressed="true"' + keyHint('usageFilterImports') + ' data-i18n="usagefilter.imports">Imports</button>',
    '</span>',
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
    '<button type="button" id="settings-close" class="settings-close" data-keyhint-id="closeDialog" data-i18n-aria="settings.close" aria-label="Close settings" data-i18n-title="settings.closeTitle" title="Close">×</button>',
    '<aside class="settings-nav">',
    `<div class="settings-nav-brand" aria-label="Kakapo${packageVersion ? " v" + escapeAttr(packageVersion) : ""}">${brandMark}<div class="settings-nav-brand-meta"><span class="settings-nav-brand-name">Kakapo</span><span class="settings-ver">${packageVersion ? "v" + escapeHtml(packageVersion) : ""}</span></div></div>`,
    '<div class="settings-nav-title" data-i18n="settings.title">Settings</div>',
    '<button type="button" class="settings-cat active" data-cat="general" data-i18n="settings.cat.general">General</button>',
    '<button type="button" class="settings-cat" data-cat="shortcuts" data-i18n="settings.cat.shortcuts">Shortcuts</button>',
    '</aside>',
    '<div class="settings-body">',
    '<section class="settings-section" data-cat="general">',
    '<div class="settings-card">',
    '<div class="settings-card-title" data-i18n="settings.update">Update</div>',
    '<div class="settings-row">',
    `<div class="settings-row-text"><span class="settings-row-label">Kakapo${packageVersion ? " v" + escapeHtml(packageVersion) : ""}</span>`,
    `<span id="app-info-status" class="settings-row-hint app-info-status is-loading"><span class="kakapo-loader kakapo-loader-micro" aria-hidden="true">${brandMark}</span><span data-i18n="settings.checkingUpdates">Checking for updates…</span></span></div>`,
    '<button type="button" id="app-info-update" class="plain-button app-info-update hidden" data-i18n="settings.updateRestart">Update &amp; Restart</button>',
    '</div>',
    '</div>',
    '<div class="settings-card">',
    '<div class="settings-card-title" data-i18n="settings.appearance">Appearance</div>',
    '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.language">Language</span></div><button type="button" id="settings-language" class="settings-select mc-select" data-i18n-aria="settings.language"></button></div>',
    '<div class="settings-row settings-row-stacked"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.theme">Theme</span></div>',
    '<div id="settings-theme-grid" class="theme-grid" role="radiogroup" data-i18n-aria="settings.theme"></div></div>',
    '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.uiScale">Font size</span><span class="settings-row-hint" data-i18n="settings.uiScale.hint">Scales the whole interface.</span></div><button type="button" id="settings-ui-scale" class="settings-select mc-select" data-i18n-aria="settings.uiScale"></button></div>',
    '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-label" data-i18n="settings.diffHighlight">Changed lines</span><span class="settings-row-hint" data-i18n="settings.diffHighlight.hint">How much of a changed line is coloured.</span></div><button type="button" id="settings-diff-highlight" class="settings-select mc-select" data-i18n-aria="settings.diffHighlight"></button></div>',
    '</div>',
    '</section>',
    '<section class="settings-section hidden" data-cat="shortcuts">',
    '<div class="app-info-keys">' +
    '<div class="app-info-keys-h" data-i18n="settings.kbd.title">Keyboard shortcuts</div>' +
    shortcutSheetHtml() +
    '</div>',
    "</section>",
    '</div>',
    '</div>',
    '</div>',
    '<div id="history-view" class="history-view hidden" role="dialog" aria-modal="true" data-i18n-aria="history.title" aria-label="Git history">',
    '<div class="history-bar">',
    '<span class="history-title" data-i18n="history.title">History</span>',
    '<span id="history-scope" class="history-scope hidden"></span>',
    '<input id="history-search" type="search" class="history-search" autocomplete="off" spellcheck="false" data-i18n-ph="history.search" data-i18n-aria="history.search" aria-label="Filter by message, or type a hash to go to it" placeholder="Filter by message, or a hash to go to">',
    '<button type="button" id="history-filter-toggle" class="dock-btn" aria-expanded="false" aria-controls="history-filters" data-i18n-title="history.filters" title="More filters" data-i18n-aria="history.filters" aria-label="More filters">&#9662;</button>',
    '<button type="button" id="history-close" class="dock-btn" data-keyhint-id="closeDialog" data-i18n-title="history.close" title="Close" data-i18n-aria="history.close" aria-label="Close">&times;</button>',
    "</div>",
    '<div class="history-kinds" role="tablist" data-i18n-aria="history.kinds" aria-label="History kind">',
    '<button type="button" class="history-kind active" data-history-kind="commits" role="tab" aria-selected="true" data-i18n="history.kind.commits">Commits</button>',
    '<button type="button" class="history-kind" data-history-kind="reflog" role="tab" aria-selected="false" data-i18n="history.kind.reflog">Reflog</button>',
    '<button type="button" class="history-kind" data-history-kind="stashes" role="tab" aria-selected="false" data-i18n="history.kind.stashes">Stashes</button>',
    "</div>",
    '<div id="history-filters" class="history-filters hidden">',
    '<input id="history-filter-author" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="history.filter.author" data-i18n-aria="history.filter.author" aria-label="Author" placeholder="Author">',
    '<input id="history-filter-path" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="history.filter.path" data-i18n-aria="history.filter.path" aria-label="Path" placeholder="Path">',
    '<input id="history-filter-branch" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="history.filter.branch" data-i18n-aria="history.filter.branch" aria-label="Branch, tag or revision" placeholder="Branch">',
    '<input id="history-filter-content" type="search" autocomplete="off" spellcheck="false" data-i18n-ph="history.filter.content" data-i18n-aria="history.filter.content" aria-label="Changed code" placeholder="Changed code">',
    '<input id="history-filter-since" type="date" data-i18n-aria="history.filter.since" aria-label="From date">',
    '<input id="history-filter-until" type="date" data-i18n-aria="history.filter.until" aria-label="To date">',
    '<label class="history-filter-check"><input id="history-filter-current" type="checkbox"><span data-i18n="history.filter.currentBranch">Current branch</span></label>',
    '<button type="button" id="history-filter-clear" class="history-filter-clear" data-i18n="history.filter.clear">Clear</button>',
    "</div>",
    '<div id="history-select-bar" class="history-select-bar hidden" aria-live="polite"></div>',
    '<div class="history-body">',
    '<div id="history-list" class="history-list"></div>',
    '<div id="history-empty" class="history-empty hidden" data-i18n="history.noMatch">No commit matches that filter.</div>',
    "</div>",
    "</div>",
    input.diffIslands || "",
    `<script type="application/json" id="${REVIEW_ISLAND.meta}" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}" data-lazy="${input.lazy ? "true" : "false"}" data-lazy-load="${input.lazyLoad ? "true" : "false"}" data-open-path="${escapeAttr(input.openPath ?? "")}">{}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.i18n}">${jsonForScript(MESSAGES)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.sourceFiles}">${jsonForScript(input.lazyLoad ? initialSourceFiles.map(sourceFileMetadata) : initialSourceFiles)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.fileStates}">${jsonForScript(initialFileStates)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.httpEnv}">${jsonForScript(input.httpEnvironments)}</script>`,
    `<script type="application/json" id="${REVIEW_ISLAND.projectLayout}">${jsonForScript(input.projectLayout ?? EMPTY_PROJECT_LAYOUT)}</script>`,
    `<script>window.__KAKAPO_VERSION__=${JSON.stringify(packageVersion)};</script>`,
    input.app
      ? `<script src="kakapo-asset://app/${diffClientAsset().file}?v=${diffClientAsset().version}"></script>`
      : `<script>${diffScript()}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
