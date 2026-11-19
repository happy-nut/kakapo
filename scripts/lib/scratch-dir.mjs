import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scratchDirectory(options = {}) {
  if (options.given) return { path: options.given, owned: false, cleanup: () => false };
  const path = mkdtempSync(join(options.base ?? tmpdir(), options.prefix ?? "scratch-"));
  let spent = false;
  const cleanup = () => {
    if (spent || options.keep) return false;
    spent = true;
    rmSync(path, { recursive: true, force: true });
    return true;
  };
  return { path, owned: true, cleanup };
}

export function removeWhenThisProcessEnds(scratch, announce = () => undefined) {
  if (!scratch.owned) return () => false;
  let ran = false;
  const run = () => {
    if (ran) return false;
    ran = true;
    const removed = scratch.cleanup();
    announce(scratch.path, removed);
    return removed;
  };
  process.on("exit", run);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { run(); process.exit(130); });
  }
  process.on("uncaughtException", (error) => { run(); console.error(error); process.exit(1); });
  process.on("unhandledRejection", (error) => { run(); console.error(error); process.exit(1); });
  return run;
}
