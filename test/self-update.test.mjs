import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliArgsForCwd,
  globalKakapoBinCandidates,
  relaunchArgsForCwd,
  relaunchUpdatedApp,
  resolveGlobalKakapoBin,
  selfUpdateInstallAttempts,
} from "../dist/self-update.js";

test("self-update relaunch args preserve the app entry and replace --cwd with the active repo", () => {
  const args = relaunchArgsForCwd([
    "/path/to/electron",
    "/global/kakapo/dist/app-main.js",
    "--cwd",
    "/old/repo",
    "--context",
    "100000",
    "--include-untracked",
  ], "/active/repo");

  assert.deepEqual(args, [
    "/global/kakapo/dist/app-main.js",
    "--cwd",
    "/active/repo",
    "--context",
    "100000",
    "--include-untracked",
  ]);
});

test("self-update relaunch args append --cwd when the current argv has none", () => {
  assert.deepEqual(
    relaunchArgsForCwd(["/path/to/electron", "/global/kakapo/dist/app-main.js"], "/active/repo"),
    ["/global/kakapo/dist/app-main.js", "--cwd", "/active/repo"],
  );
});

test("self-update relaunch args repair a dangling --cwd", () => {
  assert.deepEqual(
    relaunchArgsForCwd(["/path/to/electron", "/global/kakapo/dist/app-main.js", "--cwd"], "/active/repo"),
    ["/global/kakapo/dist/app-main.js", "--cwd", "/active/repo"],
  );
});

test("self-update CLI args reopen the active repo and preserve --no-watch", () => {
  assert.deepEqual(
    cliArgsForCwd([
      "/path/to/electron",
      "/global/kakapo/dist/app-main.js",
      "--cwd",
      "/old/repo",
      "--context",
      "100000",
      "--include-untracked",
      "--no-watch",
    ], "/active/repo"),
    ["--cwd", "/active/repo", "--no-watch"],
  );
});

test("self-update finds the global kakapo bin from npm prefix", () => {
  assert.deepEqual(globalKakapoBinCandidates("/opt/node", "darwin"), ["/opt/node/bin/kakapo", "/opt/node/kakapo"]);
  assert.equal(resolveGlobalKakapoBin({
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/kakapo"; },
  }), "/opt/node/bin/kakapo");
});

test("self-update install tries npm directly, then a macOS login shell for GUI launches", () => {
  assert.deepEqual(selfUpdateInstallAttempts({ SHELL: "/bin/bash" }, "darwin"), [
    { label: "npm", command: "npm", args: ["install", "-g", "@happy-nut/kakapo@latest"], shell: true },
    { label: "/bin/bash login shell", command: "/bin/bash", args: ["-lc", "npm install -g @happy-nut/kakapo@latest"], shell: false },
    { label: "/bin/zsh login shell", command: "/bin/zsh", args: ["-lc", "npm install -g @happy-nut/kakapo@latest"], shell: false },
  ]);
});

test("self-update install keeps non-macOS updates to npm", () => {
  assert.deepEqual(selfUpdateInstallAttempts({}, "linux"), [
    { label: "npm", command: "npm", args: ["install", "-g", "@happy-nut/kakapo@latest"], shell: true },
  ]);
});

test("self-update launches the newly installed global kakapo before exiting", () => {
  const calls = [];
  const app = {
    relaunch(options) { calls.push(["relaunch", options]); },
    exit(code) { calls.push(["exit", code]); },
  };

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/kakapo/dist/app-main.js", "--cwd", "/old"], "/active", {
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/kakapo"; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "/opt/node/bin/kakapo", ["--cwd", "/active"], { cwd: "/active", detached: true, shell: false }],
    ["unref"],
    ["exit", 0],
  ]);
});

test("self-update falls back to npm exec before Electron relaunch", () => {
  const calls = [];
  const app = {
    relaunch(options) { calls.push(["relaunch", options]); },
    exit(code) { calls.push(["exit", code]); },
  };

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/kakapo/dist/app-main.js"], "/active", {
    spawnSync() { return { status: 1, stdout: "" }; },
    existsSync() { return false; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "npm", ["exec", "-g", "--", "kakapo", "--cwd", "/active"], { cwd: "/active", detached: true, shell: true }],
    ["unref"],
    ["exit", 0],
  ]);
});

test("self-update falls back to npm exec if the global kakapo bin fails to spawn", () => {
  const calls = [];
  const app = {
    relaunch(options) { calls.push(["relaunch", options]); },
    exit(code) { calls.push(["exit", code]); },
  };

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/kakapo/dist/app-main.js"], "/active", {
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/kakapo"; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      if (command === "/opt/node/bin/kakapo") throw new Error("bad shim");
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "/opt/node/bin/kakapo", ["--cwd", "/active"], { cwd: "/active", detached: true, shell: false }],
    ["spawn", "npm", ["exec", "-g", "--", "kakapo", "--cwd", "/active"], { cwd: "/active", detached: true, shell: true }],
    ["unref"],
    ["exit", 0],
  ]);
});
