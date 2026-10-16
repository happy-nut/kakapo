#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

export function createMacDmg({
  platform = process.platform,
  appPath = join(repoRoot, "release", "Kakapo-darwin-arm64", "Kakapo.app"),
  outputPath,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("Kakapo DMG creation requires macOS and the built-in hdiutil command.");
  }
  if (!existsSync(appPath)) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const dmgPath = resolve(outputPath || join(repoRoot, "release", `Kakapo-${pkg.version}-arm64.dmg`));
  const stagingDir = mkdtempSync(join(tmpdir(), "kakapo-dmg-"));

  mkdirSync(dirname(dmgPath), { recursive: true });
  rmSync(dmgPath, { force: true });

  // The bundle's own `kakapo` command. electron-packager copies bin/ verbatim, and a copy that lost its
  // exec bit would be a Homebrew cask linking a file nobody can run — so set it here, where the bundle that
  // actually ships is in hand, rather than trusting the copy.
  const bundledCli = join(resolve(appPath), "Contents", "Resources", "app", "bin", "kakapo-bundled.sh");
  if (existsSync(bundledCli)) chmodSync(bundledCli, 0o755);

  try {
    run("ditto", [resolve(appPath), join(stagingDir, basename(appPath))]);
    symlinkSync("/Applications", join(stagingDir, "Applications"));
    run("hdiutil", [
      "create",
      "-volname", "Kakapo",
      "-srcfolder", stagingDir,
      "-ov",
      "-format", "UDZO",
      dmgPath,
    ]);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  process.stdout.write(`Created ${relative(repoRoot, dmgPath)}\n`);
  return dmgPath;
}

if (resolve(process.argv[1] || "") === scriptPath) {
  const [appPath, outputPath] = process.argv.slice(2);
  createMacDmg({
    appPath: appPath ? resolve(appPath) : undefined,
    outputPath: outputPath ? resolve(outputPath) : undefined,
  });
}
