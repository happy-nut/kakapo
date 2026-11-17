// The lifecycle every verification script in this skill needs, and nothing else.
//
// Deliberately thin. The CDP client, the port preflight and the launch/stop pair already live in
// scripts/lib/app-harness.mjs, which nav:smoke and nav:matrix drive the same app with — a second copy
// would be a second place for "did that key reach the renderer" to be answered differently. What the
// harness does NOT do is the four things a verification run needs around it:
//
//   isolation   launchApp() passes `{...process.env}` and sets no KAKAPO_DEV, so an app launched from it
//               writes into the operator's REAL Kakapo user-data directory (app-main.ts only redirects to
//               <userData>/dev when KAKAPO_DEV=1). A verification run must not leave rows in the
//               workspace mirror of someone's actual reviews, so this sets it.
//   readiness   readyPage() answers "the viewer's functions are defined", which is true well before the
//               first diff has been built and painted. Driving at that moment reads an empty tree and
//               calls it a regression. `until` below is the difference between responding and usable.
//   evidence    screenshots and a transcript, in a place that survives the cleanup and is outside git.
//   cleanup     stopApp() kills the Electron children the node launcher leaves behind, and the fixture
//               repository goes with them — but the evidence directory does not.
//
// Nothing here hides a selector. Feature scripts write their own `page.evaluate` so the next reader sees
// what the app was actually asked, not a wrapper they have to decode first.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");

const harness = await import(join(REPO, "scripts/lib/app-harness.mjs"));
export const { PORT, sleep } = harness;

/**
 * Where an isolated run's user-data lives: Electron's per-user application directory for the app name
 * `Kakapo` (app-main.ts calls `app.setName`), plus the `dev` suffix KAKAPO_DEV=1 adds. Derived rather
 * than asked, because no bridge exposes it to the renderer — so a platform this does not know simply
 * yields a path that is not there, and the cleanup below becomes a no-op instead of a wrong delete.
 */
function devUserData() {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Kakapo", "dev");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Kakapo", "dev");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Kakapo", "dev");
}

/** A throwaway git repository to review. `put` then `commit`, exactly as the smoke scripts build theirs. */
export function makeRepo(prefix) {
  // realpath, not the raw mkdtemp answer. On macOS tmpdir() is /var/folders/… and /var is a symlink to
  // /private/var, so the app — which resolves the root it is given — works under the second spelling
  // while the caller holds the first. Anything that derives a path from the root (the user-data mirror
  // this run has to clean up afterwards) then builds it from the wrong one and silently reclaims nothing.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kakapo-verify-${prefix}-`)));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.email", "verify@kakapo.test");
  git("config", "user.name", "kakapo verify");
  const put = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  return { dir, git, put, commit };
}

/**
 * Launch kakapo on `repo`, hand a ready page to `body`, and always take the app down.
 *
 * `body(page, h)` gets the harness Page plus:
 *   h.check(ok, what, detail)  one line of the transcript; a false one decides the exit code
 *   h.shot(name)               a PNG in the evidence directory, named <nn>-<name>.png
 *   h.until(expression, ms)    poll a JS expression until it is truthy; returns it, or throws
 *   h.sleep(ms)                last resort — prefer until(), a sleep is a bet on the clock
 *   h.evidence                 the directory the run is writing to
 */
export async function drive(name, repo, body) {
  const { checkoutElectronPids, launchApp, portHolder, preflightPort, readyPage, stopApp } = harness;

  // A second launch is handed to the instance already up (app-main.ts requestSingleInstanceLock), so this
  // would drive the operator's window instead of its own. Refuse by name rather than by timing out later.
  // A refusal still takes the fixture with it: these run often while a skill is being written, and a
  // /tmp full of half-built repositories is the kind of mess that makes the next person distrust the tool.
  const refuse = (why) => {
    console.error(why);
    if (repo && repo.dir) rmSync(repo.dir, { recursive: true, force: true });
    process.exit(2);
  };
  const already = checkoutElectronPids();
  if (already.length) refuse(`a Kakapo from this checkout is already running (pid ${already.join(", ")}) — close it first`);
  if (!(await preflightPort(PORT))) {
    refuse(`the debugger port ${PORT} is taken by: ${portHolder(PORT) || "something that will not say"}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const evidence = join(REPO, ".kakapo-verify", `${stamp}-${name}`);
  mkdirSync(evidence, { recursive: true });
  const log = (line) => { console.log(line); appendFileSync(join(evidence, "run.log"), `${line}\n`); };

  let failures = 0;
  let shots = 0;
  const h = {
    evidence,
    sleep,
    check(ok, what, detail) {
      log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` — ${detail}`}`);
      if (!ok) failures += 1;
      return Boolean(ok);
    },
    // Bound below, once there is a page to drive.
    shot: null,
    until: null,
    click: null,
  };

  // KAKAPO_DEV=1 is the isolation: app-main.ts moves userData to <userData>/dev under it, so this run
  // cannot touch the comment records, read marks or restored tabs of the operator's real reviews.
  // Set on our own env because launchApp spreads `{...process.env}` into the child; nothing else reads it.
  process.env.KAKAPO_DEV = "1";
  const { child, log: appLog } = launchApp(typeof repo === "string" ? repo : repo.dir);

  try {
    const page = await readyPage(120000);
    if (!page) { console.error(appLog().slice(-3000)); throw new Error("the app never became ready"); }

    h.until = async (expression, ms = 20000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await page.evaluate(expression);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
        await sleep(200);
      }
    };
    // A real mouse click at an element's centre. The harness has `drag` (press, moves, release) but no
    // plain click, and several surfaces have no keyboard route to where a reviewer actually puts the
    // pointer — the caret on a particular diff line above all, since `diffCursor` is a top-level `let`
    // and therefore not on `window` for evaluate to set or read.
    // `nth` counts among the elements that are actually ON SCREEN, not among every match. A diff paints a
    // window of rows and leaves the rest as zero-height placeholders, and the source view fills on demand,
    // so matching the selector is not the same as being clickable — the Nth match is routinely a row with
    // no box. A reviewer clicks what they can see; so does this. Having a box is the whole test:
    // offsetParent is also null for a positioned element and for one inside a fixed ancestor, which would
    // hide clickable rows behind a second, wrong rule.
    h.click = async (selector, nth = 0) => {
      const box = await page.evaluate(`(() => {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const visible = all.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const el = visible[${nth}];
        if (!el) return { matched: all.length, visible: visible.length };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box || box.x === undefined) {
        throw new Error(`nothing clickable at ${selector} [${nth}] — ${box.matched} matched, ${box.visible} of them on screen`);
      }
      const common = { button: "left", clickCount: 1, x: box.x, y: box.y };
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
      await sleep(120);
      return box;
    };
    h.shot = async (label) => {
      shots += 1;
      const result = await page.send("Page.captureScreenshot", { format: "png" });
      const file = join(evidence, `${String(shots).padStart(2, "0")}-${label}.png`);
      writeFileSync(file, Buffer.from(result.data, "base64"));
      log(`shot ${file}`);
      return file;
    };

    // Usable, not merely responding: the boot overlay is gone and the first diff has been painted.
    await h.until(`!document.getElementById('boot-overlay') || document.getElementById('boot-overlay').classList.contains('hidden')`, 60000);
    // A review that has something in it, in whichever shape this folder has one: changed files in the
    // diff and in the Changes list, or — for a folder with no git and nothing to diff — a project tree.
    await h.until(`document.querySelectorAll('.d2h-file-wrapper').length > 0
      || document.querySelectorAll('#changes-panel .file-link').length > 0
      || (document.getElementById('files-panel') || {}).childElementCount > 0`, 60000);

    // KAKAPO_VERIFY_LOCALE=ko re-renders the whole window in place, so one script can photograph both
    // catalogues. A label that overflows its row is visible in no assertion, and this app ships Korean.
    const locale = process.env.KAKAPO_VERIFY_LOCALE;
    if (locale) {
      await page.evaluate(`(() => { locale = ${JSON.stringify(locale)}; applyI18n(); return locale; })()`);
      await h.until(`locale === ${JSON.stringify(locale)}`);
      log(`     rendering in ${locale}`);
    }

    await body(page, h);
    page.close();
  } finally {
    await stopApp(child);
    if (repo.dir) {
      rmSync(repo.dir, { recursive: true, force: true });
      // The fixture is gone, so its user-data mirror is an orphan — a review build, a symbol index, a
      // perf trace and a state.json for a repository that no longer exists. Eight of those accumulated
      // while this skill was being written. The path is asked of the app's own function rather than
      // rebuilt from the rule here, because a second spelling of it would rot and then delete nothing
      // (or, far worse, something else).
      try {
        const { workspaceDataDirectory } = await import(join(REPO, "dist/workspace-data.js"));
        rmSync(workspaceDataDirectory(devUserData(), repo.dir), { recursive: true, force: true });
      } catch { /* nothing to reclaim */ }
    }
  }

  log(failures ? `\n${failures} check(s) failed — evidence in ${evidence}` : `\nall checks passed — evidence in ${evidence}`);
  process.exit(failures ? 1 : 0);
}
