#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const driver = join(root, "docs", "intellij", "StackTraceOracle.java");
const corpus = join(root, "test", "fixtures", "stack-trace-corpus.txt");
const out = join(root, "test", "fixtures", "stack-trace-oracle.json");

const IDES = [
  "/Applications/IntelliJ IDEA.app/Contents",
  "/Applications/IntelliJ IDEA CE.app/Contents",
  "/Applications/IntelliJ IDEA Ultimate.app/Contents",
];

function fail(message) {
  console.error(message);
  process.exit(2);
}

const ide = IDES.find((path) => existsSync(join(path, "plugins", "java", "lib", "java-impl.jar")));
if (!ide) {
  fail("no installed IntelliJ with plugins/java/lib/java-impl.jar — install IntelliJ IDEA (CE is enough) "
    + "to re-capture this fixture, or leave test/fixtures/stack-trace-oracle.json as it is.");
}
try {
  execFileSync("javac", ["-version"], { stdio: "ignore" });
} catch {
  fail("javac is not on PATH — a JDK is needed to run IntelliJ's own parser.");
}

const jars = execFileSync("/bin/sh", ["-c", `ls ${JSON.stringify(join(ide, "lib"))}/*.jar`], { encoding: "utf8" })
  .trim().split("\n");
const classpath = [join(ide, "plugins", "java", "lib", "java-impl.jar"), ...jars].join(":");

const work = mkdtempSync(join(tmpdir(), "kakapo-stack-oracle-"));
try {
  execFileSync("javac", ["-nowarn", "-cp", classpath, "-d", work, driver], { stdio: "inherit" });
  const json = execFileSync("java", ["-cp", `${work}:${classpath}`, "StackTraceOracle", corpus], { encoding: "utf8" });
  const rows = JSON.parse(json);
  const corpusLines = readFileSync(corpus, "utf8").split("\n").filter((line) => line.length > 0 && !line.startsWith("#SKIP"));
  if (rows.length !== corpusLines.length) {
    fail(`the parser answered ${rows.length} of ${corpusLines.length} corpus lines — the driver dropped some.`);
  }
  const frames = rows.filter((row) => row.frame).length;
  if (frames === 0) fail("not one corpus line parsed as a frame — the classpath resolved but the parser did nothing.");
  if (frames === rows.length) fail("every corpus line parsed as a frame — the corpus has lost its negative cases.");
  writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
  console.log(`${out}: ${rows.length} lines, ${frames} frames, ${rows.length - frames} not frames`);
  console.log(`captured from ${ide.replace("/Contents", "")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
