import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMacDmg } from "../scripts/create-dmg.mjs";
import {
  BUNDLED_LANGUAGE_FAMILIES,
  download,
  expectedServerPaths,
  platformTarget,
  SERVER_VERSIONS,
} from "../scripts/install-language-servers.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("DMG packaging uses macOS system tools without platform-specific npm dependencies", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const script = readFileSync(join(repoRoot, "scripts", "create-dmg.mjs"), "utf8");

  assert.equal(packageJson.devDependencies?.["create-dmg"], undefined);
  assert.equal(packageJson.optionalDependencies?.["create-dmg"], undefined);
  assert.equal(packageLock.packages["node_modules/create-dmg"], undefined);
  assert.equal(packageLock.packages["node_modules/appdmg"], undefined);
  assert.equal(packageJson.scripts["dist:mac:dmg"], "npm run dist:mac && node scripts/create-dmg.mjs");
  assert.match(script, /run\("ditto"/);
  assert.match(script, /run\("hdiutil"/);
  assert.match(script, /finally\s*\{[\s\S]*rmSync\(stagingDir/);
});

test("DMG packaging fails clearly before doing work outside macOS", () => {
  assert.throws(
    () => createMacDmg({ platform: "linux", appPath: "/missing/Kakapo.app" }),
    /requires macOS and the built-in hdiutil/,
  );
});

test("language-server packaging covers every advertised language family with pinned sidecars", () => {
  assert.deepEqual(BUNDLED_LANGUAGE_FAMILIES, [
    "typescript", "python", "go", "rust", "clang", "java", "kotlin", "ruby", "php",
  ]);
  assert.equal(platformTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformTarget("darwin", "x64"), "darwin-x64");
  assert.throws(() => platformTarget("linux", "x64"), /support darwin x64\/arm64/);
  assert.throws(() => platformTarget("win32", "x64"), /support darwin x64\/arm64/);
  assert.deepEqual(Object.keys(expectedServerPaths("/bundle", "darwin-arm64")), [
    "go", "rust", "clang", "java", "kotlin", "ruby", "php",
  ]);
  assert.match(SERVER_VERSIONS.gopls, /^\d+\.\d+\.\d+$/);
  assert.match(SERVER_VERSIONS.kotlin, /^\d+\.\d+\.\d+$/);
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.pyright, "1.1.411");
  assert.equal(packageJson.dependencies.intelephense, undefined);
  assert.equal(SERVER_VERSIONS.php, "8.4.23");
  assert.equal(SERVER_VERSIONS.phpactor, "2026.06.25.0");
  assert.match(packageJson.scripts["dist:mac"], /^npm run lsp:install && npm run build && npm run lsp:smoke/);
});

test("Kotlin packaging preserves relative JBR links instead of retaining temporary paths", () => {
  const installer = readFileSync(join(repoRoot, "scripts", "install-language-servers.mjs"), "utf8");
  assert.match(
    installer,
    /cpSync\(dirname\(dirname\(server\)\), output, \{ recursive: true, verbatimSymlinks: true \}\)/,
  );
});

test("Java packaging preserves relative Temurin JRE links instead of retaining temporary paths", () => {
  const installer = readFileSync(join(repoRoot, "scripts", "install-language-servers.mjs"), "utf8");
  assert.match(
    installer,
    /cpSync\(dirname\(dirname\(java\)\), join\(output, "jre"\), \{\s*recursive: true,\s*verbatimSymlinks: true,\s*\}\)/,
  );
});

test("language-server downloads retry transient server failures without weakening checksums", async () => {
  const cache = mkdtempSync(join(tmpdir(), "kakapo-download-test-"));
  const payload = Buffer.from("verified-sidecar", "utf8");
  const expectedSha = createHash("sha256").update(payload).digest("hex");
  let requests = 0;
  const waits = [];
  try {
    const path = await download("https://example.test/sidecar.tar.gz", expectedSha, cache, {
      fetchImpl: async () => {
        requests += 1;
        return requests < 3
          ? new Response(null, { status: 500 })
          : new Response(payload, { status: 200 });
      },
      wait: async (ms) => { waits.push(ms); },
    });
    assert.equal(readFileSync(path, "utf8"), "verified-sidecar");
    assert.equal(requests, 3);
    assert.deepEqual(waits, [500, 1_000]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("the release workflow tests, builds the dmg and attaches it, with no npm publish", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const autoRelease = readFileSync(join(repoRoot, ".github", "workflows", "auto-release.yml"), "utf8");
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const macos = readFileSync(join(repoRoot, ".github", "workflows", "macos.yml"), "utf8");

  // The tag-triggered release and the merge-triggered auto-release both build the dmg, and neither
  // publishes to npm (Trusted Publishing was never set up; the app ships from GitHub Releases).
  assert.match(release, /macos-release:[\s\S]*uses: \.\/\.github\/workflows\/macos\.yml/);
  assert.match(release, /release_tag:\s*\$\{\{ inputs\.release_tag \}\}/);
  assert.doesNotMatch(release, /run: npm publish/);
  assert.match(autoRelease, /macos-release:[\s\S]*needs: auto-release/);
  assert.match(autoRelease, /uses: \.\/\.github\/workflows\/macos\.yml/);
  assert.doesNotMatch(autoRelease, /run: npm publish/);
  assert.match(autoRelease, /run: npm test/, "a red build still does not get released");

  // The dmg job has to be able to stand alone now. It used to be ordered behind the Linux job, which
  // created the GitHub release; with that gone, this job creates the release itself or there is nothing
  // to upload to.
  assert.match(macos, /gh release create "\$RELEASE_TAG"/);
  assert.match(macos, /npm run dist:mac:dmg:ci/);
  assert.match(macos, /gh release upload "\$RELEASE_TAG" release\/Kakapo-\*\.dmg/);
  assert.match(macos, /ref: \$\{\{ inputs\.release_tag \|\| github\.ref \}\}/);
  assert.equal(packageJson.scripts["dist:mac:dmg:ci"], "npm run dist:mac:ci && node scripts/create-dmg.mjs");
  assert.doesNotMatch(packageJson.scripts["dist:mac:ci"], /lsp:smoke/);
});

// kakapo ships for macOS only. The Linux and Windows packaging were removed wholesale — two workflows,
// three scripts, five npm scripts and every linux-* sidecar in the bundle table — and this is the guard
// that the removal stays removed, because a half-restored platform is worse than either state: a workflow
// with no script behind it, or a bundle table that promises a sidecar no release builds.
test("the repository ships for macOS only", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  for (const gone of ["linux.yml", "windows.yml"]) {
    assert.equal(existsSync(join(repoRoot, ".github", "workflows", gone)), false, `${gone} is gone`);
  }
  for (const gone of ["package-linux.mjs", "package-win.mjs", "smoke-linux.mjs"]) {
    assert.equal(existsSync(join(repoRoot, "scripts", gone)), false, `scripts/${gone} is gone`);
    assert.equal(packageJson.files.includes(`scripts/${gone}`), false, `${gone} is not still published`);
  }
  for (const script of Object.keys(packageJson.scripts)) {
    assert.doesNotMatch(script, /linux|win/, `npm script "${script}" targets a platform that is no longer built`);
  }
  // The bundle table is the other half: a linux-* entry here is a download the installer would attempt
  // for a target no release produces.
  const installer = readFileSync(join(repoRoot, "scripts", "install-language-servers.mjs"), "utf8");
  assert.doesNotMatch(installer, /"linux-(x64|arm64)":/, "no sidecar is still pinned for Linux");
  assert.match(installer, /Bundled language servers support darwin x64\/arm64/, "and the target check says so");
});

// A .dmg install — and so the Homebrew cask — has to give a working `kakapo`, not just an icon. The npm
// package's bin/kakapo.js needs a `node` on PATH and a node_modules/electron, and a packaged bundle has
// neither: it IS Electron. The shim runs the same CLI with the bundle's own binary hosted as node.
test("the packaged bundle ships a kakapo command that can launch the app", () => {
  const shim = readFileSync(join(repoRoot, "bin", "kakapo-bundled.sh"), "utf8");
  assert.match(shim, /ELECTRON_RUN_AS_NODE=1/, "the bundle's binary is hosted as node to run the CLI");
  assert.match(shim, /kakapo\.js/, "and it runs the same CLI the npm install does");
  assert.doesNotMatch(shim, /\bnode\b\s+"/, "never a bare `node` — a packaged install has none");

  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.ok(packageJson.files.includes("bin"), "bin/ ships, so the shim reaches the bundle");

  // resolveElectronBinary's packaged fallback, and the one variable that must not reach the app process:
  // inherited, ELECTRON_RUN_AS_NODE would make the child run app-main.js as a bare script with no window.
  const commands = readFileSync(join(repoRoot, "src", "commands.ts"), "utf8");
  assert.match(commands, /process\.versions\.electron/, "a packaged CLI falls back to its own executable");
  assert.match(commands, /delete appEnv\.ELECTRON_RUN_AS_NODE/, "the app child is not started as node");

  // chmod where the shipping bundle is in hand: a cask links this file, and an unexecutable link is useless.
  const createDmg = readFileSync(join(repoRoot, "scripts", "create-dmg.mjs"), "utf8");
  assert.match(createDmg, /kakapo-bundled\.sh[\s\S]*chmodSync/, "the shim is executable in the shipped bundle");
});

// Reading the shim could only ever check what it says, not what it does — and what it did, when Homebrew
// linked it into its own bin directory, was measure the bundle from the LINK: `dirname "$0"` was
// /opt/homebrew/bin, so the install's only output was `cd: /opt/../MacOS: No such file or directory`.
// Every assertion above still passed. So this one builds a bundle, links the command the way the cask
// does, and runs it.
test("the kakapo command works through the symlink a cask installs it as", () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-shim-"));
  try {
    const bundle = join(dir, "Kakapo.app", "Contents");
    const binDir = join(bundle, "Resources", "app", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(bundle, "MacOS"), { recursive: true });
    // Stand in for the Electron binary the shim hosts the CLI on: report what it was asked to run.
    writeFileSync(join(bundle, "MacOS", "Kakapo"), '#!/bin/sh\necho "RAN $@"\n', { mode: 0o755 });
    writeFileSync(join(binDir, "kakapo.js"), "", { mode: 0o644 });
    const shimPath = join(binDir, "kakapo-bundled.sh");
    writeFileSync(shimPath, readFileSync(join(repoRoot, "bin", "kakapo-bundled.sh"), "utf8"), { mode: 0o755 });

    const expected = `RAN ${join(binDir, "kakapo.js")} review-me`;

    // 1. run in place, the way a double-clicked bundle would
    assert.equal(execFileSync(shimPath, ["review-me"], { encoding: "utf8" }).trim(), expected);

    // 2. run through an absolute symlink in a bin directory — what `brew install --cask` makes
    const brewBin = join(dir, "homebrew-bin");
    mkdirSync(brewBin);
    symlinkSync(shimPath, join(brewBin, "kakapo"));
    assert.equal(execFileSync(join(brewBin, "kakapo"), ["review-me"], { encoding: "utf8" }).trim(), expected,
      "the bundle is measured from the real file, not from the link");

    // 3. and through a relative link to that link — a chain still resolves, each hop against its own dir
    symlinkSync("kakapo", join(brewBin, "kakapo2"));
    assert.equal(execFileSync(join(brewBin, "kakapo2"), ["review-me"], { encoding: "utf8" }).trim(), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The cask points at one URL that never changes, so a release needs no edit in the tap repository and no
// token out of this one.
test("every release publishes the dmg under a stable name for the Homebrew cask", () => {
  const macos = readFileSync(join(repoRoot, ".github", "workflows", "macos.yml"), "utf8");
  assert.match(macos, /Kakapo-arm64\.dmg/, "a fixed-name copy is uploaded");
  assert.match(
    macos,
    /cp release\/Kakapo-\*-arm64\.dmg "\$RUNNER_TEMP\/Kakapo-arm64\.dmg"/,
    "staged outside release/ so the versioned glob cannot pick it up",
  );
});
