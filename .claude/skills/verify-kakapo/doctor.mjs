#!/usr/bin/env node
// Read-only: "can I drive this, and is it the thing I think it is?"
//
// Run it before the first drive of a session, and again after any drive that failed strangely — a
// screenshot of a frozen window and a screenshot of a working one look the same until something asks the
// page a question. It starts nothing, kills nothing and writes nothing.
//
//   node .claude/skills/verify-kakapo/doctor.mjs
//
// Exit 0 means the environment is in one of the two states a run can start from: nothing of ours is up
// (launch away), or exactly one reachable window from this checkout is up and ready (drive it). Exit 1
// means it is in neither, and says which.
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

// 1. A build to drive. dist/ is gitignored, so a fresh clone has none, and a stale one silently drives
//    yesterday's code — which is the failure that looks most like a product regression.
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

// 2. The debugger port. 9333 is a popular one; a Chrome started with --remote-debugging-port holds it and
//    the symptom is "the review page never became ready", with the real reason buried in Electron's stderr.
const holder = portHolder(PORT);

// 3. Ours, or someone else's?
const pids = checkoutElectronPids();
if (!pids.length) {
  say(!holder, `port ${PORT} is free`, holder ? `held by ${holder}` : "");
  say(true, "no Kakapo from this checkout is running", "a drive can launch its own");
} else {
  console.log(`     a Kakapo from this checkout is running (pid ${pids.join(", ")})`);
  // Bounded on this side too. readyPage polls /json/list with a bare fetch, and a half-dead instance
  // still holding the port answers the connection and then nothing — which turned this read-only check
  // into a hang, and then into an exit code that meant neither "fine" nor "not fine".
  const page = await Promise.race([
    readyPage(8000),
    new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
  ]);
  say(Boolean(page), "its page answers on the debugger port and the viewer is loaded",
    page ? "" : `nothing ready on ${PORT}${holder ? ` (held by ${holder})` : ""} — it was launched without KAKAPO_REMOTE_DEBUG, or it is wedged`);
  if (page) {
    // Which repository this window is on, asked through a bridge that only reads. The comment record is
    // NOT under the user-data mirror: it is `<root>/.git/kakapo/comments.jsonl` (or
    // `.git/worktrees/<name>/kakapo/…`), on purpose — git never tracks its own directory, and a
    // cwd-sandboxed coding agent can reach a path inside the worktree where it could not reach one under
    // Electron's userData. So this names the repository, and nothing about isolation.
    const where = await page.evaluate(`window.kakapoComments.read().then(r => r.path)`).catch(() => "");
    say(Boolean(where), "it says which repository it is reviewing", where || "the comments bridge did not answer");

    // Isolation is a property of how the process was STARTED, so ask the process, not the page. Nothing
    // the renderer can see says whether main redirected userData to <userData>/dev — and getting this
    // wrong the other way (assuming isolation that is not there) means a drive writes read marks,
    // settings and restored tabs into the operator's real reviews.
    // EVERY pid, not the first one: a stale process from an earlier run sits in this list beside the
    // live one, and asking only pids[0] answered about whichever happened to sort first. One instance of
    // ours without the flag is enough to make the checkout unsafe to drive.
    const plain = pids.filter((pid) => {
      try { return !/\bKAKAPO_DEV=1\b/.test(execFileSync("ps", ["eww", "-p", pid], { encoding: "utf8" })); }
      catch { return true; } // cannot read it ⇒ cannot vouch for it
    });
    say(plain.length === 0, "and every process of ours was started with KAKAPO_DEV=1, so user-data is isolated",
      plain.length === 0 ? "" : `pid ${plain.join(", ")} is using the REAL user-data directory — do not drive it, and do not trust what it leaves behind`);
    page.close();
  }
}

process.exit(bad ? 1 : 0);
