import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ServerCacheScope = "shared" | "worktree";

export const SERVER_CACHE_DIRECTORIES: Record<string, string> = {
  go: "kakapo-go",
  rust: "kakapo-rust",
  java: "kakapo-jdtls",
  kotlin: "kakapo-kotlin",
  ruby: "kakapo-sorbet",
  php: "kakapo-phpactor",
};

export const SERVER_CACHE_SCOPES: Record<string, ServerCacheScope> = {
  go: "shared",
  rust: "worktree",
  java: "worktree",
  kotlin: "worktree",
  ruby: "shared",
  php: "worktree",
};

export const SERVER_CACHE_INSIDE_PROJECT: Record<string, string> = {
  clang: ".cache/clangd",
};

export function isServerCacheInsideProject(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const directory of Object.values(SERVER_CACHE_INSIDE_PROJECT)) {
    if (normalized === directory) return true;
    if (normalized.startsWith(`${directory}/`)) return true;
    if (normalized.includes(`/${directory}/`)) return true;
  }
  return false;
}

export const SHARED_CACHE_KEY = "shared";

export const RECLAIM_UNUSED_DAYS = 7;
const RECLAIM_PER_RUN = 256;

export function serverCacheKey(family: string, root: string): string {
  if (SERVER_CACHE_SCOPES[family] === "shared") return SHARED_CACHE_KEY;
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

export function serverCacheDirectory(family: string, root: string, base: string = tmpdir()): string {
  const directory = SERVER_CACHE_DIRECTORIES[family];
  if (!directory) throw new Error(`no language-server cache directory is declared for "${family}"`);
  return join(base, directory, serverCacheKey(family, root));
}

export function markServerCacheUsed(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true });
    const now = new Date();
    utimesSync(directory, now, now);
  } catch { }
}

export function reclaimableServerCaches(
  options: { base?: string; unusedForDays?: number; now?: number; limit?: number } = {},
): string[] {
  const base = options.base ?? tmpdir();
  const days = options.unusedForDays ?? RECLAIM_UNUSED_DAYS;
  const cutoff = (options.now ?? Date.now()) - days * 86_400_000;
  const limit = options.limit ?? RECLAIM_PER_RUN;
  const stale: Array<{ path: string; mtimeMs: number }> = [];
  for (const directory of Object.values(SERVER_CACHE_DIRECTORIES)) {
    let keys: string[];
    try { keys = readdirSync(join(base, directory)); } catch { continue; }
    for (const key of keys) {
      const candidate = join(base, directory, key);
      try {
        const info = statSync(candidate);
        if (info.isDirectory() && info.mtimeMs < cutoff) stale.push({ path: candidate, mtimeMs: info.mtimeMs });
      } catch { }
    }
  }
  stale.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return stale.slice(0, limit).map((entry) => entry.path);
}

function makeTreeWritable(directory: string): void {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop() as string;
    let entries: string[];
    try {
      chmodSync(current, 0o700);
      entries = readdirSync(current);
    } catch { continue; }
    for (const entry of entries) {
      const candidate = join(current, entry);
      try {
        if (statSync(candidate).isDirectory()) pending.push(candidate);
      } catch { }
    }
  }
}

export async function removeServerCache(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
    return;
  } catch { }
  makeTreeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

export async function reclaimServerCaches(
  options: { base?: string; unusedForDays?: number; now?: number; limit?: number } = {},
): Promise<string[]> {
  const reclaimed: string[] = [];
  for (const directory of reclaimableServerCaches(options)) {
    try {
      await removeServerCache(directory);
      reclaimed.push(directory);
    } catch { }
  }
  return reclaimed;
}
