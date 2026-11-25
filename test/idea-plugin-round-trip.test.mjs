import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readThread } from "../dist/comments-file.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The plugin and kakapo agree on a file, and until now that agreement was only ever asserted by
// matching strings in each other's source. This writes the records with the plugin's own Kotlin and
// reads them back with kakapo's own reader, so a disagreement shows up as a disagreement.
function recordsWrittenByThePlugin() {
  const scratch = mkdtempSync(join(tmpdir(), "kakapo-round-trip-"));
  const out = join(scratch, "comments.jsonl");
  try {
    execFileSync("node", [join(repoRoot, "scripts/gradle-with-bundled-jdk.mjs"), "reviewCheck", `-Pemit=${out}`], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, JAVA_HOME: undefined },
    });
    return { raw: readFileSync(out, "utf8"), records: readThread(out), remove: () => rmSync(scratch, { recursive: true, force: true }) };
  } catch (failed) {
    rmSync(scratch, { recursive: true, force: true });
    throw failed;
  }
}

test("kakapo's own reader understands every record the plugin writes", { timeout: 300000 }, () => {
  const written = recordsWrittenByThePlugin();
  try {
    // A reader that returned nothing would make every assertion below vacuous.
    assert.equal(written.records.length, 3, `kakapo read what the plugin wrote: ${written.raw}`);

    const [first, second, third] = written.records;
    assert.equal(first.path, "src/a.ts");
    assert.equal(first.line, 3);
    assert.equal(first.text, "Name this.");

    assert.equal(second.text, 'Quote "here"\nand a second line.',
      "quotes and newlines survive the plugin's own encoder");
    assert.equal(second.view, "diff", "a comment written in the Diff window says so");
    assert.equal(second.side, "old", "and says which side of it, or kakapo reopens the wrong line");

    assert.equal(third.addressed, true, "an archived comment reads as archived");
    assert.equal(written.records.filter((record) => record.addressed).length, 1,
      "and the others do not");

    for (const record of written.records) {
      assert.ok(Number.isFinite(record.id), "every record has the id kakapo threads replies by");
      assert.ok(record.anchor, "and the anchor kakapo re-finds the line with");
    }
  } finally {
    written.remove();
  }
});
