import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");

const harness = await import(join(REPO, "scripts/lib/app-harness.mjs"));
export const { PORT, sleep } = harness;

function devUserData() {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Kakapo", "dev");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Kakapo", "dev");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Kakapo", "dev");
}

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

export async function drive(name, repo, body, options = {}) {
  const { checkoutElectronPids, launchApp, portHolder, preflightPort, readyPage, stopApp } = harness;

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
  let controls = 0;
  const h = {
    evidence,
    sleep,
    check(ok, what, detail) {
      log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` — ${detail}`}`);
      if (!ok) failures += 1;
      return Boolean(ok);
    },
    control(ok, what, detail) {
      const passed = h.check(ok, `control: ${what}`, detail);
      if (passed) controls += 1;
      return passed;
    },
    absent(ok, what, detail) {
      if (!controls) {
        log(`FAIL ${what} — asserted an absence with no control passed in this run`);
        failures += 1;
        return false;
      }
      return h.check(ok, what, detail);
    },
    shot: null,
    until: null,
    click: null,
  };

  process.env.KAKAPO_DEV = "1";
  const { child, log: appLog } = launchApp(typeof repo === "string" ? repo : repo.dir, options.args ?? []);

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

    await h.until(`!document.getElementById('boot-overlay') || document.getElementById('boot-overlay').classList.contains('hidden')`, 60000);
    await h.until(`document.querySelectorAll('.d2h-file-wrapper').length > 0
      || document.querySelectorAll('#changes-panel .file-link').length > 0
      || (document.getElementById('files-panel') || {}).childElementCount > 0`, 60000);

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
      try {
        const { workspaceDataDirectory } = await import(join(REPO, "dist/workspace-data.js"));
        rmSync(workspaceDataDirectory(devUserData(), repo.dir), { recursive: true, force: true });
      } catch { }
    }
  }

  if (!controls) {
    log("FAIL this run passed no h.control(...) — a run that never showed a presence cannot report an absence");
    failures += 1;
  }
  log(failures ? `\n${failures} check(s) failed — evidence in ${evidence}` : `\nall checks passed — evidence in ${evidence}`);
  process.exit(failures ? 1 : 0);
}
