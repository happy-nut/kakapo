import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Updating the PACKAGED app is a different channel from updating the CLI. `npm i -g` (self-update.ts)
// replaces the global kakapo command, which is the right answer when that is what you launched — but it
// never touches /Applications/Kakapo.app, so a reviewer running the bundle would press Update, see it
// succeed, and still be on the old version forever. The bundle's channel is the DMG attached to the GitHub
// release, and this module is that path: find the asset, stage it, swap it in, relaunch.

export type ReleaseAsset = { name: string; url: string };

/** Semver-ish compare, tolerant of a leading v and of pre-release suffixes we do not publish. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (value: string) => String(value).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The DMG built for THIS machine. The release carries a macOS arm64 dmg plus Linux tarballs, so an Intel
 * Mac or a Linux box must not be handed the arm64 bundle — better no automatic update than one that
 * installs an app that cannot run.
 */
export function macDmgAsset(assets: ReleaseAsset[], arch: string = process.arch): ReleaseAsset | undefined {
  if (arch !== "arm64") return undefined;
  return assets.find((asset) => /\.dmg$/i.test(asset.name) && /arm64/i.test(asset.name));
}

/**
 * Where the running bundle lives, given any path inside it. app.getPath("exe") points at
 * <bundle>/Contents/MacOS/<name>; the thing to replace is the .app directory itself.
 */
export function bundlePathFor(execPath: string): string | undefined {
  const match = execPath.match(/^(.*\.app)\/Contents\/MacOS\//);
  return match ? match[1] : undefined;
}

/**
 * Replacing a bundle from inside itself cannot work: the swap has to happen after this process is gone.
 * So the update is handed to a detached script that waits for our PID to disappear, moves the old bundle
 * aside, copies the staged one into place, and relaunches. The old bundle is only deleted once the new one
 * is in place — if the copy fails, the script puts the original back rather than leaving no app at all.
 */
export function swapScript(options: { pid: number; staged: string; installed: string; backup: string }): string {
  const { pid, staged, installed, backup } = options;
  return [
    "#!/bin/sh",
    "set -e",
    `for i in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.1; done`,
    `rm -rf ${JSON.stringify(backup)}`,
    `if [ -d ${JSON.stringify(installed)} ]; then mv ${JSON.stringify(installed)} ${JSON.stringify(backup)}; fi`,
    `if /usr/bin/ditto ${JSON.stringify(staged)} ${JSON.stringify(installed)}; then`,
    `  rm -rf ${JSON.stringify(backup)}`,
    "else",
    `  rm -rf ${JSON.stringify(installed)}`,
    `  if [ -d ${JSON.stringify(backup)} ]; then mv ${JSON.stringify(backup)} ${JSON.stringify(installed)}; fi`,
    "fi",
    `/usr/bin/open -a ${JSON.stringify(installed)}`,
    "",
  ].join("\n");
}

export type PackagedUpdateResult = { ok: boolean; error?: string };

/**
 * Download the release DMG, mount it, copy the app out, and hand the swap to the detached script above.
 * Returns only on failure — on success the caller quits so the script can take over.
 */
export function installPackagedUpdate(options: {
  assetUrl: string;
  installed: string;
  pid?: number;
  quit: () => void;
}): PackagedUpdateResult {
  const { assetUrl, installed } = options;
  // An app the user cannot write to (a managed /Applications, a read-only volume) has to be updated by
  // hand; failing here is honest, and the settings panel names the download instead.
  try {
    accessSync(installed, constants.W_OK);
  } catch {
    return { ok: false, error: `${installed} is not writable` };
  }

  const work = mkdtempSync(join(tmpdir(), "kakapo-update-"));
  const dmg = join(work, "kakapo.dmg");
  const mount = join(work, "mnt");
  const staged = join(work, "Kakapo.app");

  const run = (command: string, args: string[]): { ok: boolean; error?: string } => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) return { ok: true };
    return { ok: false, error: (result.stderr || result.stdout || `${command} failed`).trim().slice(0, 400) };
  };

  const download = run("/usr/bin/curl", ["-fsSL", "--retry", "2", "-o", dmg, assetUrl]);
  if (!download.ok) return download;

  const attach = run("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-quiet", "-mountpoint", mount]);
  if (!attach.ok) return attach;
  try {
    const source = join(mount, "Kakapo.app");
    if (!existsSync(join(source, "Contents", "MacOS"))) return { ok: false, error: "the disk image has no Kakapo.app" };
    const copy = run("/usr/bin/ditto", [source, staged]);
    if (!copy.ok) return copy;
  } finally {
    spawnSync("/usr/bin/hdiutil", ["detach", mount, "-quiet"], { encoding: "utf8" });
  }

  const script = join(work, "swap.sh");
  writeFileSync(script, swapScript({
    pid: options.pid ?? process.pid,
    staged,
    installed,
    backup: `${installed}.old`,
  }));
  chmodSync(script, 0o755);
  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
  child.unref();
  options.quit();
  return { ok: true };
}
