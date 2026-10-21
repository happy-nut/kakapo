#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

export const BUNDLED_LANGUAGE_FAMILIES = Object.freeze([
  "typescript", "python", "go", "rust", "clang", "java", "kotlin", "ruby", "php",
]);

export const SERVER_VERSIONS = Object.freeze({
  go: "1.26.5",
  gopls: "0.23.0",
  rustAnalyzer: "2026-07-13",
  // rustup was fetched from static.rust-lang.org/rustup/dist/<target>/rustup-init — the "latest stable"
  // path, whose bytes change on every rustup release. A checksum pinned against a moving URL is a build
  // that breaks the next time upstream ships, and it did: every macOS package job failed on a
  // SHA-256 mismatch until someone noticed and re-pinned. The archive path below is immutable, so the
  // pin now guards what it is supposed to guard — that we got the bytes we meant to.
  rustup: "1.29.1",
  clangd: "22.1.6",
  jdtls: "1.60.0-202606262232",
  java: "21.0.11+10",
  // JetBrains ships intellij-server as an EAP build with a hard expiry date baked in: once it passes, the
  // binary refuses to start ("This build of kotlin-server has expired", exit 7) and Kotlin navigation
  // silently degrades to the regex index — which also fails `dist:*` at lsp:smoke. Bump this pin (and
  // KOTLIN_ARCHIVES below) whenever test/language-server-bundles.test.mjs stops resolving Kotlin
  // definitions: that test is the canary, and this is the only dependency here with a clock in it.
  //
  // Releases are listed at https://github.com/Kotlin/kotlin-lsp/releases (tags are `kotlin-lsp/vX`, and
  // those releases carry no assets); each archive's checksum is published next to the archive itself as
  // `<name>.sha256` under the CDN path below. Observed lifetimes: 262.9593.0 (2026-07-27) expired around
  // 2026-09-16, 263.4702.0 (2026-09-13) by 2026-10-16 — four to seven weeks, so expect to bump this a few
  // times a year rather than once.
  kotlin: "263.6379.0",
  sorbet: "0.6.13342.20260716135343-aafce23c1",
  php: "8.4.23",
  phpactor: "2026.06.25.0",
});

const NATIVE_LANGUAGE_FAMILIES = Object.freeze(["go", "rust", "clang", "java", "kotlin", "ruby", "php"]);

const GO_ARCHIVES = Object.freeze({
  "darwin-x64": ["go1.26.5.darwin-amd64.tar.gz", "6231d8d3b8f5552ec6cbf6d685bdd5482e1e703214b120e89b3bf0d7bf1ef725"],
  "darwin-arm64": ["go1.26.5.darwin-arm64.tar.gz", "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a"],
});

const RUST_ARCHIVES = Object.freeze({
  "darwin-x64": ["rust-analyzer-x86_64-apple-darwin.gz", "b8832accb9f163214e63ccc989bb2161d52f19270eafb136da0fb16093185041"],
  "darwin-arm64": ["rust-analyzer-aarch64-apple-darwin.gz", "9c6b3ebf06480e2c95a7b01750fa68d77834bffa34da81e4eb00cef3cdff4613"],
});

// Checksums are upstream's own, from the .sha256 published beside each file in the same archive directory.
const RUSTUP_ARCHIVES = Object.freeze({
  "darwin-x64": ["x86_64-apple-darwin", "259e2b84274434085163fe8d556510571772cda2aa6d87ca6aa664f57bc644e3"],
  "darwin-arm64": ["aarch64-apple-darwin", "ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a"],
});

const CLANG_ARCHIVES = Object.freeze({
  "darwin-x64": ["clangd-mac-22.1.6.zip", "631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d"],
  "darwin-arm64": ["clangd-mac-22.1.6.zip", "631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d"],
});

const KOTLIN_ARCHIVES = Object.freeze({
  "darwin-x64": ["kotlin-server-263.6379.0.sit", "e69e0c9d27b915b2db9ee692ec08d097df1a394d9f21190457ef199f2905f77e"],
  "darwin-arm64": ["kotlin-server-263.6379.0-aarch64.sit", "ebef2e13cd4adc4ec9e04084b848000a3ec7a9d2917c64f269574ce2efe9ecad"],
});

const JAVA_ARCHIVES = Object.freeze({
  "darwin-x64": ["OpenJDK21U-jre_x64_mac_hotspot_21.0.11_10.tar.gz", "b341fb8ed5b70d49066b98176bc98e30f55082192403deb60e0cd5948b6e7923", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_mac_hotspot_21.0.11_10.tar.gz"],
  "darwin-arm64": ["OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz", "4b7a8cd23102c251c8b8be42a9a5f1263fb337cf1037f6f64b25f3070efe4b76", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz"],
});

const SORBET_ARCHIVES = Object.freeze({
  "darwin-x64": ["darwin-x86_64.sorbet", "bc1ddc60a6d7e085a11cfda4b31011cff3a4e7ed4c08854ff7ce4958e967b2c2"],
  "darwin-arm64": ["darwin-arm64.sorbet", "99d752201305cee0cb6baa2c605d9b5caf77930aa99621f2b0157e6769e3133b"],
});

const PHP_ARCHIVES = Object.freeze({
  "darwin-x64": ["php-8.4.23-cli-macos-x86_64.tar.gz", "bd1c20f355e73a9f807b24ba62fd98f3a57bc08d063ebb3aa6393909e01ce89e"],
  "darwin-arm64": ["php-8.4.23-cli-macos-aarch64.tar.gz", "bba286e442796dbd420d778a016e2817b31d5036d11b3ba316d19a60de912cdc"],
});

const PHPACTOR_ARCHIVE = Object.freeze([
  "phpactor.phar",
  "832510fe4cdaf27ba056b8cb66a779d18352585c74fdaac54e45a37b589559e9",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function download(url, expectedSha, cacheDir, {
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  attempts = 4,
} = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, basename(new URL(url).pathname));
  if (existsSync(path) && await sha256(path) === expectedSha) return path;
  process.stdout.write(`Downloading ${basename(path)}\n`);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    rmSync(path, { force: true });
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        const error = new Error(`Download failed (${response.status}): ${url}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        try { await response.body?.cancel(); } catch { /* best effort */ }
        throw error;
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
      const actual = await sha256(path);
      if (actual === expectedSha) return path;
      throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha}, got ${actual}`);
    } catch (error) {
      rmSync(path, { force: true });
      lastError = error;
      if (error?.retryable === false || attempt === attempts - 1) throw error;
      await wait(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

function walk(root, predicate) {
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) {
      const nested = walk(path, predicate);
      if (nested) return nested;
    } else if (predicate(path)) return path;
  }
  return undefined;
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  if (/\.(zip|sit)$/i.test(archive)) run("unzip", ["-q", archive, "-d", destination]);
  else run("tar", ["-xzf", archive, "-C", destination]);
}

async function installGo(target, output, cache) {
  const [name, checksum] = GO_ARCHIVES[target];
  const archive = await download(`https://go.dev/dl/${name}`, checksum, cache);
  extract(archive, output);
  const go = join(output, "go", "bin", "go");
  run(go, ["install", `golang.org/x/tools/gopls@v${SERVER_VERSIONS.gopls}`], {
    env: { ...process.env, GOBIN: join(output, "go", "bin"), GOTOOLCHAIN: "local" },
  });
}

async function installRust(target, output, cache) {
  const [name, checksum] = RUST_ARCHIVES[target];
  const archive = await download(`https://github.com/rust-lang/rust-analyzer/releases/download/${SERVER_VERSIONS.rustAnalyzer}/${name}`, checksum, cache);
  mkdirSync(output, { recursive: true });
  await pipeline(createReadStream(archive), createGunzip(), createWriteStream(join(output, "rust-analyzer")));
  chmodSync(join(output, "rust-analyzer"), 0o755);
  const [rustTarget, rustupChecksum] = RUSTUP_ARCHIVES[target];
  const rustup = await download(
    `https://static.rust-lang.org/rustup/archive/${SERVER_VERSIONS.rustup}/${rustTarget}/rustup-init`,
    rustupChecksum,
    cache,
  );
  chmodSync(rustup, 0o755);
  run(rustup, ["-y", "--profile", "minimal", "--default-toolchain", "stable", "--component", "rust-src", "--no-modify-path"], {
    env: {
      ...process.env,
      CARGO_HOME: join(output, "cargo"),
      RUSTUP_HOME: join(output, "rustup"),
      RUSTUP_TOOLCHAIN: "stable",
    },
  });
}

async function installClang(target, output, cache, work) {
  const spec = CLANG_ARCHIVES[target];
  const [name, checksum] = spec;
  const archive = await download(`https://github.com/clangd/clangd/releases/download/${SERVER_VERSIONS.clangd}/${name}`, checksum, cache);
  const extracted = join(work, "clang");
  extract(archive, extracted);
  const clangd = walk(extracted, (path) => /\/bin\/clangd$/.test(path));
  if (!clangd) throw new Error("clangd archive did not contain bin/clangd");
  cpSync(dirname(dirname(clangd)), output, { recursive: true });
  chmodSync(join(output, "bin", "clangd"), 0o755);
}

async function installJava(target, output, cache, work) {
  const [javaName, javaChecksum, javaUrl] = JAVA_ARCHIVES[target];
  const javaArchive = await download(javaUrl, javaChecksum, cache);
  const javaExtracted = join(work, "java");
  extract(javaArchive, javaExtracted);
  const java = walk(javaExtracted, (path) => /\/bin\/java$/.test(path));
  if (!java) throw new Error("Temurin JRE archive did not contain bin/java");
  cpSync(dirname(dirname(java)), join(output, "jre"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  const jdtName = `jdt-language-server-${SERVER_VERSIONS.jdtls}.tar.gz`;
  const jdtUrl = `https://download.eclipse.org/jdtls/milestones/1.60.0/${jdtName}`;
  const jdtArchive = await download(jdtUrl, "e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d", cache);
  const jdt = join(output, "jdtls");
  extract(jdtArchive, jdt);
  const launcher = walk(join(jdt, "plugins"), (path) => /org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(path));
  if (!launcher) throw new Error("Eclipse JDT LS archive did not contain its launcher");
  cpSync(launcher, join(jdt, "plugins", "org.eclipse.equinox.launcher.jar"));
}

async function installKotlin(target, output, cache, work) {
  const [name, checksum] = KOTLIN_ARCHIVES[target];
  // `download.jetbrains.com`, which is what the release notes publish and what 302s to wherever the bytes
  // actually live. The `download-cdn.` host this used to name now 404s the archives — for the previous pin
  // as well as the current one — while still serving their .sha256 files, so a checksum lookup succeeding
  // says nothing about the archive being there.
  const archive = await download(`https://download.jetbrains.com/language-server/kotlin-server/${SERVER_VERSIONS.kotlin}/${name}`, checksum, cache);
  const extracted = join(work, "kotlin");
  extract(archive, extracted);
  const server = walk(extracted, (path) => basename(path) === "intellij-server");
  if (!server) throw new Error("Kotlin LSP archive did not contain bin/intellij-server");
  // JetBrains ships the JBR legal notices as relative links. Node's default
  // recursive copy rewrites them to absolute paths under the temporary
  // extraction directory, which dangle after cleanup. Preserve the relative
  // link text so the packaged app remains completely self-contained.
  cpSync(dirname(dirname(server)), output, { recursive: true, verbatimSymlinks: true });
  chmodSync(join(output, "bin", "intellij-server"), 0o755);
}

async function installRuby(target, output, cache) {
  const [name, checksum] = SORBET_ARCHIVES[target];
  const url = `https://github.com/sorbet/sorbet/releases/download/${SERVER_VERSIONS.sorbet}/${name}`;
  const binary = await download(url, checksum, cache);
  mkdirSync(output, { recursive: true });
  cpSync(binary, join(output, "sorbet"));
  chmodSync(join(output, "sorbet"), 0o755);
}

async function installPhp(target, output, cache, work) {
  const [name, checksum] = PHP_ARCHIVES[target];
  const archive = await download(`https://dl.static-php.dev/static-php-cli/common/${name}`, checksum, cache);
  const runtime = join(work, "php-runtime");
  extract(archive, runtime);
  const php = walk(runtime, (path) => basename(path) === "php");
  if (!php) throw new Error("Static PHP archive did not contain a php executable");
  const [phpactorName, phpactorChecksum] = PHPACTOR_ARCHIVE;
  const phpactor = await download(
    `https://github.com/phpactor/phpactor/releases/download/${SERVER_VERSIONS.phpactor}/${phpactorName}`,
    phpactorChecksum,
    cache,
  );
  mkdirSync(output, { recursive: true });
  cpSync(php, join(output, "php"));
  cpSync(phpactor, join(output, "phpactor.phar"));
  chmodSync(join(output, "php"), 0o755);
}

export function platformTarget(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Bundled language servers support darwin x64/arm64, got ${platform}-${arch}`);
  }
  return `${platform}-${arch}`;
}

export function expectedServerPaths(root, target) {
  const base = join(root, target);
  return {
    go: join(base, "go", "go", "bin", "gopls"),
    rust: join(base, "rust", "cargo", "bin", "cargo"),
    clang: join(base, "clang", "bin", "clangd"),
    java: join(base, "java", "jre", "bin", "java"),
    kotlin: join(base, "kotlin", "bin", "intellij-server"),
    ruby: join(base, "ruby", "sorbet"),
    php: join(base, "php", "phpactor.phar"),
  };
}

export function assertLanguageServerBundle(root, target) {
  const paths = expectedServerPaths(root, target);
  const missing = Object.entries(paths)
    .filter(([, path]) => !existsSync(path))
    .map(([family, path]) => `${family}: ${path}`);
  const phpRuntime = join(root, target, "php", "php");
  if (!existsSync(phpRuntime)) missing.push(`php runtime: ${phpRuntime}`);
  const executableAssets = [
    paths.go,
    join(root, target, "rust", "rust-analyzer"),
    paths.rust,
    paths.clang,
    paths.java,
    paths.kotlin,
    paths.ruby,
    phpRuntime,
  ];
  for (const path of executableAssets) {
    try { accessSync(path, constants.X_OK); } catch { missing.push(`not executable: ${path}`); }
  }
  if (missing.length) {
    throw new Error(`Incomplete Kakapo language-server bundle for ${target}:\n${missing.join("\n")}`);
  }
  return true;
}

export async function installLanguageServers({
  platform = process.platform,
  arch = process.arch,
  outputRoot = join(repoRoot, "vendor", "language-servers"),
  cacheDir = process.env.KAKAPO_LSP_CACHE || join(tmpdir(), "kakapo-language-server-cache"),
  families = [...NATIVE_LANGUAGE_FAMILIES],
} = {}) {
  const target = platformTarget(platform, arch);
  const targetRoot = join(outputRoot, target);
  const installers = { go: installGo, rust: installRust, clang: installClang, java: installJava, kotlin: installKotlin, ruby: installRuby, php: installPhp };
  mkdirSync(cacheDir, { recursive: true });
  for (const family of families) {
    const install = installers[family];
    if (!install) throw new Error(`Unknown native language-server family: ${family}`);
    const output = join(targetRoot, family);
    const expected = expectedServerPaths(outputRoot, target)[family];
    const complete = existsSync(expected) && (family !== "php" || existsSync(join(output, "php")));
    if (complete) {
      process.stdout.write(`${family}: already installed\n`);
      continue;
    }
    rmSync(output, { recursive: true, force: true });
    const work = join(tmpdir(), `kakapo-lsp-${family}-${process.pid}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      process.stdout.write(`${family}: installing ${target} sidecar\n`);
      await install(target, output, cacheDir, work);
      if (!existsSync(expected) || (family === "php" && !existsSync(join(output, "php")))) {
        throw new Error(`${family} installer did not create a complete sidecar at ${output}`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  if (families.length === NATIVE_LANGUAGE_FAMILIES.length) assertLanguageServerBundle(outputRoot, target);
  return { target, targetRoot };
}

if (resolve(process.argv[1] || "") === scriptPath) {
  const familyArg = process.argv.find((arg) => arg.startsWith("--families="));
  const families = familyArg ? familyArg.slice("--families=".length).split(",").filter(Boolean) : undefined;
  await installLanguageServers({ families });
}
