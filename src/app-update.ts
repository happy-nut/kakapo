import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ReleaseAsset = { name: string; url: string };

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

export function macDmgAsset(assets: ReleaseAsset[], arch: string = process.arch): ReleaseAsset | undefined {
  if (arch !== "arm64") return undefined;
  return assets.find((asset) => /\.dmg$/i.test(asset.name) && /arm64/i.test(asset.name));
}

export function bundlePathFor(execPath: string): string | undefined {
  const match = execPath.match(/^(.*\.app)\/Contents\/MacOS\//);
  return match ? match[1] : undefined;
}

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

export function installPackagedUpdate(options: {
  dmgPath: string;
  installed: string;
  pid?: number;
  quit: () => void;
}): PackagedUpdateResult {
  const { dmgPath, installed } = options;
  try {
    accessSync(installed, constants.W_OK);
  } catch {
    return { ok: false, error: `${installed} is not writable` };
  }

  const work = mkdtempSync(join(tmpdir(), "kakapo-update-"));
  const dmg = dmgPath;
  const mount = join(work, "mnt");
  const staged = join(work, "Kakapo.app");

  const run = (command: string, args: string[]): { ok: boolean; error?: string } => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) return { ok: true };
    return { ok: false, error: (result.stderr || result.stdout || `${command} failed`).trim().slice(0, 400) };
  };

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
