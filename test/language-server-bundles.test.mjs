import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { expectedServerPaths, platformTarget } from "../scripts/install-language-servers.mjs";

const dirs = [];
const bundleRoot = join(process.cwd(), "vendor", "language-servers");
let target;
try { target = platformTarget(); } catch { target = undefined; }
const bundled = target ? expectedServerPaths(bundleRoot, target) : {};

function project() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-native-lsp-"));
  dirs.push(root);
  return root;
}

function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

async function expectSemanticDefinition({ family, path, line, column, symbol, expectedPath, server, prepare }) {
  const root = project();
  prepare(root);
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm([path]);
    const result = await analysis.query({ kind: "definition", path, line, column, symbol });
    assert.equal(result.engine, "lsp", `${family} must use semantic analysis: ${result.fallbackReason ?? "no reason"}`);
    assert.equal(result.confidence, "semantic");
    assert.equal(result.server, server);
    assert.equal(result.serverSource, "bundled");
    assert.equal(result.locations[0]?.path, expectedPath);
  } finally {
    analysis.dispose();
  }
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test("bundled TypeScript server resolves a cross-file definition", { timeout: 30_000 }, async () => expectSemanticDefinition({
  family: "typescript", path: "src/app.ts", line: 1, column: 23, symbol: "target", expectedPath: "src/target.ts", server: "typescript-language-server",
  prepare(root) {
    write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2022" }, include: ["src"] }));
    write(root, "src/target.ts", "export function target() { return 42; }\n");
    write(root, "src/app.ts", "import { target } from './target';\nexport const value = target();\n");
  },
}));

test("bundled Pyright resolves a cross-file definition", { timeout: 30_000 }, async () => expectSemanticDefinition({
  family: "python", path: "src/app.py", line: 1, column: 10, symbol: "target", expectedPath: "src/target.py", server: "pyright-langserver",
  prepare(root) {
    write(root, "pyrightconfig.json", JSON.stringify({ include: ["src"] }));
    write(root, "src/target.py", "def target() -> int:\n    return 42\n");
    write(root, "src/app.py", "from target import target\nvalue = target()\n");
  },
}));

test("bundled gopls resolves a cross-file definition", {
  timeout: 45_000,
  skip: !bundled.go || !existsSync(bundled.go),
}, async () => expectSemanticDefinition({
  family: "go", path: "app.go", line: 2, column: 13, symbol: "Target", expectedPath: "target.go", server: "gopls",
  prepare(root) {
    write(root, "go.mod", "module example.com/sample\n\ngo 1.24\n");
    write(root, "target.go", "package sample\n\nfunc Target() int { return 42 }\n");
    write(root, "app.go", "package sample\n\nvar Value = Target()\n");
  },
}));

test("bundled rust-analyzer resolves a cross-file definition", {
  timeout: 45_000,
  skip: !bundled.rust || !existsSync(bundled.rust),
}, async () => expectSemanticDefinition({
  family: "rust", path: "src/lib.rs", line: 2, column: 25, symbol: "target", expectedPath: "src/target.rs", server: "rust-analyzer",
  prepare(root) {
    write(root, "Cargo.toml", "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    write(root, "src/target.rs", "pub fn target() -> i32 { 42 }\n");
    write(root, "src/lib.rs", "mod target;\nuse target::target;\npub fn value() -> i32 { target() }\n");
  },
}));

test("bundled clangd resolves a header definition", {
  timeout: 30_000,
  skip: !bundled.clang || !existsSync(bundled.clang),
}, async () => expectSemanticDefinition({
  family: "clang", path: "main.c", line: 1, column: 25, symbol: "target", expectedPath: "target.h", server: "clangd",
  prepare(root) {
    write(root, "target.h", "static inline int target(void) { return 42; }\n");
    write(root, "main.c", "#include \"target.h\"\nint main(void) { return target(); }\n");
  },
}));

test("bundled JDT LS and JRE resolve a Java definition", {
  timeout: 45_000,
  skip: !bundled.java || !existsSync(bundled.java),
}, async () => expectSemanticDefinition({
  family: "java", path: "src/main/java/sample/App.java", line: 3, column: 17, symbol: "Target", expectedPath: "src/main/java/sample/Target.java", server: "eclipse-jdtls",
  prepare(root) {
    write(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>sample</artifactId><version>1</version></project>\n");
    write(root, "src/main/java/sample/Target.java", "package sample;\npublic final class Target { public int value() { return 42; } }\n");
    write(root, "src/main/java/sample/App.java", "package sample;\npublic final class App {\n  public int run() {\n    return new Target().value();\n  }\n}\n");
  },
}));

test("bundled official Kotlin LSP resolves a Gradle project definition", {
  timeout: 60_000,
  skip: !bundled.kotlin || !existsSync(bundled.kotlin),
}, async () => expectSemanticDefinition({
  family: "kotlin", path: "src/main/kotlin/demo/App.kt", line: 1, column: 14, symbol: "Target", expectedPath: "src/main/kotlin/demo/Target.kt", server: "kotlin-lsp",
  prepare(root) {
    write(root, "settings.gradle.kts", "rootProject.name = \"sample\"\n");
    write(root, "build.gradle.kts", "plugins { kotlin(\"jvm\") version \"2.2.20\" }\nrepositories { mavenCentral() }\n");
    write(root, "src/main/kotlin/demo/Target.kt", "package demo\nclass Target { fun value(): Int = 42 }\n");
    write(root, "src/main/kotlin/demo/App.kt", "package demo\nval result = Target().value()\n");
  },
}));

test("bundled Sorbet resolves a typed Ruby definition", {
  timeout: 30_000,
  skip: !bundled.ruby || !existsSync(bundled.ruby),
}, async () => expectSemanticDefinition({
  family: "ruby", path: "app.rb", line: 2, column: 2, symbol: "Target", expectedPath: "target.rb", server: "sorbet",
  prepare(root) {
    write(root, "target.rb", "# typed: true\nclass Target\n  def value = 42\nend\n");
    write(root, "app.rb", "# typed: true\nrequire_relative \"target\"\nTarget.new.value\n");
  },
}));

test("bundled static PHP runtime and Phpactor resolve a definition", {
  timeout: 30_000,
  skip: !bundled.php || !existsSync(bundled.php),
}, async () => expectSemanticDefinition({
  family: "php", path: "src/App.php", line: 2, column: 16, symbol: "Target", expectedPath: "src/Target.php", server: "phpactor",
  prepare(root) {
    write(root, "composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }));
    write(root, "src/Target.php", "<?php\nnamespace App;\nfinal class Target { public function value(): int { return 42; } }\n");
    write(root, "src/App.php", "<?php\nnamespace App;\n$result = (new Target())->value();\n");
  },
}));
