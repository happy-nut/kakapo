import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchScript = join(repoRoot, "scripts", "patch-electron-name.mjs");
const expectedElectronPath = "Monacori.app/Contents/MacOS/monacori";

function plist({
  name = "Electron",
  displayName = "Electron",
  executable = "Electron",
  identifier = "com.github.Electron",
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>${name}</string>
\t<key>CFBundleDisplayName</key>
\t<string>${displayName}</string>
\t<key>CFBundleExecutable</key>
\t<string>${executable}</string>
\t<key>CFBundleIdentifier</key>
\t<string>${identifier}</string>
</dict>
</plist>
`;
}

function makeElectronRoot({
  appBundle = "Electron.app",
  executable = "Electron",
  bundleName = "Electron",
  bundleDisplayName = "Electron",
  bundleExecutable = executable,
  bundleIdentifier = "com.github.Electron",
  pathTxt = appBundle + "/Contents/MacOS/" + executable,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "monacori-electron-name-"));
  const appDir = join(root, "dist", appBundle);
  mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(appDir, "Contents", "Info.plist"), plist({
    name: bundleName,
    displayName: bundleDisplayName,
    executable: bundleExecutable,
    identifier: bundleIdentifier,
  }));
  writeFileSync(join(appDir, "Contents", "MacOS", executable), "");
  writeFileSync(join(root, "path.txt"), pathTxt);
  return { root, appDir };
}

function runPatch(root) {
  return spawnSync(process.execPath, [patchScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONACORI_ELECTRON_ROOT: root,
      MONACORI_SKIP_LSREGISTER: "1",
    },
  });
}

function assertBranded(root) {
  const brandedApp = join(root, "dist", "Monacori.app");
  const patchedPlist = readFileSync(join(brandedApp, "Contents", "Info.plist"), "utf8");
  const distEntries = readdirSync(join(root, "dist"));

  assert.equal(distEntries.includes("Electron.app"), false, "Electron.app is renamed");
  assert.equal(distEntries.includes("monacori.app"), false, "legacy monacori.app is renamed");
  assert.equal(distEntries.includes("Monacori.app"), true, "Monacori.app exists");
  assert.equal(existsSync(join(brandedApp, "Contents", "MacOS", "monacori")), true, "executable is renamed");
  assert.equal(readFileSync(join(root, "path.txt"), "utf8"), expectedElectronPath);
  assert.match(patchedPlist, /<key>CFBundleName<\/key>\s*<string>Monacori<\/string>/);
  assert.match(patchedPlist, /<key>CFBundleDisplayName<\/key>\s*<string>Monacori<\/string>/);
  assert.match(patchedPlist, /<key>CFBundleExecutable<\/key>\s*<string>monacori<\/string>/);
  assert.match(patchedPlist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.happynut\.monacori<\/string>/);
}

test("patch-electron-name rebrands a stock directly-spawned Electron app", () => {
  const { root } = makeElectronRoot();

  try {
    const result = runPatch(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertBranded(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch-electron-name completes the partial 0.1.25 rebrand state", () => {
  const { root } = makeElectronRoot({
    executable: "monacori",
    bundleName: "monacori",
    bundleDisplayName: "monacori",
    bundleExecutable: "monacori",
    bundleIdentifier: "com.github.Electron",
    pathTxt: "Electron.app/Contents/MacOS/monacori",
  });

  try {
    const result = runPatch(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertBranded(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch-electron-name repairs a branded plist with the old Electron executable", () => {
  const { root } = makeElectronRoot({
    executable: "Electron",
    bundleName: "Monacori",
    bundleDisplayName: "Monacori",
    bundleExecutable: "monacori",
    bundleIdentifier: "dev.happynut.monacori",
    pathTxt: "Electron.app/Contents/MacOS/Electron",
  });

  try {
    const result = runPatch(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertBranded(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch-electron-name upgrades a lowercase branded bundle", () => {
  const { root } = makeElectronRoot({
    appBundle: "monacori.app",
    executable: "monacori",
    bundleName: "monacori",
    bundleDisplayName: "monacori",
    bundleExecutable: "monacori",
    bundleIdentifier: "dev.happynut.monacori",
    pathTxt: "monacori.app/Contents/MacOS/monacori",
  });

  try {
    const result = runPatch(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertBranded(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch-electron-name is stable on an already branded install", () => {
  const { root } = makeElectronRoot({
    appBundle: "Monacori.app",
    executable: "monacori",
    bundleName: "Monacori",
    bundleDisplayName: "Monacori",
    bundleExecutable: "monacori",
    bundleIdentifier: "dev.happynut.monacori",
    pathTxt: expectedElectronPath,
  });

  try {
    const result = runPatch(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "", "no rebrand message when nothing changed");
    assertBranded(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
