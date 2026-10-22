import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppPreferences } from "../dist/app-preferences.js";
import { externalUrl, resolveProjectPath } from "../dist/app-path-ipc.js";

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

// Two places compose the diff container and both carry the no-diff state's markup: build.ts for the
// standalone review and render.ts for the app's own document. A reviewer who hits the dead end hits it
// through one of them and has no way of knowing which, so the two have to say the same thing. They have
// already been spelled twice; this is what keeps the second copy honest.
test("the no-diff state says the same thing in both documents", () => {
  const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const markup = (source, name) => {
    const found = source.match(/<div class="empty"><p class="empty-title"[\s\S]*?<\/p><\/div>/);
    assert.ok(found, `${name} still renders the no-diff state`);
    return found[0];
  };
  const fromBuild = markup(read("build.ts"), "build.ts");
  const fromRender = markup(read("render.ts"), "render.ts");
  assert.equal(fromBuild, fromRender, "the two copies of the no-diff state have drifted");
  // A dead end that only names itself is still a dead end: it has to point at the way out, and it has to
  // do so through the i18n table rather than in English baked into the markup.
  assert.match(fromBuild, /data-i18n="diff\.noDiff"/, "the state names itself from the string table");
  assert.match(fromBuild, /data-i18n="diff\.noDiff\.hint"/, "the state points at the control that resolves it");
  // Not with a chord. A chord written outside shortcuts.ts is a copy nothing keeps in agreement (AGENTS.md).
  const strings = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const hints = strings.match(/"diff\.noDiff\.hint":\s*"([^"]*)"/g) || [];
  assert.equal(hints.length, 2, "the hint is translated in both locales");
  for (const hint of hints) {
    assert.doesNotMatch(hint, /[⌘⌥⇧⌃]|\bF\d\b/, `the hint spells a shortcut instead of naming the control: ${hint}`);
  }
});

// The file tree is built twice — once by the server (render-tree.ts) and once by the client when the
// source tree virtualizes (04-source-tree.js) — so splitting a leaf name into base + extension had to be
// written twice too. Whether you see one spelling or the other depends only on how far you scrolled, which
// is exactly the kind of difference nobody would think to look for. The UI_SCALES guard above exists for
// the same reason; this is its sibling for the name split.
test("the leaf-name split is the same on the server and in the viewer", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const body = (source, name) => {
    const found = /function leafNameHtml\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(found, `${name} still splits a leaf name`);
    // Compare the LOGIC, not the spelling: one file is TypeScript with template literals, the other is
    // ES5 with string concatenation. What has to agree is the split point and the two class names.
    return found[1].replace(/\s+/g, " ").trim();
  };
  const server = body(read("render-tree.ts"), "render-tree.ts");
  const client = body(read("viewer/00-util.js"), "00-util.js");
  const splitPoint = /indexOf\((['"])\.\1, 1\)/;
  assert.match(server, splitPoint, "the server splits at the first interior dot");
  assert.match(client, splitPoint, "the viewer splits at the first interior dot");
  for (const [name, source] of [["server", server], ["viewer", client]]) {
    assert.match(source, /dot <= 0 \|\| dot === name\.length - 1/, `${name} guards a dotless or trailing-dot name`);
    assert.match(source, /class="path-head"/, `${name} emits the base name as path-head`);
    assert.match(source, /class="path-tail"/, `${name} emits the extension as path-tail`);
    assert.match(source, /slice\(0, dot\)/, `${name} puts the base name in the head`);
    assert.match(source, /slice\(dot\)/, `${name} puts the extension in the tail`);
  }
});

// A JVM server answers for anything outside the project with a `jrt:`/`jar:` URI, and both sides have to
// name it the same way: the main process so a location carries a sensible label, the viewer so the caret
// hint can say where the definition is without asking. Written twice, for the same reason the leaf-name
// split is — so guarded the same way. What must agree is where the name is cut, not the spelling.
test("the external-location label is the same in the main process and in the viewer", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const body = (source, name) => {
    const found = /function externalLocationLabel\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(found, `${name} still labels an external location`);
    return found[1].replace(/\s+/g, " ").trim();
  };
  const main = body(read("lsp.ts"), "lsp.ts");
  const viewer = body(read("viewer/00-util.js"), "00-util.js");
  for (const [side, source] of [["main", main], ["viewer", viewer]]) {
    assert.match(source, /indexOf\((['"])!\/\1\)/, `${side} cuts at the archive separator`);
    assert.match(source, /slice\(bang \+ 2\)/, `${side} keeps what is inside the archive`);
    assert.match(source, /\\\.\(jar\|zip\)\$/i, `${side} recognises an archive by the same extensions`);
    assert.match(source, /\^\[a-z\]\+:/i, `${side} strips the scheme when there is no archive separator`);
  }
});
