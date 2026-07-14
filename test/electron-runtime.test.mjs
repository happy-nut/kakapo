import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronRuntimeBranded } from "../dist/commands.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchScript = join(repoRoot, "scripts", "patch-electron-name.mjs");

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

test("published Electron runtime stays pinned to the verified patch version", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));

  assert.equal(packageJson.dependencies.electron, "42.4.1");
  assert.equal(packageLock.packages[""].dependencies.electron, "42.4.1");
  assert.equal(packageLock.packages["node_modules/electron"].version, "42.4.1");
});
