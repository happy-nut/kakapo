import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildZip } from "./helpers/zip.mjs";
import {
  bundledDecompilerJar,
  bundledJavaBinary,
  decompiledClassText,
  resetDecompiledClassCache,
  splitClassUri,
} from "../dist/class-decompile.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(repoRoot, "vendor", "language-servers");
const bundled = bundledJavaBinary({ KAKAPO_LSP_BUNDLE_ROOT: bundle });
const decompiler = bundledDecompilerJar({ KAKAPO_LSP_BUNDLE_ROOT: bundle });

test("a jar URI is split into the archive and the class inside it", () => {
  assert.deepEqual(
    splitClassUri("jar:///Users/a/.gradle/x/spring-batch-core-5.1.2.jar!/org/b/RunIdIncrementer.class"),
    { archive: "/Users/a/.gradle/x/spring-batch-core-5.1.2.jar", entry: "org/b/RunIdIncrementer.class" },
  );
  assert.deepEqual(
    splitClassUri("/Users/a/guava.jar!/com/google/common/base/Joiner.class"),
    { archive: "/Users/a/guava.jar", entry: "com/google/common/base/Joiner.class" },
  );
  assert.equal(splitClassUri("jar:///Users/a/x.jar!/pkg/Name.java"), null, "only a class file is decompiled");
  assert.equal(splitClassUri("jdt://contents/rt.jar/java.util/List.class"), null, "jdtls answers its own scheme");
  assert.equal(splitClassUri("file:///Users/a/src/Main.java"), null, "an ordinary file is read as a file");
  assert.equal(splitClassUri(""), null);
});

test("the bundle carries both halves of the reader", { skip: !existsSync(bundle) }, () => {
  assert.ok(bundled, "a java binary — a JDK since the Gradle toolchain needs a compiler");
  assert.ok(decompiler, "and JetBrains' decompiler, which jdtls ships");
});

test("a class out of a jar comes back as source", { skip: !bundled || !decompiler }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-decompile-test-"));
  try {
    const sample = sampleClassBytes();
    const jar = join(dir, "sample.jar");
    writeFileSync(jar, buildZip([{ name: "kakapo/Sample.class", bytes: sample }]));
    resetDecompiledClassCache();
    const text = decompiledClassText(`jar://${jar}!/kakapo/Sample.class`, { KAKAPO_LSP_BUNDLE_ROOT: bundle });
    assert.match(text, /class Sample/, "the decompiler names the type it was handed");
    assert.match(text, /int twice/, "and its members, which is what a reader followed the symbol for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anything the chain cannot read answers with nothing, not a throw", () => {
  assert.equal(decompiledClassText("jar:///nowhere/x.jar!/a/B.class"), undefined, "a jar that is not there");
  assert.equal(decompiledClassText("file:///Users/a/Main.java"), undefined, "a URI this does not handle");
});

function sampleClassBytes() {
  const javac = bundled ? bundled.replace(/java$/, "javac") : "";
  if (!javac || !existsSync(javac)) return Buffer.alloc(0);
  const dir = mkdtempSync(join(tmpdir(), "kakapo-javac-"));
  try {
    writeFileSync(join(dir, "Sample.java"), "package kakapo;\npublic class Sample { public int twice(int v) { return v * 2; } }\n");
    execFileSync(javac, ["-d", dir, join(dir, "Sample.java")], { stdio: "ignore" });
    return readFileSync(join(dir, "kakapo", "Sample.class"));
  } catch {
    return Buffer.alloc(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
