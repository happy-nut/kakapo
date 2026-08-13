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
