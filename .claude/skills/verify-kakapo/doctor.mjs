#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PORT, REPO } from "./drive.mjs";

const harness = await import(join(REPO, "scripts/lib/app-harness.mjs"));
const { checkoutElectronPids, portHolder, readyPage } = harness;

let bad = 0;
const say = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) bad += 1;
};

const built = existsSync(join(REPO, "dist/app-main.js"));
say(built, "dist is built", built ? "" : "run `npm run build`");
if (built) {
  const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((max, entry) => {
    const path = join(dir, entry.name);
    return Math.max(max, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }, 0);
  const src = newest(join(REPO, "src"));
  const dist = statSync(join(REPO, "dist/app-main.js")).mtimeMs;
  say(dist >= src, "the build is not older than src", dist >= src ? "" : "run `npm run build`");
}
const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
console.log(`     checkout ${REPO} @ v${version}`);

const holder = portHolder(PORT);

const pids = checkoutElectronPids();
if (!pids.length) {
  say(!holder, `port ${PORT} is free`, holder ? `held by ${holder}` : "");
  say(true, "no Kakapo from this checkout is running", "a drive can launch its own");
} else {
  console.log(`     a Kakapo from this checkout is running (pid ${pids.join(", ")})`);
  const page = await Promise.race([
    readyPage(8000),
    new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
  ]);
  say(Boolean(page), "its page answers on the debugger port and the viewer is loaded",
    page ? "" : `nothing ready on ${PORT}${holder ? ` (held by ${holder})` : ""} — it was launched without KAKAPO_REMOTE_DEBUG, or it is wedged`);
  if (page) {
    const where = await page.evaluate(`window.kakapoComments.read().then(r => r.path)`).catch(() => "");
    say(Boolean(where), "it says which repository it is reviewing", where || "the comments bridge did not answer");

    const plain = pids.filter((pid) => {
      try { return !/\bKAKAPO_DEV=1\b/.test(execFileSync("ps", ["eww", "-p", pid], { encoding: "utf8" })); }
      catch { return true; }
    });
    say(plain.length === 0, "and every process of ours was started with KAKAPO_DEV=1, so user-data is isolated",
      plain.length === 0 ? "" : `pid ${plain.join(", ")} is using the REAL user-data directory — do not drive it, and do not trust what it leaves behind`);
    page.close();
  }
}

process.exit(bad ? 1 : 0);
