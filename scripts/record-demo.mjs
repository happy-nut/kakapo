#!/usr/bin/env node

import { app, BrowserWindow } from "electron";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { buildDiffReview } from "../dist/cli.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputGif = resolve(repoRoot, "assets", "monacori-core-flow.gif");
const width = 1280;
const height = 760;
const frameRate = 10;

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
  git(demoRepo, ["config", "user.email", "demo@monacori.local"]);
  git(demoRepo, ["config", "user.name", "Monacori Demo"]);
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
  return String.raw`<script>
window.monacoriClipboard = { write: function (text) { window.__demoClipboard = String(text || ''); } };
window.monacoriSettings = { all: { 'monacori-theme': 'dark', 'monacori-locale': 'en' }, set: function (key, value) { this.all[key] = value; } };
window.monacoriMenu = {};
window.__demoCaption = function (text) {
  var el = document.getElementById('demo-caption');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demo-caption';
    document.body.appendChild(el);
  }
  el.textContent = text;
};
</script>`;
}

function demoStyles() {
  return String.raw`<style>
#demo-caption {
  position: fixed;
  left: 78px;
  top: 18px;
  z-index: 9999;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, .15);
  border-radius: 7px;
  background: rgba(25, 28, 32, .88);
  color: #e6edf3;
  font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
}
.demo-pulse {
  outline: 2px solid #ffc66d !important;
  outline-offset: 2px;
}
</style>`;
}

function renderDemoHtml(demoRepo, workRoot) {
  const review = buildDiffReview({
    root: demoRepo,
    includeUntracked: true,
    staged: false,
    context: 4,
    title: "monacori",
    app: true,
    lazy: false,
    lazyLoad: false,
  });
  const html = review.html
    .replace("</head>", `${demoStyles()}\n</head>`)
    .replace("<body>", `<body>\n${demoBridgePrelude()}`);
  const htmlPath = join(workRoot, "monacori-demo.html");
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

async function capture(win, frameDir, state, repeats = 6) {
  await pause(90);
  const image = await win.capturePage();
  const png = image.toPNG();
  for (let i = 0; i < repeats; i += 1) {
    state.index += 1;
    writeFileSync(join(frameDir, `frame-${String(state.index).padStart(4, "0")}.png`), png);
  }
}

async function captureTyping(win, frameDir, state, selector, text) {
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value = ""`);
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(0, i + 4);
    await win.webContents.executeJavaScript(`
      var el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(chunk)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await capture(win, frameDir, state, 1);
  }
}

async function recordFrames(htmlPath, frameDir) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#2b2b2b",
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const state = { index: 0 };
  await win.loadURL(`${pathToFileURL(htmlPath).href}#hunk-0`);
  await waitFor(win, "!document.getElementById('boot-overlay')");
  await waitFor(win, "document.querySelector('#diff-view:not(.hidden) .diff-active-row')");

  await win.webContents.executeJavaScript(`
    window.__demoCaption('1. Review the exact AI-generated diff');
    document.querySelector('.diff-active-row')?.classList.add('demo-pulse');
  `);
  await capture(win, frameDir, state, 10);

  await win.webContents.executeJavaScript(`
    document.querySelector('.diff-active-row')?.classList.remove('demo-pulse');
    window.__demoCaption('2. Add a line-level change request');
    openComposer('c');
  `);
  await waitFor(win, "document.querySelector('.mc-composer .mc-input')");
  await capture(win, frameDir, state, 4);
  await captureTyping(
    win,
    frameDir,
    state,
    ".mc-composer .mc-input",
    "Keep archived reviews out of the default queue and preserve a stable priority order.",
  );
  await win.webContents.executeJavaScript("saveComposer()");
  await waitFor(win, "document.querySelector('.mc-card.mc-c')");
  await capture(win, frameDir, state, 8);

  await win.webContents.executeJavaScript(`
    window.__demoCaption('3. Merge comments into a grounded follow-up prompt');
    openMergedView('c');
  `);
  await waitFor(win, "document.querySelector('#mc-merged-panel textarea')");
  await capture(win, frameDir, state, 10);

  await win.webContents.executeJavaScript(`
    window.__demoCaption('4. Copy grounded review evidence for the next AI turn');
    document.querySelector('.mc-copy-all')?.classList.add('demo-pulse');
  `);
  await capture(win, frameDir, state, 6);
  await win.webContents.executeJavaScript("document.querySelector('.mc-copy-all')?.click()");
  await pause(200);
  await capture(win, frameDir, state, 12);

  win.destroy();
  return state.index;
}

function makeGif(frameDir) {
  if (!existsSync(outputGif)) mkdirSync(dirname(outputGif), { recursive: true });
  const palette = join(frameDir, "palette.png");
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
  const workRoot = mkdtempSync(join(tmpdir(), "monacori-demo-"));
  try {
    const demoRepo = createDemoRepo(workRoot);
    const htmlPath = renderDemoHtml(demoRepo, workRoot);
    const frameDir = join(workRoot, "frames");
    mkdirSync(frameDir, { recursive: true });
    const frames = await recordFrames(htmlPath, frameDir);
    makeGif(frameDir);
    console.log(`wrote ${outputGif} from ${frames} frames`);
  } finally {
    if (process.env.MONACORI_KEEP_DEMO_FRAMES !== "1") {
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
