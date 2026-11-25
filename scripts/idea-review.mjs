#!/usr/bin/env node
// The plugin's own format, run rather than read, and then read back by kakapo's own reader.
//
// This cannot live in `npm test`: the Kotlin needs a JDK and Gradle, and `intellij-plugin/` is
// deliberately outside the suite for that reason — a round trip put there fails on CI, which has
// neither, and the only way to make it pass there is to skip it, which is a gate that is green for
// the wrong reason. So it is one deliberate command instead, beside the other two.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeWhenThisProcessEnds, scratchDirectory } from "./lib/scratch-dir.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reader = join(repoRoot, "dist", "comments-file.js");
if (!existsSync(reader)) {
  console.error(`No ${reader} to read the records back with. Run: npm run build`);
  process.exit(1);
}
const { readThread } = await import(reader);

const scratch = scratchDirectory({ prefix: "kakapo-idea-review-" });
removeWhenThisProcessEnds(scratch);
const emitted = join(scratch.path, "comments.jsonl");

const gradle = spawnSync("node", [join(repoRoot, "scripts/gradle-with-bundled-jdk.mjs"), "reviewCheck", `-Pemit=${emitted}`], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, JAVA_HOME: undefined },
});
if (gradle.status !== 0) process.exit(gradle.status ?? 1);

const raw = readFileSync(emitted, "utf8");
const records = readThread(emitted);

// A reader that returned nothing would make every assertion below vacuous.
assert.equal(records.length, 3, `kakapo read what the plugin wrote: ${raw}`);

const [first, second, third] = records;
assert.equal(first.path, "src/a.ts");
assert.equal(first.line, 3);
assert.equal(first.text, "Name this.");

assert.equal(second.text, 'Quote "here"\nand a second line.',
  "quotes and newlines survive the plugin's own encoder");
assert.equal(second.view, "diff", "a comment written in the Diff window says so");
assert.equal(second.side, "old", "and says which side of it, or kakapo reopens the wrong line");

assert.equal(third.addressed, true, "an archived comment reads as archived");
assert.equal(records.filter((record) => record.addressed).length, 1, "and the others do not");

for (const record of records) {
  assert.ok(Number.isFinite(record.id), "every record has the id kakapo threads replies by");
  assert.ok(record.anchor, "and the anchor kakapo re-finds the line with");
}

console.log(`ok   kakapo's own reader understood all ${records.length} records the plugin wrote`);
