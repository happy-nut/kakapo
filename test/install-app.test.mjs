// `kakapo install-app` — the npm install ships a CLI and nothing else, so kakapo has no icon in Spotlight,
// Launchpad or the Dock. This builds a launcher bundle that opens the SAME installed CLI, so there is never
// a second copy to go stale. A command, not a postinstall step: an npm package writing into /Applications
// behind your back needs a password and leaves something `npm uninstall` will not take with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationsBundlePath, installApp, uninstallApp } from "../dist/install-app.js";

const darwinOnly = { skip: process.platform !== "darwin" ? "macOS app bundles" : false };

function stage() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-install-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "kakapo.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "icon.icns"), "icns");
  return root;
}

test("the bundle is a launcher for the installed CLI, not a copy of the app", darwinOnly, () => {
  const root = stage();
  const bundle = join(root, "Kakapo.app");
  try {
    const result = installApp({
      bundlePath: bundle, nodePath: "/usr/local/bin/node",
      cliPath: join(root, "bin", "kakapo.js"), iconPath: join(root, "icon.icns"), version: "1.2.3",
    });
    assert.equal(result.replaced, false, "a first install is not a replacement");

    const exec = join(bundle, "Contents", "MacOS", "kakapo-launcher");
    const script = readFileSync(exec, "utf8");
    assert.match(script, /^exec "\/usr\/local\/bin\/node" ".*bin\/kakapo\.js" "\$@"$/m,
      "it execs the CLI through the node that installed it — a GUI launch inherits no PATH");
    assert.ok(statSync(exec).mode & 0o111, "and is executable");

    const plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>kakapo-launcher<\/string>/);
    assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>1\.2\.3<\/string>/, "it carries the CLI's version");
    assert.match(plist, /<key>LSUIElement<\/key><true\/>/, "the launcher hands off and exits, so it keeps its own icon out of the Dock");
    assert.ok(existsSync(join(bundle, "Contents", "Resources", "icon.icns")), "the icon comes along");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installing over an existing bundle replaces it, and uninstall removes it", darwinOnly, () => {
  const root = stage();
  const bundle = join(root, "Kakapo.app");
  const args = { bundlePath: bundle, nodePath: "/usr/bin/node", cliPath: join(root, "bin", "kakapo.js"), iconPath: join(root, "icon.icns") };
  try {
    installApp(args);
    assert.equal(installApp(args).replaced, true, "a re-run reports that it replaced the old bundle");
    assert.equal(uninstallApp(bundle), true);
    assert.equal(existsSync(bundle), false, "and the bundle is gone");
    assert.equal(uninstallApp(bundle), false, "removing what is not there is not an error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing CLI is reported instead of producing a bundle that opens nothing", darwinOnly, () => {
  const root = stage();
  try {
    assert.throws(
      () => installApp({ bundlePath: join(root, "Kakapo.app"), cliPath: join(root, "bin", "gone.js") }),
      /Cannot find the kakapo CLI/,
    );
    assert.equal(existsSync(join(root, "Kakapo.app")), false, "and nothing is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("it prefers ~/Applications, which needs no password, and falls back to the system folder", darwinOnly, () => {
  const home = mkdtempSync(join(tmpdir(), "kakapo-home-"));
  try {
    assert.equal(applicationsBundlePath(home), "/Applications/Kakapo.app", "no ~/Applications yet");
    mkdirSync(join(home, "Applications"));
    assert.equal(applicationsBundlePath(home), join(home, "Applications", "Kakapo.app"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
