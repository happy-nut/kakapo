import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const APP_NAME = "monacori";

// Electron ships its prebuilt Electron.app with the bundle name "Electron",
// which is what macOS shows in the Dock and Cmd+Tab when we launch it directly
// (the npm `mo` model runs node_modules/electron, not a packaged .app).
// app.setName() only affects the menu and notifications, so we patch the bundle
// metadata here. CFBundleExecutable is the real binary name and is left alone.
function electronInfoPlist() {
  if (process.platform !== "darwin") return null;
  const require = createRequire(import.meta.url);
  let root;
  try {
    root = dirname(require.resolve("electron/package.json"));
  } catch {
    return null;
  }
  const plistPath = join(root, "dist", "Electron.app", "Contents", "Info.plist");
  return existsSync(plistPath) ? plistPath : null;
}

function main() {
  const plistPath = electronInfoPlist();
  if (!plistPath) return; // not macOS, or electron not installed — nothing to do
  let contents;
  try {
    contents = readFileSync(plistPath, "utf8");
  } catch {
    return;
  }
  const patched = contents
    .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/, "$1" + APP_NAME + "$2")
    .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, "$1" + APP_NAME + "$2");
  if (patched === contents) return; // already patched, or keys absent
  try {
    writeFileSync(plistPath, patched);
    console.log('monacori: set Electron app name to "' + APP_NAME + '"');
  } catch {
    // read-only / permission-denied environments — harmless, this is a convenience step
  }
}

main();
