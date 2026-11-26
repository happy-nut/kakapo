import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGIN = join(REPO, "intellij-plugin");
const INSTALLED_CONFIG = "IdeaIC2025.2";
const IDE_APP = "/Applications/IntelliJ IDEA CE.app";
const IDE_BINARY = join(IDE_APP, "Contents/MacOS/idea");
const BURROW = join(homedir(), ".local/bin/burrow");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function declaredVersion() {
  const build = readFileSync(join(PLUGIN, "build.gradle.kts"), "utf8");
  const found = build.match(/^version = "([^"]+)"$/m);
  if (!found) throw new Error("intellij-plugin/build.gradle.kts declares no version");
  return found[1];
}

export function shippedZip() {
  return join(PLUGIN, "build", "distributions", `kakapo-comments-${declaredVersion()}.zip`);
}

export function makeProject(prefix, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kakapo-idea-${prefix}-`)));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.email", "verify@kakapo.test");
  git("config", "user.name", "kakapo verify");
  const put = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put(".idea/modules.xml", `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://$PROJECT_DIR$/demo.iml" filepath="$PROJECT_DIR$/demo.iml" />
    </modules>
  </component>
</project>
`);
  put("demo.iml", `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4">
  <component name="NewModuleRootManager" inherit-compiler-output="true">
    <exclude-output />
    <content url="file://$MODULE_DIR$">
      <sourceFolder url="file://$MODULE_DIR$/src" isTestSource="false" />
    </content>
    <orderEntry type="inheritedJdk" />
    <orderEntry type="sourceFolder" forTests="false" />
  </component>
</module>
`);
  const commit = (message) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  // A linked worktree keeps .git as a file, which is the shape that sent comments nowhere until 0.0.4.
  const linkTo = (name) => {
    const linked = realpathSync(mkdtempSync(join(tmpdir(), `kakapo-idea-${prefix}-linked-`)));
    rmSync(linked, { recursive: true, force: true });
    git("worktree", "add", "-q", linked, "-b", name);
    return linked;
  };
  return { dir, git, put, commit, linkTo, options };
}

export async function drive(name, project, body, options = {}) {
  const refuse = (why) => {
    console.error(why);
    if (project && project.dir) rmSync(project.dir, { recursive: true, force: true });
    process.exit(2);
  };

  if (!existsSync(IDE_BINARY)) refuse(`No IDE at ${IDE_APP} — this skill drives the IDE a user installs, not a Gradle sandbox.`);

  // Driving starts with the screen, not with the IDE. A locked Mac answers every question this harness
  // asks — frontmost, window list, screencapture — with something that looks like an answer, so the run
  // goes all the way through and reports a failure about the plugin.
  {
    let lockedNow = false;
    try {
      lockedNow = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(
        execFileSync("sh", ["-c", "ioreg -l -w0 | grep -m1 CGSSessionScreenIsLocked"], { encoding: "utf8" }));
    } catch { /* no such key on a Mac that has never locked */ }
    if (lockedNow) refuse("The Mac screen is locked. Nothing can be raised, typed into or photographed "
      + "through it. Unlock it first: `burrow unlock --why \"<why this run matters>\"`.");
  }

  // The Gradle sandbox under intellij-plugin/build/idea-sandbox carries jars the distribution zip does
  // not (kotlin-stdlib among them, which the platform supplies at runtime). Verifying that layout says
  // nothing about the zip a user downloads, so the zip is the only thing this harness will install.
  const zip = shippedZip();
  if (!existsSync(zip)) refuse(`No ${zip} — run: npm run idea:build`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const evidence = join(REPO, ".kakapo-verify", `${stamp}-idea-${name}`);
  mkdirSync(evidence, { recursive: true });
  const log = (line) => { console.log(line); appendFileSync(join(evidence, "run.log"), `${line}\n`); };

  let failures = 0;
  let shots = 0;
  let controls = 0;

  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), `kakapo-idea-sandbox-`)));
  for (const part of ["system", "plugins", "log"]) mkdirSync(join(sandbox, part), { recursive: true });
  execFileSync("unzip", ["-o", "-q", zip, "-d", join(sandbox, "plugins")]);

  // The sandbox starts as a copy of the user's own config so the run uses their keymap, theme and JDK
  // table; their directory is never written to, only this copy. Copying does NOT carry the user
  // agreement — that was measured, the dialog came back on a copied config — which is why the launch
  // below passes the consent flags instead.
  const installed = join(homedir(), "Library/Application Support/JetBrains", INSTALLED_CONFIG);
  if (!existsSync(installed)) {
    refuse(`No ${installed}. Open ${IDE_APP} once and accept its terms, then run this again: this harness copies that answer rather than giving one.`);
  }
  execFileSync("cp", ["-R", installed, join(sandbox, "config")]);
  rmSync(join(sandbox, "config", "plugins"), { recursive: true, force: true });
  mkdirSync(join(sandbox, "config", "options"), { recursive: true });
  // Otherwise the IDE stops on "Trust and Open Project?" for a directory this harness made itself.
  writeFileSync(join(sandbox, "config/options/trusted-paths.xml"), `<application>
  <component name="Trusted.Paths">
    <option name="TRUSTED_PROJECT_PATHS">
      <map>
        <entry key="${project.dir}" value="true" />
      </map>
    </option>
  </component>
</application>
`);
  writeFileSync(join(sandbox, "config/options/ide.general.xml"), `<application>
  <component name="GeneralSettings">
    <option name="showTipsOnStartup" value="false" />
    <option name="confirmExit" value="false" />
    <option name="reopenLastProject" value="false" />
  </component>
</application>
`);

  let latinized = false;

  const h = {
    evidence,
    sandbox,
    sleep,
    ideLog: () => (existsSync(join(sandbox, "log/idea.log")) ? readFileSync(join(sandbox, "log/idea.log"), "utf8") : ""),
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
    // The IDE's own window, not the screen: another application sitting in front of it would
    // otherwise be what the evidence shows, which is what one run photographed and reported as the
    // plugin. A window id is asked of the window server, so the IDE never has to be raised.
    // This Mac can have another IntelliJ open, and it did: a run addressed its chords to a process
    // picked by name and drove someone else's project, then photographed that window and reported it
    // as the plugin's. Everything below is addressed to the process this run started.
    idePid() {
      try {
        const found = execFileSync("pgrep", ["-f", `idea.config.path=${join(sandbox, "config")}`], { encoding: "utf8" });
        return Number(found.trim().split("\n")[0]);
      } catch { return null; }
    },
    ideWindow() {
      const pid = h.idePid();
      if (!pid) return null;
      const rows = execFileSync("osascript", ["-l", "JavaScript", "-e", `
        ObjC.import("CoreGraphics"); ObjC.import("Foundation");
        const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
        const out = [];
        for (let i = 0; i < arr.count; i++) {
          const w = ObjC.deepUnwrap(arr.objectAtIndex(i));
          if (w.kCGWindowOwnerPID !== ${pid}) continue;
          out.push([w.kCGWindowNumber, w.kCGWindowBounds.Width * w.kCGWindowBounds.Height].join(" "));
        }
        out.join("\\n")`], { encoding: "utf8" }).trim();
      const best = rows.split("\n").filter(Boolean)
        .map((row) => row.split(" ").map(Number))
        .sort((a, b) => b[1] - a[1])[0];
      return best?.[0] ?? null;
    },
    // The same window, with where it sits. A point read off the evidence is in that picture's pixels
    // and a click is in the screen's points, so aiming at anything the plugin drew needs both.
    ideWindowBounds() {
      const pid = h.idePid();
      if (!pid) return null;
      const rows = execFileSync("osascript", ["-l", "JavaScript", "-e", `
        ObjC.import("CoreGraphics"); ObjC.import("Foundation");
        const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
        const out = [];
        for (let i = 0; i < arr.count; i++) {
          const w = ObjC.deepUnwrap(arr.objectAtIndex(i));
          if (w.kCGWindowOwnerPID !== ${pid}) continue;
          const b = w.kCGWindowBounds;
          out.push([b.X, b.Y, b.Width, b.Height].join(" "));
        }
        out.join("\\n")`], { encoding: "utf8" }).trim();
      const best = rows.split("\n").filter(Boolean)
        .map((row) => row.split(" ").map(Number))
        .sort((a, b) => b[2] * b[3] - a[2] * a[3])[0];
      return best ? { x: best[0], y: best[1], w: best[2], h: best[3] } : null;
    },
    /** What burrow's own picture of the screen is scaled by, which is what its clicks are counted in. */
    screenScale() {
      return Number(execFileSync("osascript", ["-l", "JavaScript", "-e",
        'ObjC.import("AppKit"); String($.NSScreen.mainScreen.backingScaleFactor)'], { encoding: "utf8" }).trim()) || 1;
    },
    // A keystroke is addressed to a process and a click is not: System Events' click is swallowed by
    // the Java window, which is why every control the plugin draws went unclicked and only its write
    // path was ever tested. burrow's click goes through screen sharing and arrives as a real event,
    // the same path that can answer a permission window. It takes the screen, so the raise is on purpose.
    // Three coordinate spaces meet here and none of them is guessed: the evidence picture's pixels,
    // the window's points, and burrow's screen pixels. burrow counts in the pixels of its own
    // screenshot, not in points, and a click sent in points lands at half the intended place — on this
    // Mac that put the first run's click in the project tree, which took focus off the card and looked
    // exactly like a plugin that ignores clicks.
    async clickInWindow(pixelX, pixelY, pictureWidth) {
      const bounds = h.ideWindowBounds();
      if (!bounds) throw new Error("this run's IDE has no window to click in");
      await h.raise();
      const picture = pictureWidth ? pictureWidth / bounds.w : 1;
      const screen = h.screenScale();
      const x = Math.round((bounds.x + pixelX / picture) * screen);
      const y = Math.round((bounds.y + pixelY / picture) * screen);
      execFileSync(BURROW, ["click", String(x), String(y)], { stdio: "pipe" });
      log(`click ${pixelX},${pixelY} in the picture -> ${x},${y} on the screen (front stays with ${h.frontmost()})`);
      await sleep(2000);
    },
    async shot(label) {
      shots += 1;
      const file = join(evidence, `${String(shots).padStart(2, "0")}-${label}.png`);
      const window = h.ideWindow();
      const was = h.frontmost();
      if (window) execFileSync("screencapture", ["-x", "-o", `-l${window}`, file], { stdio: "pipe" });
      else execFileSync(BURROW, ["shot", file], { stdio: "pipe" });
      log(`shot ${file}${window ? "" : " (whole screen — no IDE window found)"}`);
      // Taking the picture takes the screen back to whatever started this run. Giving it straight back
      // is cheaper than every later step discovering it on its own.
      if (/idea/i.test(was) && !/idea/i.test(h.frontmost())) await h.raise();
      return file;
    },
    // Nothing in the sandbox can be reached by a click, so what the IDE is told is told in keystrokes.
    // The Mac grants this per application, and System Events answers -1743 when it has not. Raising a
    // window is asynchronous, and a chord sent before the raise lands goes to whatever was in front —
    // which is how a run once photographed another application and called it the plugin's.
    // `frontmost` answers KakaoTalk on a locked screen — whatever was in front when it locked — so the
    // harness believed it had a window while every keystroke went to the login window. The lock is a
    // fact about the session and has to be read as one.
    locked() {
      try {
        const row = execFileSync("sh", ["-c", "ioreg -l -w0 | grep -m1 CGSSessionScreenIsLocked"], { encoding: "utf8" });
        return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(row);
      } catch { return false; }
    },
    frontmost() {
      return execFileSync("osascript",
        ["-e", 'tell application "System Events" to return name of first process whose frontmost is true'],
        { encoding: "utf8" }).trim();
    },
    // The Korean input method swallows an Option chord and types a character into the editor instead
    // of firing the action, so an action is reached through Find Action, which needs no Option.
    async action(text) {
      // Every step checks it still has the screen. Another application took it between the popup
      // opening and the Enter once, and the run went on to photograph an IDE with no window open.
      const mine = (step) => {
        const who = h.frontmost();
        if (!/idea/i.test(who)) throw new Error(`${who} took the screen while ${step}`);
      };
      await h.latin();
      await h.key("shift+cmd+a", 2000, true);
      mine("Find Action was opening");
      execFileSync("osascript",
        ["-e", `tell application "System Events" to tell (first process whose unix id is ${h.idePid()}) to keystroke ${JSON.stringify(text)}`],
        { stdio: "pipe" });
      await sleep(2500);
      mine(`"${text}" was being typed into Find Action`);
      await h.key("enter", 2500);
      log(`action ${text}`);
    },
    /** The same, retried: losing the screen is the Mac's doing and not the plugin's. */
    async actionOrRetry(text, tries = 5) {
      for (let attempt = 1; ; attempt += 1) {
        try { return await h.action(text); } catch (error) {
          if (attempt >= tries) throw error;
          log(`retrying ${text} — ${error.message}`);
          try { await h.key("esc", 1000, true); } catch { /* the popup may already be gone */ }
        }
      }
    },
    // With a Korean input method selected, latin typed into Find Action arrives as Hangul and the popup
    // picks whatever happened to match — one run opened Local History. Control+Space is the input-source
    // switch, and it CYCLES: pressing it per action switched back to Korean on the second one, so it is
    // pressed once a run and put back when the run ends. It is the person's own Mac setting.
    async latin() {
      if (latinized) return;
      await h.key("ctrl+space", 1200, true);
      latinized = true;
    },
    // Typing into a window a chord opened is also the only non-visual control there is for it: a
    // screenshot of a card says the card is there, and a record on disk says the card had the keyboard.
    async type(text, settle = 1500) {
      const pid = h.idePid();
      if (!pid) throw new Error("this run's IDE is not running — nothing to type into");
      await h.latin();
      execFileSync("osascript",
        ["-e", `tell application "System Events" to tell (first process whose unix id is ${pid}) to keystroke ${JSON.stringify(text)}`],
        { stdio: "pipe" });
      log(`type ${JSON.stringify(text)} (front stays with ${h.frontmost()})`);
      await sleep(settle);
    },
    // Raising is never automatic: it takes the screen from whoever is using the Mac. A script asks
    // for it only where it has measured that the chord does not land otherwise, and says so.
    async raise(ms = 15000) {
      const pid = h.idePid();
      if (!pid) throw new Error("this run's IDE is not running");
      const deadline = Date.now() + ms;
      for (;;) {
        execFileSync("osascript",
          ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
          { stdio: "pipe" });
        await sleep(800);
        let who = h.frontmost();
        // Being in front once is not the same as holding it. `screencapture` pulls the terminal this
        // run was started from to the front a moment later, so five actions in a row raised the IDE,
        // read "idea", and then typed into Terminal. The IDE has to still be there a beat afterwards.
        if (/idea/i.test(who)) {
          await sleep(900);
          who = h.frontmost();
        }
        if (/idea/i.test(who)) return who;
        // Giving up quietly is what made a run type "Comment at Caret" at a locked screen and then
        // photograph nothing: a chord only lands in the window that has the screen.
        if (Date.now() > deadline) {
          throw new Error(h.locked()
            ? "the Mac screen is locked, so no window can be raised and no keystroke lands — unlock it with `burrow unlock`"
            : `the IDE would not come to the front; ${who} is holding the screen`);
        }
      }
    },
    // Nothing else here raises the IDE. The window is photographed by its own id and the chord is addressed
    // to this run's process, so a run can happen behind whatever the person is actually working in —
    // an IDE that kept jumping to the front is a harness that interrupts the person it reports to.
    async key(chord, settle = 2500, raise = false) {
      const pid = h.idePid();
      if (!pid) throw new Error("this run's IDE is not running — nothing to send a chord to");
      // A chord lands only while the IDE holds the screen, so a script that needs one asks for it here
      // rather than having every run take the screen.
      if (raise) await h.raise();
      const parts = chord.split("+");
      const key = parts.pop();
      // A character sent with shift down is the shifted character: "/" becomes "?" and the chord the
      // plugin declared on SLASH never matches. Keys that carry a chord are sent by code, not by glyph.
      const named = { esc: 53, enter: 36, tab: 48, space: 49, "/": 44 };
      const using = parts.map((one) => ({ cmd: "command down", shift: "shift down", alt: "option down", ctrl: "control down" })[one]);
      const what = named[key] !== undefined ? `key code ${named[key]}` : `keystroke ${JSON.stringify(key)}`;
      const suffix = using.length ? ` using {${using.join(", ")}}` : "";
      execFileSync("osascript",
        ["-e", `tell application "System Events" to tell (first process whose unix id is ${pid}) to ${what}${suffix}`],
        { stdio: "pipe" });
      log(`key ${chord} -> pid ${pid} (front stays with ${h.frontmost()})`);
      await sleep(settle);
    },
    async until(predicate, ms = 60000, what = "a condition") {
      const deadline = Date.now() + ms;
      for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(1000);
      }
    },
  };

  const ide = spawn(IDE_BINARY, [
    `-Didea.config.path=${join(sandbox, "config")}`,
    `-Didea.system.path=${join(sandbox, "system")}`,
    `-Didea.plugins.path=${join(sandbox, "plugins")}`,
    `-Didea.log.path=${join(sandbox, "log")}`,
    // A fresh config on a Korean machine opens on the Language and Region dialog, which no amount of
    // waiting dismisses: LanguageAndRegionDialogKt.getLanguageAndRegionDialogIfNeeded reads
    // Locale.getDefault() and offers a localisation when it recognises the system language. An English
    // locale takes that gate away, so the first window the run sees is the project.
    // Opening the folder leaves the editor empty, and a seeded workspace.xml is rewritten by the IDE
    // on exit. The launcher's own file argument is the one way in that survives.
    ...(options.open ? ["--line", String(options.line ?? 1), join(project.dir, options.open)] : [project.dir]),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // The native launcher drops -D arguments it does not recognise, so the JVM has to be told
      // directly. An English locale keeps the Language and Region dialog away, and the consent flags
      // are the ones JetBrains documents for unattended runs: the person running this has an IDE they
      // already accepted these terms in.
      JAVA_TOOL_OPTIONS: [
        "-Duser.language=en",
        "-Duser.country=US",
        "-Djb.consents.confirmation.enabled=false",
        "-Djb.privacy.policy.text=<!--999.999-->",
      ].join(" "),
    },
  });
  let launcherOutput = "";
  ide.stdout.on("data", (chunk) => { launcherOutput += chunk; });
  ide.stderr.on("data", (chunk) => { launcherOutput += chunk; });

  try {
    // 2025.2 logs no "project opened" line, so readiness is read off two things it does log: the
    // plugin being loaded, and the opened file being touched by indexing.
    await h.until(() => /Loaded custom plugins: kakapo comments/.test(h.ideLog()), 180000,
      "the IDE to load the plugin");
    if (options.open) {
      const name = options.open.split("/").pop();
      await h.until(() => h.ideLog().includes(name), 180000, `the IDE to take up ${name}`);
      // The name appears in the log while the editor is still a blank "Drop files here" panel, and a
      // chord sent then reaches nothing. Leaving dumb mode for that file is the IDE saying the editor
      // is real: on this machine it is about ninety seconds after the name first appears.
      await h.until(() => /exit dumb mode/.test(h.ideLog()), 300000,
        `the IDE to finish indexing and show ${name}`);
    }
    log("the IDE is up with the plugin loaded");
    await sleep(12000);
    await body(h, project);
  } catch (error) {
    failures += 1;
    log(`FAIL ${error.message}`);
    try { await h.shot("failure"); } catch { /* the screen may be locked */ }
    appendFileSync(join(evidence, "launcher.log"), launcherOutput);
    appendFileSync(join(evidence, "idea.log"), h.ideLog());
  } finally {
    // The input source is the person's, not this run's. Switching it and walking away leaves their Mac
    // typing the wrong alphabet.
    if (latinized) {
      try {
        execFileSync("osascript",
          ["-e", 'tell application "System Events" to key code 49 using {control down}'], { stdio: "pipe" });
      } catch { /* the screen may be locked, and the setting is cosmetic */ }
    }
    appendFileSync(join(evidence, "idea.log"), h.ideLog());
    ide.kill("SIGTERM");
    await sleep(2000);
    ide.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }

  if (!controls) {
    log("FAIL this run passed no h.control(...) — a run that never showed a presence cannot report an absence");
    failures += 1;
  }
  log(`${failures ? "FAILED" : "PASSED"} ${name} — evidence in ${evidence}`);
  process.exit(failures ? 1 : 0);
}
