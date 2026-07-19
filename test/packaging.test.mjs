import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMacDmg } from "../scripts/create-dmg.mjs";
import {
  assertNativeLinuxTarget,
  linuxArchiveName,
  linuxBundleName,
  linuxRipgrepPackageName,
  normalizeLinuxArch,
  SUPPORTED_LINUX_ARCHES,
} from "../scripts/package-linux.mjs";
import { waitForKakapoRenderer } from "../scripts/smoke-linux.mjs";
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

test("Linux packaging exposes deterministic x64 and ARM64 release names", () => {
  assert.deepEqual(SUPPORTED_LINUX_ARCHES, ["x64", "arm64"]);
  assert.equal(normalizeLinuxArch(" X64 "), "x64");
  assert.equal(normalizeLinuxArch("ARM64"), "arm64");
  assert.equal(linuxBundleName("x64"), "Kakapo-linux-x64");
  assert.equal(linuxBundleName("arm64"), "Kakapo-linux-arm64");
  assert.equal(linuxArchiveName("1.2.3", "x64"), "Kakapo-1.2.3-linux-x64.tar.gz");
  assert.equal(linuxRipgrepPackageName("x64"), "@vscode/ripgrep-linux-x64");
  assert.equal(linuxRipgrepPackageName("arm64"), "@vscode/ripgrep-linux-arm64");
  assert.throws(() => normalizeLinuxArch("ia32"), /Expected x64 or arm64/);
  assert.equal(
    assertNativeLinuxTarget({ platform: "linux", hostArch: "arm64", targetArch: "arm64" }),
    "arm64",
  );
  assert.throws(
    () => assertNativeLinuxTarget({ platform: "darwin", hostArch: "arm64", targetArch: "arm64" }),
    /must be built on native Linux arm64/,
  );
  assert.throws(
    () => assertNativeLinuxTarget({ platform: "linux", hostArch: "arm64", targetArch: "x64" }),
    /must be built on native Linux x64/,
  );
});

test("language-server packaging covers every advertised language family with pinned sidecars", () => {
  assert.deepEqual(BUNDLED_LANGUAGE_FAMILIES, [
    "typescript", "python", "go", "rust", "clang", "java", "kotlin", "ruby", "php",
  ]);
  assert.equal(platformTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformTarget("linux", "x64"), "linux-x64");
  assert.throws(() => platformTarget("win32", "x64"), /support darwin\/linux/);
  assert.deepEqual(Object.keys(expectedServerPaths("/bundle", "linux-arm64")), [
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

test("Linux ARM64 clang packaging dereferences temporary .deb links", () => {
  const installer = readFileSync(join(repoRoot, "scripts", "install-language-servers.mjs"), "utf8");
  assert.match(installer, /cpSync\(realpathSync\(clangd\), join\(output, "bin", "clangd"\)\)/);
  for (const runtime of ["libgrpc++1.51t64", "libprotobuf32t64", "libabsl20220623t64"]) {
    assert.match(installer, new RegExp(runtime.replace(/[+.]/g, "\\$&")));
  }
  assert.match(installer, /walkFiles\(apt, \(path\) =>/);
  assert.match(installer, /LD_LIBRARY_PATH: join\(output, "lib"\)/);
  assert.match(installer, /\["--version"\]/);
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

test("Linux GUI smoke requires an actual Kakapo renderer page", async () => {
  const page = await waitForKakapoRenderer({
    port: 9222,
    timeoutMs: 1_000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { type: "page", title: "Kakapo is loading", url: "data:text/html,Kakapo" },
        { type: "page", title: "Kakapo", url: "file:///tmp/welcome.html" },
      ],
    }),
    processState: () => ({ exited: false }),
  });

  assert.equal(page.type, "page");
  assert.equal(page.title, "Kakapo");
  assert.match(page.url, /^file:/);
});

test("Linux release workflow tests, packages, boots, and publishes both native architectures", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "linux.yml"), "utf8");
  const autoRelease = readFileSync(join(repoRoot, ".github", "workflows", "auto-release.yml"), "utf8");
  const publish = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");

  assert.equal(packageJson.scripts["dist:linux:x64"], "npm run lsp:install && npm run build && npm run lsp:smoke && node scripts/package-linux.mjs x64");
  assert.equal(packageJson.scripts["dist:linux:arm64"], "npm run lsp:install && npm run build && npm run lsp:smoke && node scripts/package-linux.mjs arm64");
  assert.equal(packageJson.scripts["smoke:linux"], "node scripts/smoke-linux.mjs");
  assert.match(workflow, /runner: ubuntu-24\.04\n/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /!startsWith\(github\.event\.head_commit\.message, 'chore\(release\):'\)/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /npm run dist:linux:\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /npm run smoke:linux/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(
    readFileSync(join(repoRoot, "scripts", "smoke-linux.mjs"), "utf8"),
    /child\.stdout\?\.destroy\(\);[\s\S]*child\.stderr\?\.destroy\(\);/,
  );
  assert.match(autoRelease, /uses: \.\/\.github\/workflows\/linux\.yml/);
  assert.match(autoRelease, /needs: \[auto-release, linux-release\]/);
  assert.match(publish, /linux-release:[\s\S]*uses: \.\/\.github\/workflows\/linux\.yml/);
  assert.match(publish, /publish:[\s\S]*needs: linux-release/);
  assert.match(publish, /release_tag:\s*\$\{\{ inputs\.release_tag \}\}/);
  assert.match(publish, /ref: \$\{\{ inputs\.release_tag \|\| github\.ref \}\}/);
});
