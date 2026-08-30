#!/usr/bin/env node

import { app, BrowserWindow, protocol } from "electron";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { buildDiffReview } from "../dist/cli.js";
import { hubHtml, modalOverlayHtml } from "../dist/shell-pages.js";
import { makeTranslator } from "../dist/i18n.js";
import { HUB_WIDTH, TITLEBAR_H } from "../dist/constants.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

// The app serves its client script over kakapo-asset:// instead of inlining it (assets.ts), so a demo window
// that only knows file:// loads a review whose JavaScript never runs. Same scheme, same root as app-main.ts.
protocol.registerSchemesAsPrivileged([{
  scheme: "kakapo-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);
const outputGif = resolve(repoRoot, "assets", "kakapo-core-flow.gif");
const width = 1440;
const height = 820;
const frameRate = 10;
// The app's own layout (app-main.ts): the shell page paints the title strip and the workspace rail, and the
// review + modal overlay are child views laid on top of it. The demo composites the same three surfaces at the
// same coordinates, so what the GIF shows is the window the user actually gets.
const t = makeTranslator("en");
const REVIEW_BOX = { x: HUB_WIDTH, y: TITLEBAR_H, width: width - HUB_WIDTH, height: height - TITLEBAR_H };
const MODAL_BOX = { x: 0, y: TITLEBAR_H, width, height: height - TITLEBAR_H };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeDemoFile(root, path, contents) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function createDemoRepo(workRoot) {
  const demoRepo = join(workRoot, "checkout-flow");
  mkdirSync(demoRepo, { recursive: true });

  writeDemoFile(demoRepo, "README.md", "# Checkout Flow\n\nReview automation for order changes.\n");
  writeDemoFile(
    demoRepo,
    "src/reviewQueue.ts",
    [
      "export type ReviewItem = {",
      "  id: string;",
      "  title: string;",
      "  status: \"open\" | \"archived\";",
      "  createdAt: number;",
      "  priority?: \"low\" | \"normal\" | \"high\";",
      "};",
      "",
      "export function buildReviewQueue(items: ReviewItem[]): ReviewItem[] {",
      "  return items",
      "    .filter((item) => item.status === \"open\")",
      "    .sort((a, b) => a.createdAt - b.createdAt);",
      "}",
      "",
    ].join("\n"),
  );
  writeDemoFile(
    demoRepo,
    "src/prompt.ts",
    [
      "export function nextPrompt(file: string, line: number): string {",
      "  return `Please inspect ${file}:${line}.`;",
      "}",
      "",
    ].join("\n"),
  );

  git(demoRepo, ["init", "-b", "main"]);
  git(demoRepo, ["config", "user.email", "demo@kakapo.local"]);
  git(demoRepo, ["config", "user.name", "Kakapo Demo"]);
  git(demoRepo, ["add", "."]);
  git(demoRepo, ["commit", "-m", "baseline review flow"]);

  writeDemoFile(
    demoRepo,
    "src/reviewQueue.ts",
    [
      "export type ReviewItem = {",
      "  id: string;",
      "  title: string;",
      "  status: \"open\" | \"archived\";",
      "  createdAt: number;",
      "  priority?: \"low\" | \"normal\" | \"high\";",
      "  assignee?: string;",
      "};",
      "",
      "export function buildReviewQueue(items: ReviewItem[], includeArchived = false): ReviewItem[] {",
      "  return items",
      "    .filter((item) => includeArchived || item.status === \"open\")",
      "    .map((item) => ({",
      "      ...item,",
      "      title: item.title.trim(),",
      "      assignee: item.assignee || \"ai-agent\",",
      "    }))",
      "    .sort((a, b) => String(b.priority).localeCompare(String(a.priority)));",
      "}",
      "",
    ].join("\n"),
  );
  writeDemoFile(
    demoRepo,
    "src/prompt.ts",
    [
      "export function nextPrompt(file: string, line: number, comment: string): string {",
      "  return [`Please inspect ${file}:${line}.`, comment].join(\"\\n\\n\");",
      "}",
      "",
    ].join("\n"),
  );
  writeDemoFile(
    demoRepo,
    "docs/review-notes.md",
    [
      "# AI Review Notes",
      "",
      "- Check whether archived items should be opt-in.",
      "- Preserve stable ordering for equal priorities.",
      "",
    ].join("\n"),
  );

  return demoRepo;
}

function demoBridgePrelude() {
  const terms = [
    { w: "worktree", gloss: "An isolated workspace where the agent changes the review queue.", seen: true },
    { w: "review queue", gloss: "The ordered list of open review items that an inline review checks.", seen: true, code: [{ name: "buildReviewQueue", at: "src/reviewQueue.ts:10" }] },
    { w: "stable order", gloss: "The review queue fallback that preserves createdAt when priorities match.", seen: true },
    { w: "inline review", gloss: "A comment anchored to a diff line and answered automatically.", seen: true, code: [{ name: "nextPrompt", at: "src/prompt.ts:1" }] },
    { w: "answer", gloss: "The background review agent's reply to an inline review.", seen: true },
    { w: "memo", gloss: "A worktree-scoped Markdown scratchpad for review decisions.", seen: true },
  ];
  return String.raw`<script>
window.kakapoClipboard = { write: function (text) { window.__demoClipboard = String(text || ''); } };
window.kakapoSettings = { all: { 'kakapo-theme': 'dark', 'kakapo-locale': 'en' }, set: function (key, value) { this.all[key] = value; } };
window.kakapoMenu = {};
window.kakapoTerms = {
  read: function () { return Promise.resolve({ path: '.git/kakapo/terms.jsonl', terms: ${JSON.stringify(terms)} }); },
  write: function (next) { return Promise.resolve({ ok: true, path: '.git/kakapo/terms.jsonl', terms: next }); }
};
window.kakapoMemo = {
  read: function () { return Promise.resolve({ version: 1, worktreePath: '~/kakapo/workspaces/checkout-flow/archived-opt-in', body: '', updatedAt: null }); },
  write: function (body) { window.__demoMemo = body; return Promise.resolve({ version: 1, body: body, updatedAt: new Date().toISOString() }); },
  remove: function () { window.__demoMemo = ''; return Promise.resolve({ ok: true }); }
};
window.kakapoAsk = {
  ask: function (payload) { window.__demoAsk = payload; return new Promise(function () {}); },
  onStatus: function (callback) { window.__demoAskStatus = callback; },
  onHandoff: function () {}
};
</script>`;
}

function demoStyles() {
  return String.raw`<style>
#app-update-flag { display: none !important; }
.demo-pulse {
  outline: 2px solid #ffc66d !important;
  outline-offset: 2px;
}
</style>`;
}


// The rail and the New-workspace dialog are the app's own pages (shell-pages.ts); only the IPC bridge under
// them is stubbed. Everything on screen — markup, CSS, the dialog's client script — is what ships.
function hubBridge(workspaces) {
  return `<script>
(function () {
  var handlers = {};
  var on = function (name) { return function (cb) { handlers[name] = cb; }; };
  window.__demoHub = { fire: function (name, payload) { if (handlers[name]) handlers[name](payload); } };
  window.kakapoHub = {
    requestState: function () { setTimeout(function () { window.__demoHub.fire('state', ${JSON.stringify(workspaces)}); }, 0); },
    onState: on('state'), onActivity: on('activity'), onRailState: on('railState'), onToggle: on('toggle'),
    onNew: on('new'), onToggleExpand: on('toggleExpand'), onSetExpanded: on('setExpanded'),
    onTileAction: on('tileAction'), onUpdateProgress: on('updateProgress'), onModalOpen: on('modalOpen'),
    usage: function () { return Promise.resolve({}); },
    listProjects: function () { return Promise.resolve(${JSON.stringify([{ path: "~/repos/checkout-flow", name: "checkout-flow" }])}); },
    preview: function (repo, label, worktree, slug) {
      var s = slug || 'a1b2c3';
      var name = (label || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
      return Promise.resolve({ ok: true, worktree: true, slug: s, branch: 'demo/' + name,
        path: '~/kakapo/workspaces/checkout-flow/' + name, base: 'origin/main', lastAgent: 'claude',
        refs: [{ ref: 'origin/main', remote: true }, { ref: 'main', remote: false }] });
    },
    // Left pending on purpose: the dialog shows "Creating…" until the demo resolves it, which is the beat.
    create: function () { return new Promise(function (resolve) { window.__demoFinishCreate = resolve; }); },
    chooseRepo: function () { return Promise.resolve({ ok: false }); },
    confirm: function () { return Promise.resolve({ index: 0, checked: false }); },
  };
  ['setHubExpanded','railAction','activate','activateIndex','openModal','openPath','remove','rename','resume',
   'detach','reorder','tileMenu','confirmResult','refocusReview','settings','closeModal','cancelCreate',
   'reconnectPick','forget'].forEach(function (name) { window.kakapoHub[name] = function () {}; });
})();
</script>`;
}

// One workspace before the demo creates another. Only the fields the rail actually reads.
function workspaceTiles(withNew) {
  var tiles = [{
    id: 1, path: "/Users/you/repos/checkout-flow", shortPath: "~/repos/checkout-flow", repoName: "checkout-flow",
    repoRoot: "/Users/you/repos/checkout-flow", branch: "main", kind: "main", active: !withNew,
    running: false, unread: false, busy: false, dirtyCount: 0, ahead: 0, panes: [],
  }];
  if (withNew) {
    tiles.push({
      id: 2, path: "/Users/you/kakapo/workspaces/checkout-flow/archived-opt-in",
      shortPath: "~/kakapo/workspaces/checkout-flow/archived-opt-in", repoName: "checkout-flow",
      repoRoot: "/Users/you/repos/checkout-flow", branch: "demo/archived-opt-in", kind: "worktree",
      active: true, running: true, busy: true, unread: false, dirtyCount: 3, ahead: 0, agent: "claude",
      panes: [{ id: 1, title: "claude", running: true }],
    });
  }
  return tiles;
}

function withBridge(html, bridge) {
  // These pages are `<!doctype html><meta charset>…` with no <head>: inject before the first <style>, which is
  // the earliest element on every one of them, so the bridge exists before their client script runs.
  return html.replace("<style>", bridge + "<style>");
}

function renderDemoHtml(demoRepo, workRoot) {
  const review = buildDiffReview({
    root: demoRepo,
    includeUntracked: true,
    staged: false,
    context: 4,
    title: "kakapo",
    app: true,
    lazy: false,
    lazyLoad: false,
  });
  const editorUrl = pathToFileURL(join(repoRoot, "dist", "monaco", "markdown-editor.js")).href;
  // Everything goes into <head>, never after the first `<body...>` match: the inlined stylesheet contains a
  // CSS comment mentioning `<body>`, so a tag-shaped search hits that first and the bridge lands inside CSS.
  // The head still runs before the client script at the end of the document, which is all the ordering the
  // bridge needs.
  const html = review.html
    .replace("</head>", `${demoStyles()}\n${demoBridgePrelude()}\n<script src="${editorUrl}"></script>\n</head>`);
  const htmlPath = join(workRoot, "kakapo-demo.html");
  writeFileSync(htmlPath, html);
  return htmlPath;
}

async function waitFor(win, predicate, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(`Boolean(${predicate})`);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// The demo's script, as data. Injected as real thread records (the same shape comments.jsonl holds), so the
// agent's answer is drawn by the ordinary render path — nothing here fakes UI.
const CHANGE_REQUEST = "Archived items shouldn't come back by default, and equal priorities need a stable order.";
const AGENT_ANSWER = "Done — archived rows are opt-in behind includeArchived, and the sort falls back to createdAt so equal priorities keep the order they came in.";
const MEMO = "Next pass checklist\nArchived rows stay opt-in\nStable order uses createdAt";

async function makeWindow(box, options = {}) {
  const win = new BrowserWindow({
    width: box.width, height: box.height, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: options.transparent ? "#00000000" : "#2b2b2b", transparent: !!options.transparent,
    frame: false,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on("console-message", (a, b, c) => {
    const details = a && typeof a === "object" && "message" in a ? a : { level: b, message: c, sourceId: "", lineNumber: 0 };
    if (details.level === "error" || details.level === 3) {
      console.error(`${options.label || "demo"}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  return win;
}

// The three surfaces are separate offscreen windows (they are separate WebContentsViews in the app), so the
// frame is assembled the way the app stacks them: rail+title strip underneath, review inside its box, the
// modal overlay on top. A fourth window does the stacking — Electron has no image compositor, but a page with
// three positioned <img> layers is one, and capturePage() of it is the finished frame.
async function makeCompositor() {
  const win = await makeWindow({ width, height }, { label: "compositor" });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>
     html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#1e1f22}
     img{position:absolute;display:block}
     #shell{left:0;top:0;width:${width}px;height:${height}px}
     #review{left:${REVIEW_BOX.x}px;top:${REVIEW_BOX.y}px;width:${REVIEW_BOX.width}px;height:${REVIEW_BOX.height}px}
     #modal{left:${MODAL_BOX.x}px;top:${MODAL_BOX.y}px;width:${MODAL_BOX.width}px;height:${MODAL_BOX.height}px}
     /* The dialog's own ::backdrop does not survive an offscreen transparent capture, so the dim it paints
        over the window belongs to the stack instead — same colour, same layer order. */
     #dim{position:absolute;inset:0;background:rgba(0,0,0,.45)}
     .off{display:none}
     </style><img id="shell"><img id="review"><div id="dim" class="off"></div><img id="modal" class="off">`));
  return win;
}

async function layerOf(win) {
  const image = await win.capturePage();
  return image.isEmpty() ? null : image.toDataURL();
}

/** Capture the live surfaces, stack them, and write the composed frame `repeats` times. */
async function frame(stage, repeats = 6) {
  await pause(80);
  const [shell, review, modal] = await Promise.all([
    layerOf(stage.shell),
    layerOf(stage.review),
    stage.modalVisible ? layerOf(stage.modal) : Promise.resolve(null),
  ]);
  await stage.compositor.webContents.executeJavaScript(`(function () {
    var set = function (id, src) {
      var el = document.getElementById(id);
      el.classList.toggle('off', !src);
      if (src) el.src = src;
    };
    set('shell', ${JSON.stringify(shell)});
    set('review', ${JSON.stringify(review)});
    set('modal', ${JSON.stringify(modal)});
    document.getElementById('dim').classList.toggle('off', !${JSON.stringify(Boolean(modal))});
    return true;
  })()`);
  await pause(40);
  const png = (await stage.compositor.capturePage()).toPNG();
  for (let i = 0; i < repeats; i += 1) {
    stage.index += 1;
    writeFileSync(join(stage.frameDir, `frame-${String(stage.index).padStart(4, "0")}.png`), png);
  }
}

async function typeInto(stage, selector, text, target = "modal") {
  const win = stage[target];
  for (let i = 0; i < text.length; i += 3) {
    await win.webContents.executeJavaScript(`
      var el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(text.slice(0, i + 3))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await frame(stage, 1);
  }
}

async function typeIntoEditor(stage, selector, text) {
  const insert = (command, value = null) => stage.review.webContents.executeJavaScript(`(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    el.spellcheck = false;
    el.setAttribute('autocorrect', 'off');
    if (document.activeElement !== el) el.focus();
    return document.execCommand(${JSON.stringify(command)}, false, ${JSON.stringify(value)});
  })()`);
  let chunk = "";
  for (const character of text) {
    if (character !== "\n" && chunk.length < 5) { chunk += character; continue; }
    if (chunk) { await insert("insertText", chunk); chunk = ""; await frame(stage, 1); }
    if (character === "\n") { await insert("insertParagraph"); await frame(stage, 1); }
    else chunk = character;
  }
  if (chunk) {
    await insert("insertText", chunk);
    await frame(stage, 1);
  }
}

const caption = (stage, text) => stage.compositorCaption(text);

// ---- Act 1: a task starts as its own worktree ----
async function recordWorktreeCreation(stage) {
  caption(stage, "1 \u00b7 A task starts as its own worktree (\u2318N)");
  await frame(stage, 10);

  stage.modalVisible = true;
  await stage.modal.webContents.executeJavaScript("window.__demoHub.fire('modalOpen', { type: 'new' })");
  await pause(300);
  await frame(stage, 8);

  // Pick the project the same way a click does: through the dialog's own menu.
  await stage.modal.webContents.executeJavaScript("document.querySelector('#choose').click()");
  await pause(200);
  await frame(stage, 6);
  await stage.modal.webContents.executeJavaScript("document.querySelector('#projectMenu button[data-path]').click()");
  await pause(250);
  await frame(stage, 6);

  caption(stage, "2 \u00b7 Name the task \u2014 kakapo names the branch and the folder");
  await typeInto(stage, "#label", "archived opt-in");
  await pause(250);
  await frame(stage, 10);

  caption(stage, "3 \u00b7 Create: fetch the base, add the worktree, start the agent in it");
  await stage.modal.webContents.executeJavaScript("document.querySelector('#doCreate').click()");
  await pause(250);
  await frame(stage, 12);

  // The worktree now exists: the rail gains its tile, and the dialog closes.
  await stage.shell.webContents.executeJavaScript(
    `window.__demoHub.fire('state', ${JSON.stringify(workspaceTiles(true))})`);
  await stage.modal.webContents.executeJavaScript("window.__demoFinishCreate && window.__demoFinishCreate({ ok: true })");
  await pause(400);
  stage.modalVisible = false;
  caption(stage, "4 \u00b7 The workspace is open, with its agent already running");
  await frame(stage, 14);
}

// ---- Act 2: the review loop ----
async function recordReviewFlow(stage) {
  const review = stage.review;
  caption(stage, "5 \u00b7 Read the diff the agent actually wrote");
  await review.webContents.executeJavaScript(`document.querySelector('.diff-active-row')?.classList.add('demo-pulse')`);
  await frame(stage, 12);

  caption(stage, "6 \u00b7 ? \u2014 ask for a change, on the line");
  await review.webContents.executeJavaScript(`
    document.querySelector('.diff-active-row')?.classList.remove('demo-pulse');
    var rows = Array.prototype.slice.call(document.querySelectorAll('#diff2html-container tr'));
    var target = rows.filter(function (r) { return r.textContent.indexOf('String(b.priority)') >= 0; })[0];
    if (target) focusDiffRow(target);
    openComposer('c');
  `);
  await waitFor(review, "document.querySelector('.mc-composer .mc-input')");
  await frame(stage, 4);
  await typeInto(stage, ".mc-composer .mc-input", CHANGE_REQUEST, "review");

  caption(stage, "7 \u00b7 Save once \u2014 kakapo asks its own review agent automatically");
  await review.webContents.executeJavaScript("saveComposer()");
  await waitFor(review, "document.querySelector('.mc-thinking')");
  await frame(stage, 14);

  caption(stage, "8 \u00b7 The answer returns to the same line, without a handoff step");
  await review.webContents.executeJavaScript(`
    var records = reviewComments.map(commentToRecord);
    var question = records[records.length - 1];
    records.push({ id: 900, re: question.id, by: 'agent', text: ${JSON.stringify(AGENT_ANSWER)} });
    applyThreadRecords(records);
    applyAskStatus({ asks: [] });
  `);
  await waitFor(review, "document.querySelector('.mc-card.mc-ai')");
  await frame(stage, 16);
}

// ---- Act 3: review knowledge stays connected ----
async function recordKnowledgeMap(stage) {
  const review = stage.review;
  caption(stage, "9 \u00b7 \u2318\u21e7K \u2014 review vocabulary becomes a reusable knowledge graph");
  await review.webContents.executeJavaScript(`
    closeMergedMemoDocks();
    openTermMap();
  `);
  await waitFor(review, "document.querySelectorAll('#mc-map .mc-node').length >= 6");
  await frame(stage, 16);

  caption(stage, "10 \u00b7 Each concept stays linked to its meaning and code");
  await review.webContents.executeJavaScript("openTermCard(termNodeByKey('review queue'))");
  await waitFor(review, "document.querySelector('#mc-term-card')");
  await frame(stage, 16);
}

// ---- Act 4: keep the next review step beside the workspace ----
async function recordMemo(stage) {
  const review = stage.review;
  caption(stage, "11 \u00b7 \u2318\u21e7N \u2014 write a Markdown memo without leaving the review");
  await review.webContents.executeJavaScript("closeTermMap(); openMemoView()");
  await waitFor(review, "document.querySelector('#mc-memo-panel .mc-inline-editor[contenteditable=true]')");
  await frame(stage, 8);
  await typeIntoEditor(stage, "#mc-memo-panel .mc-inline-editor[contenteditable=true]", MEMO);
  await pause(350);
  caption(stage, "12 \u00b7 The memo is saved per worktree and ready for the next pass");
  await frame(stage, 16);
}

async function recordFrames(htmlPath, frameDir) {
  const shell = await makeWindow({ width, height }, { label: "rail" });
  const review = await makeWindow(REVIEW_BOX, { label: "review" });
  const modal = await makeWindow(MODAL_BOX, { label: "dialog", transparent: true });
  const compositor = await makeCompositor();

  await shell.loadURL("data:text/html;charset=utf-8,"
    + encodeURIComponent(withBridge(hubHtml(false, appVersion, t), hubBridge(workspaceTiles(false)))));
  await modal.loadURL("data:text/html;charset=utf-8,"
    + encodeURIComponent(withBridge(modalOverlayHtml(false, t), hubBridge(workspaceTiles(false)))));
  await review.loadURL(`${pathToFileURL(htmlPath).href}#hunk-0`);
  await waitFor(review, "!document.getElementById('boot-overlay')");
  await waitFor(review, "document.querySelector('#diff-view:not(.hidden) .diff-active-row')");

  const stage = {
    shell, review, modal, compositor, frameDir, index: 0, modalVisible: false,
    compositorCaption: (text) => compositor.webContents.executeJavaScript(`(function () {
      var el = document.getElementById('demo-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-caption';
        document.body.appendChild(el);
      }
      el.textContent = ${JSON.stringify("")} + ${JSON.stringify(text)};
      return true;
    })()`),
  };
  // The caption belongs to the composed frame, not to any one surface — a layer's own caption would be
  // covered the moment another layer stacked on top of it.
  await compositor.webContents.insertCSS(`#demo-caption {
    position: fixed; left: 24px; bottom: 22px; z-index: 9999; padding: 9px 14px;
    border: 1px solid rgba(255,255,255,.15); border-radius: 7px; background: rgba(25,28,32,.9);
    color: #e6edf3; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.25);
  }`);

  await review.webContents.executeJavaScript(`setActive(firstHunkForPath('src/reviewQueue.ts'), true, true)`);
  await pause(400);
  await recordWorktreeCreation(stage);
  await recordReviewFlow(stage);
  await recordKnowledgeMap(stage);
  await recordMemo(stage);

  [shell, review, modal, compositor].forEach((win) => win.destroy());
  return stage.index;
}

function makeGif(frameDir) {
  if (!existsSync(outputGif)) mkdirSync(dirname(outputGif), { recursive: true });
  const video = join(frameDir, "kakapo-core-flow.mp4");
  const palette = join(frameDir, "palette.png");
  // Encode a real video first. The README artifact is then derived from the same recorded frame stream,
  // which keeps this script useful for both motion QA and a browser-friendly GIF.
  run("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    join(frameDir, "frame-%04d.png"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    video,
  ]);
  run("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    join(frameDir, "frame-%04d.png"),
    "-vf",
    "fps=10,scale=960:-1:flags=lanczos,palettegen",
    palette,
  ]);
  run("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    join(frameDir, "frame-%04d.png"),
    "-i",
    palette,
    "-lavfi",
    "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
    outputGif,
  ]);
}

async function main() {
  const assetRoot = resolve(repoRoot, "dist", "monaco");
  protocol.handle("kakapo-asset", (request) => {
    const target = join(assetRoot, decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, ""));
    if (!target.startsWith(assetRoot) || !existsSync(target)) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(target), { headers: { "content-type": "text/javascript; charset=utf-8" } });
  });
  const workRoot = mkdtempSync(join(tmpdir(), "kakapo-demo-"));
  try {
    const demoRepo = createDemoRepo(workRoot);
    const htmlPath = renderDemoHtml(demoRepo, workRoot);
    const frameDir = join(workRoot, "frames");
    mkdirSync(frameDir, { recursive: true });
    const frames = await recordFrames(htmlPath, frameDir);
    makeGif(frameDir);
    console.log(`wrote ${outputGif} from ${frames} frames`);
  } finally {
    if (process.env.KAKAPO_KEEP_DEMO_FRAMES !== "1") {
      rmSync(workRoot, { recursive: true, force: true });
    } else {
      console.log(`kept demo workdir: ${workRoot}`);
    }
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  });
