import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const APP_DISPLAY_NAME = "Kakapo";
const APP_EXECUTABLE_NAME = "kakapo";
const APP_BUNDLE_ID = "dev.happynut.kakapo";
const OLD_APP_NAME = "Electron";
const APP_BUNDLE = APP_DISPLAY_NAME + ".app";
const LEGACY_APP_BUNDLES = [OLD_APP_NAME + ".app", APP_EXECUTABLE_NAME + ".app"];

// Electron ships Electron.app with bundle name + executable "Electron", which is what macOS shows in
// the Dock / Cmd+Tab. The npm `kakapo` model spawns node_modules/electron's executable directly (not a
// packaged .app), and a directly-spawned GUI process takes its switcher/Dock name from the *executable*
// name and LaunchServices cache identity. So we rename Electron.app + its executable, patch the bundle
// id/name metadata, and repoint electron's path.txt at the branded binary.
function electronRoot() {
  if (process.env.KAKAPO_ELECTRON_ROOT) return process.env.KAKAPO_ELECTRON_ROOT;
  if (process.platform !== "darwin") return null;
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve("electron/package.json"));
  } catch {
    return null; // electron not installed
  }
}

function setPlistString(plist, key, value) {
  const pattern = new RegExp("(<key>" + key + "</key>\\s*<string>)[^<]*(</string>)");
  if (pattern.test(plist)) {
    return plist.replace(pattern, (_match, prefix, suffix) => prefix + value + suffix);
  }
  return plist.replace("</dict>", "\t<key>" + key + "</key>\n\t<string>" + value + "</string>\n</dict>");
}

function registerBundle(appDir) {
  if (process.env.KAKAPO_SKIP_LSREGISTER === "1") return;
  spawnSync(
    "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
    ["-f", appDir],
    { stdio: "ignore" },
  );
}

function findAppBundleEntry(distDir) {
  try {
    const entries = readdirSync(distDir);
    return [APP_BUNDLE, ...LEGACY_APP_BUNDLES].find((bundle) => entries.includes(bundle)) ?? null;
  } catch {
    return null;
  }
}

function main() {
  const root = electronRoot();
  if (!root) return; // not macOS, or electron missing — nothing to do
  const distDir = join(root, "dist");
  const newAppDir = join(root, "dist", APP_BUNDLE);
  const appBundleEntry = findAppBundleEntry(distDir);
  const pathTxt = join(root, "path.txt");
  if (!appBundleEntry) {
    console.warn('kakapo: Electron.app not found under ' + distDir + ' — skipping rebrand (Dock/menu may show "Electron")');
    return;
  }

  try {
    let changed = false;
    let appDir = join(distDir, appBundleEntry);

    // 1. Rename the app bundle directory itself. Leaving Electron.app on disk can keep LaunchServices keyed
    // to Electron even after CFBundleName is patched. The temp hop makes case-only renames reliable on
    // macOS's common case-insensitive volumes (kakapo.app -> Kakapo.app).
    if (appBundleEntry !== APP_BUNDLE) {
      const tmpAppDir = join(distDir, ".kakapo-app-rename-" + process.pid + "-" + Date.now());
      renameSync(appDir, tmpAppDir);
      renameSync(tmpAppDir, newAppDir);
      appDir = newAppDir;
      changed = true;
    }

    const plistPath = join(appDir, "Contents", "Info.plist");
    const macosDir = join(appDir, "Contents", "MacOS");
    const oldExe = join(macosDir, OLD_APP_NAME);
    const newExe = join(macosDir, APP_EXECUTABLE_NAME);
    if (!existsSync(plistPath)) {
      console.warn('kakapo: Info.plist not found at ' + plistPath + ' — skipping rebrand (Dock/menu may show "Electron")');
      return;
    }

    // 2. Bundle metadata: display name -> Kakapo, executable -> kakapo, bundle id -> kakapo.
    const before = readFileSync(plistPath, "utf8");
    const after = [
      ["CFBundleName", APP_DISPLAY_NAME],
      ["CFBundleDisplayName", APP_DISPLAY_NAME],
      ["CFBundleExecutable", APP_EXECUTABLE_NAME],
      ["CFBundleIdentifier", APP_BUNDLE_ID],
    ].reduce((plist, [key, value]) => setPlistString(plist, key, value), before);
    if (after !== before) { writeFileSync(plistPath, after); changed = true; }

    // 3. Rename the executable so the directly-spawned process is "kakapo" (idempotent).
    if (existsSync(oldExe) && !existsSync(newExe)) { renameSync(oldExe, newExe); changed = true; }

    // 4. Repoint electron's path.txt at the renamed binary so require("electron") resolves it.
    if (existsSync(pathTxt)) {
      const pt = readFileSync(pathTxt, "utf8");
      const fixed = APP_BUNDLE + "/Contents/MacOS/" + APP_EXECUTABLE_NAME;
      if (fixed !== pt) { writeFileSync(pathTxt, fixed); changed = true; }
    }

    // Only when something actually changed: refresh LaunchServices so the Dock / Cmd+Tab show "kakapo"
    // instead of a cached "Electron". Skipping it when already-branded keeps the startup re-run cheap.
    if (changed) {
      registerBundle(appDir);
      console.log('kakapo: branded Electron app as "' + APP_DISPLAY_NAME + '"');
    }
  } catch (e) {
    // Surface the reason (perms / read-only) instead of failing SILENTLY — otherwise the Dock/Cmd+Tab/menu
    // keep showing "Electron" with no hint why. Non-fatal: the CLI launcher retries before spawning Electron.
    console.warn('kakapo: could not rebrand the Electron app to "' + APP_DISPLAY_NAME + '". Dock/Cmd+Tab/menu may stay "Electron". Reason: ' + (e && e.message ? e.message : e));
  }
}

main();
