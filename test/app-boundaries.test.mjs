import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// The dot says "something is waiting here and you have not seen it". Quitting for the night is not reading
// it, so the flag has to outlive the app run — in memory, every morning started by telling you the opposite.
test("an unread workspace is still unread after a restart", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-unread-"));
  try {
    const userData = join(base, "app-data");
    const work = join(base, "repos", "feature");
    mkdirSync(work, { recursive: true });

    const before = new AppPreferences(userData);
    assert.equal(before.readUnread(work), false, "nothing waiting to begin with");
    before.writeUnread(work, true);

    // A fresh instance is what the next launch actually gets.
    assert.equal(new AppPreferences(userData).readUnread(work), true, "the flag survives the process");
    // …and it is per workspace, not per app.
    assert.equal(new AppPreferences(userData).readUnread(join(base, "repos", "other")), false);

    before.writeUnread(work, false); // opening the workspace clears it
    assert.equal(new AppPreferences(userData).readUnread(work), false, "and clearing it sticks too");
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

test("open workspace session and active path round-trip independently of recent projects", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-session-"));
  try {
    const preferences = new AppPreferences(join(base, "app-data"));
    const record = {
      path: join(base, "repo"), repoRoot: join(base, "repo"), repoName: "repo",
      branch: "feature/hub", kind: "worktree", alias: "Hub", openedAt: 123,
    };
    preferences.writeOpenWorkspaces([record], record.path);
    assert.deepEqual(preferences.readOpenWorkspaces(), [record]);
    assert.equal(preferences.readActiveWorkspace(), record.path);
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

// Anything a command prints in the integrated terminal becomes a clickable link, so the URL a click hands
// to the OS is an untrusted input. Only plain http(s) may reach shell.openExternal — a file:// or custom
// scheme would be dispatched by the OS to whatever app claims it.
test("external-link boundary opens only http(s) URLs from terminal output", () => {
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
  assert.match(main, /registerMemoIpc\(ipcMain, \{/);
  assert.doesNotMatch(main, /function readSettings|function resolveProjectRowPath|kakapo:get-file|"kakapo:get-settings"|"kakapo:memo-read"/);
});

// The review surface wraps TWO objects: the view (its webContents) and the host window it is shown in. Its
// isDestroyed() speaks only for the first, and on quit the host goes first — so a caller that dutifully
// checked isDestroyed() went on to ask a destroyed BrowserWindow whether it was minimized, and took the main
// process down with "Object has been destroyed" from a one-second timer. Anything touching the host has to
// answer for the host.
test("every use of the host window answers for the host being gone", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const uses = source.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes("surfaceHost.") && !line.startsWith("//") && !line.startsWith("*"));
  assert.ok(uses.length >= 3, "the wrapper still delegates to a host window");
  const unguarded = uses.filter(({ line }) => !line.includes("isDestroyed"));
  assert.deepEqual(unguarded, [], "a host method is only called after asking whether the host is still there");
});

// A zoom step re-lays out a whole document, and a review document is every changed file plus its terminals.
// Doing that to every open workspace at once — while the reviewer is looking at one of them — is a freeze
// measured in tens of seconds, and the terminals refitting inside hidden views told tmux to redraw at sizes
// nobody could see. Only what is on screen pays; a hidden workspace takes the new size when it is activated.
test("a zoom step only re-lays out the views that are on screen", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const body = main.match(/function applyUiScale\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(body, /for \(const state of states\.values\(\)\)/,
    "applyUiScale does not walk every workspace");
  assert.match(body, /activeStateId/, "it zooms the active one");
  assert.match(main, /activeStateId = id;[\s\S]{0,400}applyUiScale\(activated\.win\.webContents\)/,
    "and a workspace catches up with the current size when it is activated");
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

// Every quit path has to go through finishQuit: it kills the ptys and waits for their exits while the Node
// environment is still alive. Setting quitConfirmed by hand is what makes before-quit stand aside, so a caller
// that did that (the packaged self-update) quit with live ptys, and node-pty delivered their exits into the
// middle of the teardown — abort(), and a macOS crash dialog, every time the app updated itself.
test("quitConfirmed is only ever set by finishQuit", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const assignments = source.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])quitConfirmed\s*=\s*true/.test(line) && !line.startsWith("//") && !line.startsWith("*"));
  assert.equal(assignments.length, 1, `quitConfirmed is set outside finishQuit: ${JSON.stringify(assignments)}`);
  assert.match(source, /async function finishQuit\(\): Promise<void> \{\n\s*quitConfirmed = true;/);
});

// A modal dialog owns the keyboard until it is dismissed. The overlay is a WebContentsView layered over the
// review, so DOM keys go to it — but application-menu ACCELERATORS are window-level and fired straight
// through to the review behind it: ⌘D split a terminal and ⌘0 moved the rail while the New-workspace dialog
// sat waiting for an answer. presentModal/hideModal are the one pair that knows a modal is up, so the claim
// belongs there — not in each dialog, which is how one gets forgotten.
test("showing a modal claims the menu accelerators, and hiding it gives them back", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  const present = between("function presentModal(", "function hideModal(");
  const hide = between("function hideModal(", "ipcMain.on(\"kakapo:hub-open-modal\"");
  assert.match(present, /setIgnoreMenuShortcuts\(true\)/, "the overlay takes the accelerators while it is up");
  assert.match(hide, /setIgnoreMenuShortcuts\(false\)/, "and releases them, or the app goes deaf after one dialog");
  // The release runs on the way out, while the view is still around to hear it.
  assert.ok(hide.indexOf("setIgnoreMenuShortcuts(false)") < hide.indexOf("focusActiveReviewView()"),
    "released before focus goes back to the review");
  assert.match(hide, /modalView && !modalView\.webContents\.isDestroyed\(\)/,
    "a torn-down overlay is not asked to release anything");
});
