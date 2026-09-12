import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppPreferences } from "../dist/app-preferences.js";
import { externalUrl, resolveProjectPath, viewableFilePath } from "../dist/app-path-ipc.js";

test("application preferences separate global and per-worktree state", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-preferences-"));
  try {
    const userData = join(base, "app-data");
    const first = join(base, "repos", "first");
    const nested = join(first, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    const preferences = new AppPreferences(userData);

    preferences.setRendererSetting(first, "kakapo-theme", "light");
    preferences.setRendererSetting(first, "kakapo-viewed", { "a.ts": true });
    preferences.setRendererSetting(nested, "kakapo-viewed", { "b.ts": true });

    assert.equal(preferences.rendererSettings(first)["kakapo-theme"], "light");
    assert.deepEqual(preferences.rendererSettings(first)["kakapo-viewed"], { "a.ts": true });
    assert.deepEqual(preferences.rendererSettings(nested)["kakapo-viewed"], { "b.ts": true });
    assert.equal(preferences.readGlobal()["kakapo-viewed"], undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recent projects are validated, deduplicated, and bounded", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-recents-"));
  try {
    const preferences = new AppPreferences(join(base, "app-data"), (path) => !path.endsWith("ignored"));
    for (let index = 0; index < 14; index += 1) preferences.recordRecentProject(join(base, `repo-${index}`));
    preferences.recordRecentProject(join(base, "repo-5"));
    preferences.recordRecentProject(join(base, "ignored"));

    const recent = preferences.readRecentProjects();
    assert.equal(recent.length, 12);
    assert.equal(recent[0].path, resolve(base, "repo-5"));
    assert.equal(recent.filter((project) => project.path === resolve(base, "repo-5")).length, 1);
    assert.ok(recent.every((project) => project.path !== resolve(base, "ignored")));

    preferences.forgetRecentProject(join(base, "repo-5"));
    assert.ok(preferences.readRecentProjects().every((project) => project.path !== resolve(base, "repo-5")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pruneRecentProjects drops recent entries whose folder is gone (deleted-worktree cleanup)", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-prune-"));
  try {
    const live = join(base, "live");
    mkdirSync(live);
    const preferences = new AppPreferences(join(base, "app-data"));
    preferences.recordRecentProject(live);
    preferences.recordRecentProject(join(base, "gone")); // recorded, but its folder is never created
    // readRecentProjects stays a pure shape validator — both are kept until an explicit prune.
    assert.equal(preferences.readRecentProjects().length, 2);
    preferences.pruneRecentProjects();
    const after = preferences.readRecentProjects();
    assert.equal(after.length, 1);
    assert.equal(after[0].path, resolve(live));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("project path boundary accepts only relative paths contained by the opened folder", () => {
  const root = resolve("/tmp/kakapo-workspace/packages/reviewer");
  assert.equal(resolveProjectPath(root, "src/main.ts"), join(root, "src", "main.ts"));
  assert.equal(resolveProjectPath(root, "./README.md"), join(root, "README.md"));
  assert.equal(resolveProjectPath(root, "../sibling/secret.ts"), undefined);
  assert.equal(resolveProjectPath(root, "/tmp/outside.ts"), undefined);
  assert.equal(resolveProjectPath(root, ""), undefined);
});

// A URL an agent wrote into the review thread becomes a clickable link, so the URL a click hands to the OS
// is an untrusted input. Only plain http(s) may reach shell.openExternal — a file:// or custom scheme would
// be dispatched by the OS to whatever app claims it.
test("external-link boundary opens only http(s) URLs from untrusted text", () => {
  assert.equal(externalUrl("https://github.com/happy-nut/kakapo"), "https://github.com/happy-nut/kakapo");
  assert.equal(externalUrl("http://localhost:3000/health"), "http://localhost:3000/health");
  assert.equal(externalUrl("file:///Users/me/.ssh/id_rsa"), undefined);
  assert.equal(externalUrl("javascript:alert(1)"), undefined);
  assert.equal(externalUrl("vscode://install?x=1"), undefined);
  assert.equal(externalUrl("not a url"), undefined);
  assert.equal(externalUrl(""), undefined);
  assert.equal(externalUrl(null), undefined);
  assert.equal(externalUrl("https://x.test/" + "a".repeat(2048)), undefined, "an absurdly long URL is refused outright");
});

// The same untrusted-text rule for file paths: a click may open a file with the OS viewer only when it
// is an absolute path to an existing file with a viewer-rendered extension — never anything executable.
test("viewable-file boundary opens only existing image/pdf files by absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-viewable-"));
  try {
    const png = join(dir, "shot.png");
    writeFileSync(png, "not-really-a-png");
    assert.equal(viewableFilePath(png), png, "an existing image opens");
    assert.equal(viewableFilePath(join(dir, "missing.png")), undefined, "a file that does not exist stays inert");
    assert.equal(viewableFilePath("shot.png"), undefined, "a relative path never reaches the OS");
    assert.equal(viewableFilePath(dir), undefined, "a directory is not a viewable file");
    for (const name of ["run.sh", "Evil.app", "x.command", "a.html", "b.js"]) {
      writeFileSync(join(dir, name), "");
      assert.equal(viewableFilePath(join(dir, name)), undefined, `${name} is not viewer-safe`);
    }
    assert.equal(viewableFilePath(null), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main process is a composition root for extracted persistence and IPC adapters", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(main, /new AppPreferences\(app\.getPath\("userData"\), isGitRepository\)/);
  assert.match(main, /registerReviewIpc\(ipcMain, stateFromEvent\)/);
  assert.match(main, /registerProjectPathIpc\(ipcMain, shell, stateFromEvent\)/);
  assert.match(main, /registerSettingsIpc\(ipcMain, preferences, stateFromEvent[,)]/);
  assert.doesNotMatch(main, /function readSettings|function resolveProjectRowPath|kakapo:get-file|"kakapo:get-settings"/);
  assert.doesNotMatch(main, /registerMemoIpc|ProjectMarkdownMemo/, "the worktree memo is gone, adapter and all");
});

// A window that is gone cannot be zoomed, resized or asked anything: Electron's webContents getter returns
// undefined once it is destroyed, and a timer firing after a close is exactly when that happens. Every
// surface method has to answer for its window being gone before it touches it.
test("the review surface answers for its window being gone", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const surface = main.match(/const surface: ReviewSurface = \{[\s\S]*?\n  \};/)[0];
  const delegating = surface.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /\bwin\.(show|focus|restore|isMinimized)\(\)/.test(line));
  assert.ok(delegating.length >= 3, "the surface still delegates to a window");
  assert.deepEqual(delegating.filter(({ line }) => !line.includes("isDestroyed")), [],
    "a window method is only called after asking whether the window is still there");
  // And the broadcast helpers skip a destroyed one rather than throwing mid-loop.
  const zoom = main.match(/function applyUiScale\([\s\S]*?\n\}/)[0];
  assert.match(zoom, /isDestroyed\(\)/, "applyUiScale skips a window that has gone");
});

// The scale list exists twice: main steps through it for ⌘+ / ⌘− and the Settings dropdown renders it in the
// viewer, which cannot import TypeScript. Let them drift and a keystroke lands on a size the dropdown cannot
// show as selected — the same way the syntax-family list once drifted and a chosen theme came back wrong.
test("the UI scale list main steps through is the one the dropdown offers", async () => {
  const { UI_SCALES } = await import("../dist/constants.js");
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const declared = core.match(/var UI_SCALES = \[([^\]]*)\]/)?.[1];
  assert.ok(declared, "the viewer still declares its own copy");
  assert.deepEqual(declared.split(",").map((n) => Number(n.trim())), UI_SCALES);
});

// The scale is one setting for the whole app: main applies it to the shell, the overlay and every review view
// from the GLOBAL file. Stored per-workspace instead, the dropdown moved and nothing changed size.
test("the UI scale is stored globally, not per workspace", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-scale-"));
  try {
    const prefs = new AppPreferences(join(base, "app-data"));
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    prefs.setRendererSetting(repo, "kakapo-ui-scale", 1.25);
    assert.equal(prefs.readGlobal()["kakapo-ui-scale"], 1.25, "a workspace window writing it still writes the global");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Every quit path goes through finishQuit, which is what sets the flag before-quit reads. Setting
// quitConfirmed by hand is how a caller (the packaged self-update) once bypassed the whole shutdown path.
test("quitConfirmed is only ever set by finishQuit", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const assignments = source.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])quitConfirmed\s*=\s*true/.test(line) && !line.startsWith("//") && !line.startsWith("*"));
  assert.equal(assignments.length, 1, `quitConfirmed is set outside finishQuit: ${JSON.stringify(assignments)}`);
  assert.match(source, /function finishQuit\(\): void \{\n\s*quitConfirmed = true;/);
});
