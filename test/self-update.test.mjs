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

// The packaged bundle and the global CLI are different installs with different update channels. `npm i -g`
// is right for the command; it never touches /Applications/Kakapo.app, so pressing Update in the bundle
// used to report success and leave the reviewer on the old version. The bundle's channel is the release DMG.
test("the packaged updater picks the build for this machine, and only when it is newer", async () => {
  const { isNewerVersion, macDmgAsset, bundlePathFor, swapScript } = await import("../dist/app-update.js");

  assert.equal(isNewerVersion("v0.5.0", "0.4.9"), true, "a leading v is tolerated");
  assert.equal(isNewerVersion("0.4.10", "0.4.9"), true, "components compare numerically, not as text");
  assert.equal(isNewerVersion("0.4.9", "0.4.9"), false, "the same version is not an update");
  assert.equal(isNewerVersion("0.4.8", "0.4.9"), false, "and neither is an older one");

  const assets = [
    { name: "Kakapo-0.5.0-arm64.dmg", url: "https://example.test/mac.dmg" },
    { name: "Kakapo-0.5.0-linux-x64.tar.gz", url: "https://example.test/linux.tgz" },
  ];
  assert.equal(macDmgAsset(assets, "arm64")?.url, "https://example.test/mac.dmg");
  assert.equal(macDmgAsset(assets, "x64"), undefined, "an Intel Mac is not handed an arm64 bundle");
  assert.equal(macDmgAsset([{ name: "notes.txt", url: "u" }], "arm64"), undefined, "a release without a dmg is no update");

  assert.equal(bundlePathFor("/Applications/Kakapo.app/Contents/MacOS/Kakapo"), "/Applications/Kakapo.app");
  assert.equal(bundlePathFor("/usr/local/bin/node"), undefined, "a plain binary is not a bundle");
});

// A bundle cannot replace itself while it is running, so the swap is a detached script. What matters is that
// a failed copy leaves the machine with an app: the old bundle is moved aside, not deleted, and restored if
// the copy fails.
test("the swap script waits for the app to exit and puts the old bundle back if the copy fails", async () => {
  const { swapScript } = await import("../dist/app-update.js");
  const script = swapScript({ pid: 4242, staged: "/tmp/new/Kakapo.app", installed: "/Applications/Kakapo.app", backup: "/Applications/Kakapo.app.old" });

  assert.match(script, /kill -0 4242/, "it waits for the running app to be gone");
  assert.ok(script.indexOf('mv "/Applications/Kakapo.app" "/Applications/Kakapo.app.old"') <
    script.indexOf("/usr/bin/ditto"), "the old bundle is moved aside BEFORE the new one is copied in");
  assert.match(script, /else[\s\S]*mv "\/Applications\/Kakapo\.app\.old" "\/Applications\/Kakapo\.app"/,
    "a failed copy restores it rather than leaving no app at all");
  assert.match(script, /\/usr\/bin\/open -a "\/Applications\/Kakapo\.app"/, "and the app comes back up");
});
