// Unit coverage for the CLI flag parsing extracted from app-main. app-main exports nothing and needs a live
// Electron process, so its arg handling was untestable; the pure parser now pins the flag semantics —
// option values, --staged/--base exclusivity, context validation, defaults — without git or Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readOption, parsePositiveInteger, parseReviewArgs } from "../dist/cli-args.js";

test("readOption returns the value after a flag, or undefined when absent", () => {
  assert.equal(readOption(["--base", "main"], "--base"), "main");
  assert.equal(readOption(["--staged"], "--base"), undefined);
});

test("readOption throws when a flag is present but its value is missing or another flag", () => {
  assert.throws(() => readOption(["--base"], "--base"), /Missing value for --base/);
  assert.throws(() => readOption(["--base", "--staged"], "--base"), /Missing value for --base/);
});

test("parsePositiveInteger accepts non-negative integers and rejects the rest", () => {
  assert.equal(parsePositiveInteger("12", "--context"), 12);
  assert.equal(parsePositiveInteger("0", "--context"), 0);
  assert.throws(() => parsePositiveInteger("-1", "--context"), /--context must be a non-negative integer/);
  assert.throws(() => parsePositiveInteger("3.5", "--context"), /non-negative integer/);
});

test("parseReviewArgs: defaults", () => {
  assert.deepEqual(parseReviewArgs([]), {
    requestedCwd: undefined, staged: false, baseValue: undefined,
    includeUntracked: false, context: 12, watch: true, ignoreWhitespace: false,
  });
});

test("parseReviewArgs: flags are read through", () => {
  assert.deepEqual(parseReviewArgs(["--cwd", "/repo", "--base", "main", "--context", "5", "--include-untracked", "--no-watch", "--ignore-whitespace"]), {
    requestedCwd: "/repo", staged: false, baseValue: "main",
    includeUntracked: true, context: 5, watch: false, ignoreWhitespace: true,
  });
});

test("parseReviewArgs: --staged and --base are mutually exclusive", () => {
  assert.throws(() => parseReviewArgs(["--staged", "--base", "main"]), /either --staged or --base/);
});

test("parseReviewArgs: --no-watch flips the default watch on", () => {
  assert.equal(parseReviewArgs([]).watch, true);
  assert.equal(parseReviewArgs(["--no-watch"]).watch, false);
});


// `--help` is the only place a flag is discoverable from outside the source, and the parser is where flags
// are actually added — so the two drift silently. Read the flags out of the parser itself and require the
// help to name each one; adding a flag now fails here until it is documented.
test("every flag the parser understands is named in --help", () => {
  const parser = readFileSync(fileURLToPath(new URL("../dist/cli-args.js", import.meta.url)), "utf8");
  const flags = new Set(Array.from(parser.matchAll(/"(--[a-z][a-z-]*)"/g), (m) => m[1]));
  assert.ok(flags.size >= 6, `expected the parser to declare flags, found ${[...flags].join(", ") || "none"}`);

  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  const missing = [...flags].filter((flag) => !help.includes(flag));
  assert.deepEqual(missing, [], "flags the parser accepts but --help never mentions");
});
