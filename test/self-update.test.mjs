import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// A ~200MB image used to come down inside installPackagedUpdate as a synchronous curl, which froze the main
// process for the whole transfer with nothing on screen moving — indistinguishable from a hang. The download
// moved out to a streaming caller that reports bytes; what stays here is local disk work measured in seconds.
test("the update installs from a DMG already on disk, and the download reports progress", () => {
  const update = readFileSync(new URL("../src/app-update.ts", import.meta.url), "utf8");
  assert.match(update, /installPackagedUpdate\(options: \{[\s\S]{0,400}dmgPath: string/,
    "installPackagedUpdate takes a downloaded image, not a URL");
  assert.doesNotMatch(update, /"\/usr\/bin\/curl"/, "and no longer shells out to curl");
  assert.doesNotMatch(update, /assetUrl/, "so nothing in the install path touches the network");

  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(main, /net\.request\(\{ url: assetUrl, redirect: "follow" \}\)/,
    "the download follows GitHub's redirect to the CDN itself");
  assert.match(main, /content-length[\s\S]{0,900}sendUpdateProgress\(\{ percent \}\)/,
    "and turns bytes received into a percentage");
  assert.match(main, /if \(percent !== lastSent\)/, "one message per whole percent, not per chunk");
  assert.match(main, /downloadUpdateDmg\(asset\.url\)[\s\S]{0,600}installPackagedUpdate\(\{ dmgPath/,
    "download first, then install what it produced");

  // The report has to cost no layout: the reviewer is mid-review, and the update is not what they are doing.
  // It draws on the rail's mark, which is one per app — the review view's was one per open workspace.
  const shell = readFileSync(new URL("../src/shell-pages.ts", import.meta.url), "utf8");
  assert.match(shell, /classList\.toggle\('is-updating',on\)/, "the rail's brand mark carries the progress");
  assert.match(shell, /setProperty\('--update-progress',pct\+'%'\)/, "as one percentage custom property");
  assert.match(shell, /#railver\.is-updating::before[\s\S]{0,400}conic-gradient\(#4d86d9 var\(--update-progress/,
    "drawn as a ring that sweeps around the mark");
  assert.match(shell, /mask:radial-gradient\(circle closest-side,transparent 0 64%/,
    "a ring sized off the mark, so the logo stays readable under it and it cannot spill onto the version text");
  assert.match(main, /shellWindow\.webContents\.send\("kakapo:update-progress"/, "and only the rail is told");
});

// One new version, one indicator. It used to be three — a titlebar chip, a sidebar-footer flag, and the
// Settings line — all saying the same two words in the same window at the same time.
test("an available update shows in exactly one place: a dot on the rail's gear", () => {
  const shell = readFileSync(new URL("../src/shell-pages.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(shell, /id="settings-dot" class="hidden"/, "the badge starts hidden");
  assert.match(shell, /dot\.classList\.remove\("hidden"\)/, "and only a newer release reveals it");
  assert.doesNotMatch(shell, /update-chip/, "no titlebar chip");
  assert.doesNotMatch(render, /app-update-flag/, "no sidebar-footer flag");
});
