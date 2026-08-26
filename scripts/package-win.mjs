#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

export const SUPPORTED_WINDOWS_ARCHES = Object.freeze(["x64", "arm64"]);

export function normalizeWindowsArch(value = process.arch) {
  const arch = String(value || "").trim().toLowerCase();
  if (!SUPPORTED_WINDOWS_ARCHES.includes(arch)) {
    throw new Error(`Unsupported Windows architecture: ${value}. Expected x64 or arm64.`);
  }
  return arch;
}

export function windowsBundleName(arch) {
  return `Kakapo-win32-${normalizeWindowsArch(arch)}`;
}

export function windowsArchiveName(version, arch) {
  return `Kakapo-${version}-windows-${normalizeWindowsArch(arch)}.zip`;
}

export function windowsRipgrepPackageName(arch) {
  return `@vscode/ripgrep-win32-${normalizeWindowsArch(arch)}`;
}

export function assertNativeWindowsTarget({
  platform = process.platform,
  hostArch = process.arch,
  targetArch = process.arch,
} = {}) {
  const normalizedTarget = normalizeWindowsArch(targetArch);
  if (platform !== "win32" || normalizeWindowsArch(hostArch) !== normalizedTarget) {
    throw new Error(
      `Kakapo Windows ${normalizedTarget} packages must be built on native Windows ${normalizedTarget}. `
      + "Cross-packaging can omit platform-specific runtime dependencies such as ripgrep.",
    );
  }
  return normalizedTarget;
}

// Windows ships only the Node-hosted language servers (TypeScript, Python); the native sidecar
// bundle (go/rust/clangd/jdtls/kotlin/sorbet/php) has no pinned Windows archives yet, and the app
// degrades gracefully to PATH-installed servers or the regex index for those families.
export function verifyWindowsLanguageServers(appRoot) {
  const nodeServers = {
    typescript: join(appRoot, "node_modules", "typescript-language-server", "lib", "cli.mjs"),
    python: join(appRoot, "node_modules", "pyright", "langserver.index.js"),
  };
  const missing = Object.entries(nodeServers)
    .filter(([, path]) => !existsSync(path))
    .map(([family, path]) => `${family}: ${path}`);
  if (missing.length) throw new Error(`Packaged Node language servers are missing:\n${missing.join("\n")}`);
  for (const path of Object.values(nodeServers)) accessSync(path, constants.R_OK);
  return true;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

/** Build one self-contained Windows desktop bundle and its release archive. */
export function packageWindows({
  arch = process.arch,
  platform = process.platform,
  hostArch = process.arch,
  repoRoot = defaultRepoRoot,
  outputRoot = join(repoRoot, "release"),
  runCommand = run,
} = {}) {
  const targetArch = assertNativeWindowsTarget({ platform, hostArch, targetArch: arch });
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const bundleName = windowsBundleName(targetArch);
  const bundlePath = join(outputRoot, bundleName);
  const executablePath = join(bundlePath, "Kakapo.exe");
  const archivePath = join(outputRoot, windowsArchiveName(packageJson.version, targetArch));
  // Not the .bin shim: spawning a .cmd without a shell is EINVAL on modern Node (CVE-2024-27980).
  const packager = join(repoRoot, "node_modules", "@electron", "packager", "bin", "electron-packager.mjs");

  if (!existsSync(packager)) {
    throw new Error("electron-packager is unavailable. Run npm ci before packaging Kakapo for Windows.");
  }

  mkdirSync(outputRoot, { recursive: true });
  rmSync(bundlePath, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  runCommand(process.execPath, [
    packager,
    ".", "Kakapo",
    "--platform=win32",
    `--arch=${targetArch}`,
    "--icon=assets/icon.ico",
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
    throw new Error(`Windows package did not contain the Kakapo executable: ${executablePath}`);
  }
  const ripgrepPath = join(
    bundlePath,
    "resources", "app", "node_modules", "@vscode", `ripgrep-win32-${targetArch}`,
  );
  if (!existsSync(ripgrepPath)) {
    throw new Error(
      `Windows package did not contain ${windowsRipgrepPackageName(targetArch)}. `
      + "Reinstall dependencies on the target Windows architecture before packaging.",
    );
  }
  verifyWindowsLanguageServers(join(bundlePath, "resources", "app"));

  // Windows 10+ bsdtar creates real zip archives with -a; keeps the script dependency-free.
  runCommand("tar", ["-C", outputRoot, "-a", "-c", "-f", archivePath, bundleName], repoRoot);
  process.stdout.write(`Created ${relative(repoRoot, archivePath)}\n`);

  return { arch: targetArch, bundlePath, executablePath, archivePath };
}

if (resolve(process.argv[1] || "") === scriptPath) {
  packageWindows({ arch: process.argv[2] || process.arch });
}
