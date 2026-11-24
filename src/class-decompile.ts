import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readArchiveEntry } from "./archive-source.js";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_BUNDLE_ROOT = join(APP_ROOT, "vendor", "language-servers");
const JAVA_HOME_DIR_NAMES = ["jdk", "jre"];
const MAX_CLASS_BYTES = 8 * 1024 * 1024;
const DECOMPILE_TIMEOUT_MS = 20_000;

export function splitClassUri(uri: string): { archive: string; entry: string } | null {
  const text = String(uri || "");
  if (!/\.class$/i.test(text)) return null;
  const withoutScheme = text.replace(/^jar:/i, "").replace(/^file:\/\//i, "");
  const path = withoutScheme.startsWith("///") ? withoutScheme.slice(2) : withoutScheme;
  const bang = path.indexOf("!/");
  if (bang < 0) return null;
  const archive = decodeURI(path.slice(0, bang));
  const entry = decodeURI(path.slice(bang + 2));
  return /\.(jar|zip)$/i.test(archive) && entry ? { archive, entry } : null;
}

function bundleBase(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string): string {
  return join(env.KAKAPO_LSP_BUNDLE_ROOT || DEFAULT_BUNDLE_ROOT, `${platform}-${arch}`, "java");
}

export function bundledJavaBinary(env = process.env, platform = process.platform, arch = process.arch): string | undefined {
  const base = bundleBase(env, platform, arch);
  for (const home of JAVA_HOME_DIR_NAMES) {
    const java = join(base, home, "bin", "java");
    if (existsSync(java)) return java;
  }
  return undefined;
}

export function bundledDecompilerJar(env = process.env, platform = process.platform, arch = process.arch): string | undefined {
  const plugins = join(bundleBase(env, platform, arch), "jdtls", "plugins");
  try {
    const jar = readdirSync(plugins).find((name) => /java-decompiler-engine.*\.jar$/.test(name));
    return jar ? join(plugins, jar) : undefined;
  } catch {
    return undefined;
  }
}

const cache = new Map<string, string | undefined>();

export function decompiledClassText(uri: string, env = process.env): string | undefined {
  const split = splitClassUri(uri);
  if (!split) return undefined;
  const java = bundledJavaBinary(env);
  const decompiler = bundledDecompilerJar(env);
  if (!java || !decompiler) return undefined;
  const archive = readArchiveEntry(`${split.archive}!/${split.entry}`, MAX_CLASS_BYTES);
  if (!archive) return undefined;
  const key = `${split.archive}:${archive.mtimeMs}:${split.entry}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const scratch = mkdtempSync(join(tmpdir(), "kakapo-decompile-"));
  try {
    const name = basename(split.entry);
    const input = join(scratch, name);
    const output = join(scratch, "out");
    mkdirSync(output, { recursive: true });
    writeFileSync(input, archive.bytes);
    execFileSync(java, [
      "-cp", decompiler,
      "org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler",
      "-dgs=1",
      input,
      output,
    ], { stdio: "ignore", timeout: DECOMPILE_TIMEOUT_MS });
    const produced = readdirSync(output).find((file) => file.endsWith(".java"));
    const text = produced ? readFileSync(join(output, produced), "utf8") : undefined;
    cache.set(key, text);
    return text;
  } catch {
    cache.set(key, undefined);
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function resetDecompiledClassCache(): void {
  cache.clear();
}
