// node-pty's macOS prebuild ships `spawn-helper` without the executable bit (it's lost in the npm
// tarball), so a fresh GLOBAL install fails with "posix_spawnp failed" the instant the integrated
// terminal tries to start a shell — there is no build/Release fallback in a published install, only the
// prebuild. (A local source build keeps +x, which is why it only reproduces for end users.) Restore +x
// on every spawn-helper we can find: each prebuild arch dir plus any local source build. Idempotent and
// best-effort — it never throws so it can't break `npm install`.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let ptyDir;
try {
  ptyDir = dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0); // node-pty not installed (e.g. a non-Electron context) — nothing to fix
}

const targets = [join(ptyDir, "build", "Release", "spawn-helper")];
const prebuilds = join(ptyDir, "prebuilds");
if (existsSync(prebuilds)) {
  for (const arch of readdirSync(prebuilds)) {
    targets.push(join(prebuilds, arch, "spawn-helper"));
  }
}

for (const file of targets) {
  try {
    if (existsSync(file)) chmodSync(file, 0o755);
  } catch {
    /* best-effort: a failed chmod just means the terminal may not start; don't fail the install */
  }
}
