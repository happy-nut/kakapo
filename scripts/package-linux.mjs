#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

export const SUPPORTED_LINUX_ARCHES = Object.freeze(["x64", "arm64"]);

export function normalizeLinuxArch(value = process.arch) {
  const arch = String(value || "").trim().toLowerCase();
  if (!SUPPORTED_LINUX_ARCHES.includes(arch)) {
    throw new Error(`Unsupported Linux architecture: ${value}. Expected x64 or arm64.`);
  }
  return arch;
}

export function linuxBundleName(arch) {
  return `Kakapo-linux-${normalizeLinuxArch(arch)}`;
}

export function linuxArchiveName(version, arch) {
  return `Kakapo-${version}-linux-${normalizeLinuxArch(arch)}.tar.gz`;
}

export function linuxRipgrepPackageName(arch) {
  return `@vscode/ripgrep-linux-${normalizeLinuxArch(arch)}`;
}

export function assertNativeLinuxTarget({
  platform = process.platform,
  hostArch = process.arch,
  targetArch = process.arch,
} = {}) {
  const normalizedTarget = normalizeLinuxArch(targetArch);
  if (platform !== "linux" || normalizeLinuxArch(hostArch) !== normalizedTarget) {
    throw new Error(
      `Kakapo Linux ${normalizedTarget} packages must be built on native Linux ${normalizedTarget}. `
      + "Cross-packaging can omit platform-specific runtime dependencies such as ripgrep.",
    );
  }
  return normalizedTarget;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

/** Build one self-contained Linux desktop bundle and its release archive. */
export function packageLinux({
  arch = process.arch,
  platform = process.platform,
  hostArch = process.arch,
  repoRoot = defaultRepoRoot,
  outputRoot = join(repoRoot, "release"),
  runCommand = run,
} = {}) {
  const targetArch = assertNativeLinuxTarget({ platform, hostArch, targetArch: arch });
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const bundleName = linuxBundleName(targetArch);
  const bundlePath = join(outputRoot, bundleName);
  const executablePath = join(bundlePath, "Kakapo");
  const archivePath = join(outputRoot, linuxArchiveName(packageJson.version, targetArch));
  const packager = join(repoRoot, "node_modules", ".bin", "electron-packager");

  if (!existsSync(packager)) {
    throw new Error("electron-packager is unavailable. Run npm ci before packaging Kakapo for Linux.");
  }

  mkdirSync(outputRoot, { recursive: true });
  rmSync(bundlePath, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  runCommand(packager, [
    ".", "Kakapo",
    "--platform=linux",
    `--arch=${targetArch}`,
    "--icon=assets/icon.png",
    `--out=${outputRoot}`,
    "--overwrite",
    "--no-asar",
    "--ignore=/src/",
    "--ignore=/test/",
    "--ignore=/release/",
    "--ignore=/.git",
    "--ignore=/.github",
    "--ignore=/.omc",
    "--ignore=/node_modules/electron/",
    "--ignore=/node_modules/@electron",
    "--ignore=/node_modules/jsdom",
  ], repoRoot);

  if (!existsSync(executablePath)) {
    throw new Error(`Linux package did not contain the Kakapo executable: ${executablePath}`);
  }
  const ripgrepPath = join(
    bundlePath,
    "resources", "app", "node_modules", "@vscode", `ripgrep-linux-${targetArch}`,
  );
  if (!existsSync(ripgrepPath)) {
    throw new Error(
      `Linux package did not contain ${linuxRipgrepPackageName(targetArch)}. `
      + "Reinstall dependencies on the target Linux architecture before packaging.",
    );
  }

  runCommand("tar", ["-C", outputRoot, "-czf", archivePath, bundleName], repoRoot);
  process.stdout.write(`Created ${relative(repoRoot, archivePath)}\n`);

  return { arch: targetArch, bundlePath, executablePath, archivePath };
}

if (resolve(process.argv[1] || "") === scriptPath) {
  packageLinux({ arch: process.argv[2] || process.arch });
}
