import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DIFF_CONTEXT, ensureElectronRuntimeBranded } from "../dist/commands.js";
import { renderWelcomeHtml } from "../dist/render.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchScript = join(repoRoot, "scripts", "patch-electron-name.mjs");

test("launcher keeps the initial diff folded to a compact context window", () => {
  assert.equal(DEFAULT_DIFF_CONTEXT, 12);
});

test("launcher repairs Electron branding before resolving the macOS runtime", () => {
  const calls = [];

  ensureElectronRuntimeBranded({
    platform: "darwin",
    execPath: "/usr/local/bin/node",
    env: { FOO: "bar" },
    existsSync(path) {
      calls.push(["exists", path]);
      return path === patchScript;
    },
    spawnSync(command, args, options) {
      calls.push(["spawn", command, args, { env: options.env, stdio: options.stdio }]);
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [
    ["exists", patchScript],
    ["spawn", "/usr/local/bin/node", [patchScript], { env: { FOO: "bar" }, stdio: "ignore" }],
  ]);
});

test("launcher skips Electron branding repair outside macOS", () => {
  const calls = [];

  ensureElectronRuntimeBranded({
    platform: "linux",
    existsSync(path) {
      calls.push(["exists", path]);
      return true;
    },
    spawnSync() {
      calls.push(["spawn"]);
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, []);
});

test("launcher tolerates missing or failing branding repair", () => {
  assert.doesNotThrow(() => ensureElectronRuntimeBranded({
    platform: "darwin",
    existsSync() {
      return false;
    },
  }));

  assert.doesNotThrow(() => ensureElectronRuntimeBranded({
    platform: "darwin",
    existsSync() {
      return true;
    },
    spawnSync() {
      throw new Error("readonly install");
    },
  }));
});

test("running Electron main process never mutates its own macOS app bundle", () => {
  const source = readFileSync(join(repoRoot, "src", "app-main.ts"), "utf8");

  assert.doesNotMatch(source, /patch-electron-name/, "bundle repair must finish in the launcher before Electron starts");
  assert.doesNotMatch(source, /ELECTRON_RUN_AS_NODE/, "app-main must not spawn a live-bundle repair subprocess");
});

test("the packaged app preserves --cwd while development skips the app-main entry", () => {
  const source = readFileSync(join(repoRoot, "src", "app-main.ts"), "utf8");
  assert.match(source, /app\.isPackaged\s*\?\s*process\.argv\.slice\(1\)\s*:\s*process\.argv\.slice\(2\)/,
    "packaged argv has no app-main.js entry to discard");
  assert.match(source, /parseArgs\(runtimeArgs\)/);
});

test("macOS app integrates the review toolbar into the native title bar", () => {
  const source = readFileSync(join(repoRoot, "src", "app-main.ts"), "utf8");

  assert.match(source, /process\.platform === "darwin"[\s\S]{0,240}titleBarStyle:\s*"hiddenInset"/, "macOS uses compact inset window chrome");
  assert.match(source, /trafficLightPosition:\s*\{\s*x:\s*14,\s*y:\s*13\s*\}/, "traffic lights retain a deliberate safe corner");
});

test("the welcome screen cannot overflow upward beneath macOS traffic lights", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    path: `/Users/reviewer/projects/project-${index}`,
    name: `project-${index}`,
  }));
  const html = renderWelcomeHtml(false, recent);

  assert.match(html, /body \{[^}]*display: flex;[^}]*padding: 40px 24px 24px;[^}]*overflow: auto;/, "the tall recent-project list starts below the native title row and scrolls");
  assert.match(html, /\.card \{[^}]*max-width: 100%;[^}]*margin: auto;/, "short welcome content remains centered while oversized content top-aligns inside the safe padding");
});

test("sidebar path actions stay in Electron main and reject paths outside the project", () => {
  const main = readFileSync(join(repoRoot, "src", "app-main.ts"), "utf8");
  const preload = readFileSync(join(repoRoot, "src", "preload.cts"), "utf8");

  assert.match(main, /function resolveProjectRowPath[\s\S]*?isAbsolute\(requestedPath\)[\s\S]*?resolve\(state\.options\.root\)[\s\S]*?fromRoot\.startsWith\("\.\.\/"\)/,
    "main resolves only selected-workspace-contained relative paths, including monorepo subdirectory launches");
  assert.match(main, /ipcMain\.handle\("monacori:absolute-file-path"/);
  assert.match(main, /ipcMain\.handle\("monacori:reveal-in-finder"/);
  assert.match(main, /ipcMain\.handle\("monacori:open-terminal"[\s\S]*?spawn\("open", \["-a", "Terminal", directory\]/,
    "macOS terminal action opens the selected file's directory without a shell");
  assert.match(preload, /absolutePath:[\s\S]*?monacori:absolute-file-path/);
  assert.match(preload, /revealInFinder:[\s\S]*?monacori:reveal-in-finder/);
  assert.match(preload, /openTerminal:[\s\S]*?monacori:open-terminal/);
  assert.match(preload, /existingPaths:[\s\S]*?monacori:existing-project-paths/, "renderer can verify comment files without inferring deletion from index exclusions");
});

test("published Electron runtime stays pinned to the verified patch version", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));

  assert.equal(packageJson.dependencies.electron, "42.4.1");
  assert.equal(packageLock.packages[""].dependencies.electron, "42.4.1");
  assert.equal(packageLock.packages["node_modules/electron"].version, "42.4.1");
});
