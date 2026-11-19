import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeWhenThisProcessEnds, scratchDirectory } from "../scripts/lib/scratch-dir.mjs";

const module = fileURLToPath(new URL("../scripts/lib/scratch-dir.mjs", import.meta.url));
const homes = [];
function base() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-scratch-test-"));
  homes.push(dir);
  return dir;
}
test.after(() => { while (homes.length) rmSync(homes.pop(), { recursive: true, force: true }); });

test("a directory the bench made for itself is the one it removes", () => {
  const home = base();
  const scratch = scratchDirectory({ base: home, prefix: "run-" });
  writeFileSync(join(scratch.path, "artifact.bin"), "x".repeat(1024));

  assert.equal(scratch.owned, true);
  assert.ok(existsSync(scratch.path));
  assert.equal(scratch.cleanup(), true);
  assert.equal(existsSync(scratch.path), false, "the directory is gone from disk, not just from the bookkeeping");
  assert.equal(scratch.cleanup(), false, "a second cleanup has nothing to do and must not claim otherwise");
  assert.deepEqual(readdirSync(home), []);
});

test("a directory the caller supplied belongs to the caller", () => {
  const home = base();
  const given = join(home, "mine");
  mkdtempSync(join(home, "unrelated-"));
  const scratch = scratchDirectory({ given, base: home, prefix: "run-" });

  assert.equal(scratch.path, given);
  assert.equal(scratch.owned, false);
  assert.equal(scratch.cleanup(), false);
  assert.equal(readdirSync(home).length, 1, "nothing was created for a caller who named their own directory");
});

test("CACHE_BENCH_KEEP leaves the run on disk to look at", () => {
  const home = base();
  const scratch = scratchDirectory({ base: home, prefix: "run-", keep: true });

  assert.equal(scratch.cleanup(), false);
  assert.ok(existsSync(scratch.path), "a kept directory survives its own cleanup");
});

test("a run that throws still takes its directory with it", () => {
  const home = base();
  const source = `
    const { removeWhenThisProcessEnds, scratchDirectory } = await import(${JSON.stringify(module)});
    const scratch = scratchDirectory({ base: ${JSON.stringify(home)}, prefix: "run-" });
    removeWhenThisProcessEnds(scratch, (path, removed) => console.log(removed ? "removed " + path : "kept " + path));
    throw new Error("the corpus was too big");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });

  assert.notEqual(run.status, 0, "the failure is still a failure");
  assert.match(run.stdout, /^removed /m, "it says which directory it removed");
  assert.deepEqual(readdirSync(home), [], "a run that died left nothing behind");
});

test("a run that is interrupted still takes its directory with it", async () => {
  const home = base();
  const source = `
    const { removeWhenThisProcessEnds, scratchDirectory } = await import(${JSON.stringify(module)});
    const scratch = scratchDirectory({ base: ${JSON.stringify(home)}, prefix: "run-" });
    removeWhenThisProcessEnds(scratch, (path, removed) => console.log(removed ? "removed " + path : "kept " + path));
    console.log("measuring");
    setInterval(() => undefined, 1000);
  `;
  const run = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  await new Promise((done) => {
    run.stdout.on("data", (chunk) => {
      said += chunk.toString();
      if (said.includes("measuring")) done();
    });
  });
  run.kill("SIGTERM");
  await new Promise((done) => run.once("close", done));

  assert.match(said, /^removed /m, "it says which directory it removed");
  assert.deepEqual(readdirSync(home), [], "an interrupted run left nothing behind");
});

test("without the handler an interrupted run leaves the directory, which is what this guards", () => {
  const home = base();
  const source = `
    const { scratchDirectory } = await import(${JSON.stringify(module)});
    scratchDirectory({ base: ${JSON.stringify(home)}, prefix: "run-" });
    throw new Error("the corpus was too big");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.equal(readdirSync(home).length, 1, "this is the leak the handler exists to stop");
});

test("the bench wires its cache base through the helper", () => {
  const source = spawnSync("cat", [fileURLToPath(new URL("../scripts/server-cache-bench.mjs", import.meta.url))], { encoding: "utf8" }).stdout;
  assert.match(source, /scratchDirectory\(\{[\s\S]*given: process\.env\.CACHE_BENCH_TMPDIR/,
    "a directory the caller named must not be removed by the bench");
  assert.match(source, /removeWhenThisProcessEnds\(scratch/,
    "the bench must register the cleanup, not only create the directory");
  assert.doesNotMatch(source, /mkdtempSync/,
    "the bench must not make a cache base of its own outside the helper");
});
