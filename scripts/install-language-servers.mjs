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
  realpathSync,
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
  clangd: "22.1.6",
  jdtls: "1.60.0-202606262232",
  java: "21.0.11+10",
  kotlin: "262.8190.0",
  sorbet: "0.6.13342.20260716135343-aafce23c1",
  php: "8.4.23",
  phpactor: "2026.06.25.0",
});

const NATIVE_LANGUAGE_FAMILIES = Object.freeze(["go", "rust", "clang", "java", "kotlin", "ruby", "php"]);

const GO_ARCHIVES = Object.freeze({
  "darwin-x64": ["go1.26.5.darwin-amd64.tar.gz", "6231d8d3b8f5552ec6cbf6d685bdd5482e1e703214b120e89b3bf0d7bf1ef725"],
  "darwin-arm64": ["go1.26.5.darwin-arm64.tar.gz", "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a"],
  "linux-x64": ["go1.26.5.linux-amd64.tar.gz", "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053"],
  "linux-arm64": ["go1.26.5.linux-arm64.tar.gz", "fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49"],
});

const RUST_ARCHIVES = Object.freeze({
  "darwin-x64": ["rust-analyzer-x86_64-apple-darwin.gz", "b8832accb9f163214e63ccc989bb2161d52f19270eafb136da0fb16093185041"],
  "darwin-arm64": ["rust-analyzer-aarch64-apple-darwin.gz", "9c6b3ebf06480e2c95a7b01750fa68d77834bffa34da81e4eb00cef3cdff4613"],
  "linux-x64": ["rust-analyzer-x86_64-unknown-linux-gnu.gz", "5ee1754afa7a1eb7f56606847b61328e6fac2f316e40ebf314dcefb30263df4d"],
  "linux-arm64": ["rust-analyzer-aarch64-unknown-linux-gnu.gz", "d30c3ac726f93ae7cb57c6e16cd2d2b5460c9893ccdd38b6d3ae9300c72852ab"],
});

const RUSTUP_ARCHIVES = Object.freeze({
  "darwin-x64": ["x86_64-apple-darwin", "33cf85df9142bc6d29cbc62fa5ca1d4c29622cddb55213a4c1a43c457fb9b2d7"],
  "darwin-arm64": ["aarch64-apple-darwin", "aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1"],
  "linux-x64": ["x86_64-unknown-linux-gnu", "4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792"],
});

const CLANG_ARCHIVES = Object.freeze({
  "darwin-x64": ["clangd-mac-22.1.6.zip", "631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d"],
  "darwin-arm64": ["clangd-mac-22.1.6.zip", "631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d"],
  "linux-x64": ["clangd-linux-22.1.6.zip", "a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa"],
});

const KOTLIN_ARCHIVES = Object.freeze({
  "darwin-x64": ["kotlin-server-262.8190.0.sit", "f3845ae9ee38c22ef5e436390d86a3d908f77073e9667fa643a5ae0957c19728"],
  "darwin-arm64": ["kotlin-server-262.8190.0-aarch64.sit", "e20183262784bb7e665ce1aea4855872a8b16f211ebb478d452773553732d9fb"],
  "linux-x64": ["kotlin-server-262.8190.0.tar.gz", "8b4c70e95065420e7867c99aaf9f18e0b4e76311ec453e4c1a39e3f6ae774cbf"],
  "linux-arm64": ["kotlin-server-262.8190.0-aarch64.tar.gz", "c3edd59ef34a7faa4d04f3517afb7a932b19c3f9cf17d1a14e9da17b0b5440ad"],
});

const JAVA_ARCHIVES = Object.freeze({
  "darwin-x64": ["OpenJDK21U-jre_x64_mac_hotspot_21.0.11_10.tar.gz", "b341fb8ed5b70d49066b98176bc98e30f55082192403deb60e0cd5948b6e7923", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_mac_hotspot_21.0.11_10.tar.gz"],
  "darwin-arm64": ["OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz", "4b7a8cd23102c251c8b8be42a9a5f1263fb337cf1037f6f64b25f3070efe4b76", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz"],
  "linux-x64": ["OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz", "e5038aae3ca9ff670bc696496b0728dbd23d280026bad30291cb919221ecfdcb", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz"],
  "linux-arm64": ["OpenJDK21U-jre_aarch64_linux_hotspot_21.0.11_10.tar.gz", "fa23d9d9945053e67bcc7638410eabf1e17a7672c7c95a24f70cd08b8407d36e", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.11_10.tar.gz"],
});

const SORBET_ARCHIVES = Object.freeze({
  "darwin-x64": ["darwin-x86_64.sorbet", "bc1ddc60a6d7e085a11cfda4b31011cff3a4e7ed4c08854ff7ce4958e967b2c2"],
  "darwin-arm64": ["darwin-arm64.sorbet", "99d752201305cee0cb6baa2c605d9b5caf77930aa99621f2b0157e6769e3133b"],
  "linux-x64": ["linux-x86_64.sorbet", "b63741ca6bdc86be83e9ee6be21cab3043454c34aa480d3d8cafd70623496b24"],
  "linux-arm64": ["linux-aarch64.sorbet", "7a179a7145b9e0e53f36f957c15bd6d5071fd10d6b89d446fab15b72dc4e60c3"],
});

const PHP_ARCHIVES = Object.freeze({
  "darwin-x64": ["php-8.4.23-cli-macos-x86_64.tar.gz", "bd1c20f355e73a9f807b24ba62fd98f3a57bc08d063ebb3aa6393909e01ce89e"],
  "darwin-arm64": ["php-8.4.23-cli-macos-aarch64.tar.gz", "bba286e442796dbd420d778a016e2817b31d5036d11b3ba316d19a60de912cdc"],
  "linux-x64": ["php-8.4.23-cli-linux-x86_64.tar.gz", "1aeed5bc7967977ca5b1da7163acd91bf9ba3ac56037045d4e91ee2ff2712bb7"],
  "linux-arm64": ["php-8.4.23-cli-linux-aarch64.tar.gz", "0978d89157292bcc9268a34a73a4d5d2793f8dff1403b5138a94d2af6b7a09b0"],
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

async function download(url, expectedSha, cacheDir) {
  const path = join(cacheDir, basename(new URL(url).pathname));
  if (existsSync(path) && await sha256(path) === expectedSha) return path;
  rmSync(path, { force: true });
  process.stdout.write(`Downloading ${basename(path)}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  const actual = await sha256(path);
  if (actual !== expectedSha) {
    rmSync(path, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha}, got ${actual}`);
  }
  return path;
}

function walk(root, predicate) {
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
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
    `https://static.rust-lang.org/rustup/dist/${rustTarget}/rustup-init`,
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
  if (!spec && target === "linux-arm64") {
    const apt = join(work, "clang-apt");
    mkdirSync(apt, { recursive: true });
    run("apt-get", ["download", "clangd-18", "libclang-cpp18", "libllvm18"], { cwd: apt });
    const debs = readdirSync(apt).filter((name) => name.endsWith(".deb"));
    if (debs.length < 3) throw new Error("Ubuntu clangd-18 ARM64 packages were not downloaded");
    for (const deb of debs) run("dpkg-deb", ["-x", join(apt, deb), apt]);
    const clangd = walk(apt, (path) => /\/clangd$/.test(path));
    if (!clangd) throw new Error("clangd was missing from Ubuntu ARM64 packages");
    mkdirSync(join(output, "bin"), { recursive: true });
    mkdirSync(join(output, "lib"), { recursive: true });
    // Ubuntu's clangd and LLVM packages expose versioned files through links inside the extracted .deb
    // tree. Copying the links verbatim leaves the sidecar pointing back into `work`, which is removed as
    // soon as installation completes. Dereference every portable payload so the packaged bundle is wholly
    // self-contained after that cleanup.
    cpSync(realpathSync(clangd), join(output, "bin", "clangd"));
    for (const library of ["libclang-cpp.so.18", "libLLVM.so.18.1"]) {
      const found = walk(apt, (path) => basename(path) === library);
      if (found) cpSync(realpathSync(found), join(output, "lib", library));
    }
    chmodSync(join(output, "bin", "clangd"), 0o755);
    return;
  }
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
  cpSync(dirname(dirname(java)), join(output, "jre"), { recursive: true });

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
  const archive = await download(`https://download-cdn.jetbrains.com/language-server/kotlin-server/${SERVER_VERSIONS.kotlin}/${name}`, checksum, cache);
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
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Bundled language servers support darwin/linux x64/arm64, got ${platform}-${arch}`);
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
