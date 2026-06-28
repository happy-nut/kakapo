import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliArgsForCwd,
  globalMoBinCandidates,
  relaunchArgsForCwd,
  relaunchUpdatedApp,
  resolveGlobalMoBin,
} from "../dist/self-update.js";

test("self-update relaunch args preserve the app entry and replace --cwd with the active repo", () => {
  const args = relaunchArgsForCwd([
    "/path/to/electron",
    "/global/monacori/dist/app-main.js",
    "--cwd",
    "/old/repo",
    "--context",
    "100000",
    "--include-untracked",
  ], "/active/repo");

  assert.deepEqual(args, [
    "/global/monacori/dist/app-main.js",
    "--cwd",
    "/active/repo",
    "--context",
    "100000",
    "--include-untracked",
  ]);
});

test("self-update relaunch args append --cwd when the current argv has none", () => {
  assert.deepEqual(
    relaunchArgsForCwd(["/path/to/electron", "/global/monacori/dist/app-main.js"], "/active/repo"),
    ["/global/monacori/dist/app-main.js", "--cwd", "/active/repo"],
  );
});

test("self-update relaunch args repair a dangling --cwd", () => {
  assert.deepEqual(
    relaunchArgsForCwd(["/path/to/electron", "/global/monacori/dist/app-main.js", "--cwd"], "/active/repo"),
    ["/global/monacori/dist/app-main.js", "--cwd", "/active/repo"],
  );
});

test("self-update CLI args reopen the active repo and preserve --no-watch", () => {
  assert.deepEqual(
    cliArgsForCwd([
      "/path/to/electron",
      "/global/monacori/dist/app-main.js",
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

test("self-update finds the global mo bin from npm prefix", () => {
  assert.deepEqual(globalMoBinCandidates("/opt/node", "darwin"), ["/opt/node/bin/mo", "/opt/node/mo"]);
  assert.equal(resolveGlobalMoBin({
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/mo"; },
  }), "/opt/node/bin/mo");
});

test("self-update launches the newly installed global mo before exiting", () => {
  const calls = [];
  const app = {
    relaunch(options) { calls.push(["relaunch", options]); },
    exit(code) { calls.push(["exit", code]); },
  };

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/monacori/dist/app-main.js", "--cwd", "/old"], "/active", {
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/mo"; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "/opt/node/bin/mo", ["--cwd", "/active"], { cwd: "/active", detached: true, shell: false }],
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

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/monacori/dist/app-main.js"], "/active", {
    spawnSync() { return { status: 1, stdout: "" }; },
    existsSync() { return false; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "npm", ["exec", "-g", "--", "mo", "--cwd", "/active"], { cwd: "/active", detached: true, shell: true }],
    ["unref"],
    ["exit", 0],
  ]);
});

test("self-update falls back to npm exec if the global mo bin fails to spawn", () => {
  const calls = [];
  const app = {
    relaunch(options) { calls.push(["relaunch", options]); },
    exit(code) { calls.push(["exit", code]); },
  };

  relaunchUpdatedApp(app, ["/path/to/electron", "/global/monacori/dist/app-main.js"], "/active", {
    platform: "darwin",
    spawnSync() { return { status: 0, stdout: "/opt/node\n" }; },
    existsSync(path) { return path === "/opt/node/bin/mo"; },
    spawn(command, args, options) {
      calls.push(["spawn", command, args, { cwd: options.cwd, detached: options.detached, shell: options.shell }]);
      if (command === "/opt/node/bin/mo") throw new Error("bad shim");
      return { unref() { calls.push(["unref"]); } };
    },
    env: {},
  });

  assert.deepEqual(calls, [
    ["spawn", "/opt/node/bin/mo", ["--cwd", "/active"], { cwd: "/active", detached: true, shell: false }],
    ["spawn", "npm", ["exec", "-g", "--", "mo", "--cwd", "/active"], { cwd: "/active", detached: true, shell: true }],
    ["unref"],
    ["exit", 0],
  ]);
});
