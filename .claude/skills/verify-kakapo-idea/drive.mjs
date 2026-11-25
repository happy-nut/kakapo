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
    async shot(label) {
      shots += 1;
      const file = join(evidence, `${String(shots).padStart(2, "0")}-${label}.png`);
      execFileSync(BURROW, ["shot", file], { stdio: "pipe" });
      log(`shot ${file}`);
      return file;
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
