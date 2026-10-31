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

// `prewarm` gets a server past `initialize`; it does not get it past INDEXING. A cold JDT LS on a Maven
// project, or rust-analyzer on a fresh cargo tree, can still be building its model when the first definition
// request arrives, and the client's 8s request timeout then rejects — correctly, because interactively that
// is exactly what should happen: fail fast and show the regex index rather than freeze the navigation.
//
// The budget is deliberately below every test's own timeout below, so a bundle that really is broken fails
// with the reason the server gave rather than with a bare "test timed out", which says nothing.
const WARM_BUDGET_MS = 90_000;
const BUNDLE_TEST_TIMEOUT_MS = 150_000;

// So the first answer being "index" does not mean the bundle is broken, and asserting on it made this suite
// fail on whichever runner happened to be slowest that day (Java, on a release that had passed
// the identical job on the PR — and it took the release down with it). Ask again until the server is warm,
// inside the test's own budget. A bundle that never answers still fails, with the last reason it gave.
async function queryUntilWarm(analysis, request, family, budgetMs = WARM_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  let result = await analysis.query(request);
  while (result.engine !== "lsp" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result = await analysis.query(request);
  }
  assert.equal(
    result.engine,
    "lsp",
    `${family} never answered semantically within ${budgetMs}ms: ${result.fallbackReason ?? "no reason"}`,
  );
  return result;
}

async function expectSemanticDefinition({ family, path, line, column, symbol, expectedPath, server, prepare }) {
  const root = project();
  prepare(root);
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm([path]);
    const result = await queryUntilWarm(analysis, { kind: "definition", path, line, column, symbol }, family);
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

test("bundled TypeScript server resolves a cross-file definition", { timeout: BUNDLE_TEST_TIMEOUT_MS }, async () => expectSemanticDefinition({
  family: "typescript", path: "src/app.ts", line: 1, column: 23, symbol: "target", expectedPath: "src/target.ts", server: "typescript-language-server",
  prepare(root) {
    write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2022" }, include: ["src"] }));
    write(root, "src/target.ts", "export function target() { return 42; }\n");
    write(root, "src/app.ts", "import { target } from './target';\nexport const value = target();\n");
  },
}));

test("bundled Pyright resolves a cross-file definition", { timeout: BUNDLE_TEST_TIMEOUT_MS }, async () => expectSemanticDefinition({
  family: "python", path: "src/app.py", line: 1, column: 10, symbol: "target", expectedPath: "src/target.py", server: "pyright-langserver",
  prepare(root) {
    write(root, "pyrightconfig.json", JSON.stringify({ include: ["src"] }));
    write(root, "src/target.py", "def target() -> int:\n    return 42\n");
    write(root, "src/app.py", "from target import target\nvalue = target()\n");
  },
}));

test("bundled gopls resolves a cross-file definition", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.go || !existsSync(bundled.go),
}, async () => expectSemanticDefinition({
  family: "go", path: "app.go", line: 2, column: 13, symbol: "Target", expectedPath: "target.go", server: "gopls",
  prepare(root) {
    write(root, "go.mod", "module example.com/sample\n\ngo 1.24\n");
    write(root, "target.go", "package sample\n\nfunc Target() int { return 42 }\n");
    write(root, "app.go", "package sample\n\nvar Value = Target()\n");
  },
}));

// Inspections, end to end through the real product: a Go file that compiles cleanly and whose only defect
// is staticcheck's to find. gopls keeps staticcheck behind a setting and reads its settings by PULLING them
// with workspace/configuration, which this app used to answer with `{}` for every section — so this is the
// test that fails if that road goes dead again. The check id arrives in `source`, not in `code` (gopls
// leaves `code` as "default"), which is worth stating because reading `code` here looks right and finds
// nothing.
test("bundled gopls reports a staticcheck finding, so the pulled settings really arrived", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.go || !existsSync(bundled.go),
}, async () => {
  const root = project();
  write(root, "go.mod", "module example.com/sample\n\ngo 1.24\n");
  write(root, "check.go", [
    "package sample",
    "",
    "func Check(ok bool) bool {",
    "\tif ok == true {", // S1002: should omit comparison to bool constant
    "\t\treturn true",
    "\t}",
    "\treturn false",
    "}",
    "",
  ].join("\n"));
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm(["check.go"]);
    const deadline = Date.now() + WARM_BUDGET_MS;
    let found = [];
    let last = null;
    while (Date.now() < deadline) {
      last = await analysis.diagnostics("check.go");
      found = (last.diagnostics ?? []).filter((d) => /^(S|SA|ST|QF)\d+$/.test(d.source ?? ""));
      if (found.length) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.ok(found.length > 0,
      `gopls reported no staticcheck finding on a file whose only defect is one; it answered: `
      + JSON.stringify((last?.diagnostics ?? []).map((d) => [d.source, d.severity, d.message])));
    assert.equal(found[0].severity, "warning", "staticcheck findings are warnings, not errors");
  } finally {
    analysis.dispose();
  }
});

// Rust diagnostics end to end through the real product, and deliberately on the FIRST call: the viewer asks
// once per file and caches the answer, so an assertion that polls would pass on a build where the first read
// returns empty — which is exactly the bug this covers. rust-analyzer publishes an empty set for the open
// document before it has compiled anything (measured at 1.6s, with the real findings at 3.7s), so the read
// has to wait for the `cargo check` it announces as work-done progress.
// The decorations half of the same road the staticcheck test guards: gopls registers providers for all
// three of these and then answers an empty array until its settings arrive. Measured on this fixture,
// before the settings existed: 0 semantic tokens and 0 inlay hints, so every Go file in the app was read
// with the hand-written tokenizer and nothing said why.
test("bundled gopls answers semantic tokens and inlay hints, which it does only when configured", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.go || !existsSync(bundled.go),
}, async () => {
  const root = project();
  write(root, "go.mod", "module example.com/sample\n\ngo 1.24\n");
  write(root, "hints.go", [
    "package sample",
    "",
    "func Total(sides []float64) float64 {",
    "\tvar sum float64",           // assignVariableTypes / rangeVariableTypes land here
    "\tfor _, side := range sides {",
    "\t\tsum += side",
    "\t}",
    "\treturn sum",
    "}",
    "",
  ].join("\n"));
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm(["hints.go"]);
    const tokens = await analysis.query({ kind: "semanticTokens", path: "hints.go", line: 0, column: 0 });
    assert.equal(tokens.engine, "lsp", "the tokens came from gopls, not from the fallback tokenizer");
    assert.ok((tokens.tokens ?? []).length > 0, "gopls returned no semantic tokens — ui.semanticTokens is off again");
    const hints = await analysis.query({ kind: "inlayHint", path: "hints.go", line: 0, column: 0 });
    assert.ok((hints.hints ?? []).length > 0, "gopls returned no inlay hints — the hints settings are off again");
  } finally {
    analysis.dispose();
  }
});

// The range half: rust-analyzer refuses a range that runs past the file instead of clamping it, so this
// fails with `Invalid offset LineCol` — not an empty list — if the window is ever sent unclamped again.
test("bundled rust-analyzer answers inlay hints for a file far shorter than the window asked for", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.rust || !existsSync(bundled.rust),
}, async () => {
  const root = project();
  write(root, "Cargo.toml", "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  write(root, "src/lib.rs", "pub fn total(values: &[f64]) -> f64 {\n    let sum = values.iter().sum();\n    sum\n}\n");
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm(["src/lib.rs"]);
    const hints = await analysis.query({ kind: "inlayHint", path: "src/lib.rs", line: 0, column: 0 });
    assert.equal(hints.engine, "lsp",
      `the hint request fell back to the index instead of being answered: ${hints.fallbackReason ?? ""}`);
    assert.ok((hints.hints ?? []).length > 0, "rust-analyzer returned no hints for a file that has an inferred type");
  } finally {
    analysis.dispose();
  }
});

test("bundled rust-analyzer reports rustc findings on the first read, not an empty list", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.rust || !existsSync(bundled.rust),
}, async () => {
  const root = project();
  write(root, "Cargo.toml", "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  write(root, "src/main.rs", [
    "fn main() {",
    "    let unused_local = 5;", // unused_variables: a warning rustc finds, not rust-analyzer
    "    return;",
    "    println!(\"unreachable\");", // unreachable_code
    "}",
    "",
  ].join("\n"));
  const analysis = new ProjectAnalysis(root);
  try {
    const answer = await analysis.diagnostics("src/main.rs");
    const rustc = (answer.diagnostics ?? []).filter((d) => d.source === "rustc");
    assert.ok(rustc.length > 0,
      `the first read of a Rust file with two rustc warnings reported nothing; it answered: `
      + JSON.stringify([answer.available, answer.engine, (answer.diagnostics ?? []).map((d) => [d.source, d.severity, d.message])]));
    assert.ok(rustc.some((d) => d.severity === "warning"), "rustc warnings land on the warning tier");
    // The hint half of rustc's pair ("prefix it with an underscore") is severity 4 on the wire; it is what
    // the weak tier exists for, and its presence here is the proof that Rust reaches all three tiers.
    assert.ok(rustc.some((d) => d.severity === "weak"), "and its suggestions land on the weak tier");
  } finally {
    analysis.dispose();
  }
});

test("bundled rust-analyzer resolves a cross-file definition", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
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
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.clang || !existsSync(bundled.clang),
}, async () => expectSemanticDefinition({
  family: "clang", path: "main.c", line: 1, column: 25, symbol: "target", expectedPath: "target.h", server: "clangd",
  prepare(root) {
    write(root, "target.h", "static inline int target(void) { return 42; }\n");
    write(root, "main.c", "#include \"target.h\"\nint main(void) { return target(); }\n");
  },
}));

test("bundled JDT LS and JRE resolve a Java definition", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
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
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  // The bundled Kotlin intellij-server intermittently failed to register on a cold release runner (resolving
  // to the regex index instead of the LSP) even though the runner image, the checksum-pinned Kotlin artifact,
  // and this code were identical to releases where it passed. KAKAPO_SKIP_KOTLIN_GRADLE_SMOKE=1 keeps this one
  // heavy integration test from gating a release; it still runs anywhere the env var isn't set — which now
  // means locally, since the macOS release job skips the runtime lsp:smoke gate entirely.
  skip: !bundled.kotlin || !existsSync(bundled.kotlin) || process.env.KAKAPO_SKIP_KOTLIN_GRADLE_SMOKE === "1",
}, async () => expectSemanticDefinition({
  family: "kotlin", path: "src/main/kotlin/demo/App.kt", line: 1, column: 14, symbol: "Target", expectedPath: "src/main/kotlin/demo/Target.kt", server: "kotlin-lsp",
  prepare(root) {
    write(root, "settings.gradle.kts", "rootProject.name = \"sample\"\n");
    write(root, "build.gradle.kts", "plugins { kotlin(\"jvm\") version \"2.2.20\" }\nrepositories { mavenCentral() }\n");
    write(root, "src/main/kotlin/demo/Target.kt", "package demo\nclass Target { fun value(): Int = 42 }\n");
    write(root, "src/main/kotlin/demo/App.kt", "package demo\nval result = Target().value()\n");
  },
}));

// ⌘F7 in a Ruby file. sorbet refuses documentHighlight with an error — not an empty list — unless it is
// launched with its own experimental flag, so this is the test that notices if the flag is dropped from
// the argv. Instance variables answer empty even with it on; a local, a class and a method do not.
test("bundled Sorbet answers an in-file highlight, which it refuses without its flag", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.ruby || !existsSync(bundled.ruby),
}, async () => {
  const root = project();
  write(root, "main.rb", "# typed: true\nclass Box\n  def area = 4\nend\nbox = Box.new\nputs box.area\n");
  const analysis = new ProjectAnalysis(root);
  try {
    const answer = await analysis.query({ kind: "documentHighlight", path: "main.rb", line: 4, column: 0 }); // `box`
    assert.equal(answer.engine, "lsp",
      `the highlight fell back to the index instead of being answered: ${answer.fallbackReason ?? ""}`);
    assert.ok((answer.highlights ?? []).length >= 2, "both occurrences of the local came back");
  } finally {
    analysis.dispose();
  }
});

test("bundled Sorbet resolves a typed Ruby definition", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.ruby || !existsSync(bundled.ruby),
}, async () => expectSemanticDefinition({
  family: "ruby", path: "app.rb", line: 2, column: 2, symbol: "Target", expectedPath: "target.rb", server: "sorbet",
  prepare(root) {
    write(root, "target.rb", "# typed: true\nclass Target\n  def value = 42\nend\n");
    write(root, "app.rb", "# typed: true\nrequire_relative \"target\"\nTarget.new.value\n");
  },
}));

test("bundled static PHP runtime and Phpactor resolve a definition", {
  timeout: BUNDLE_TEST_TIMEOUT_MS,
  skip: !bundled.php || !existsSync(bundled.php),
}, async () => expectSemanticDefinition({
  family: "php", path: "src/App.php", line: 2, column: 16, symbol: "Target", expectedPath: "src/Target.php", server: "phpactor",
  prepare(root) {
    write(root, "composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }));
    write(root, "src/Target.php", "<?php\nnamespace App;\nfinal class Target { public function value(): int { return 42; } }\n");
    write(root, "src/App.php", "<?php\nnamespace App;\n$result = (new Target())->value();\n");
  },
}));
