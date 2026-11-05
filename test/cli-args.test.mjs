// Unit coverage for the CLI flag parsing extracted from app-main. app-main exports nothing and needs a live
// Electron process, so its arg handling was untestable; the pure parser now pins the flag semantics —
// option values, --staged/--base exclusivity, context validation, defaults — without git or Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSelectionFor, readOption, parsePositiveInteger, parseReviewArgs } from "../dist/cli-args.js";

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
    requestedCwd: undefined,
    openPath: undefined,
    openedExplicitly: false, staged: false, baseValue: undefined,
    includeUntracked: false, context: 12, watch: true, ignoreWhitespace: false, whitespace: "none",
  });
});

test("parseReviewArgs: flags are read through", () => {
  assert.deepEqual(parseReviewArgs(["--cwd", "/repo", "--base", "main", "--context", "5", "--include-untracked", "--no-watch", "--ignore-whitespace"]), {
    requestedCwd: "/repo", openPath: undefined, openedExplicitly: false, staged: false, baseValue: "main",
    includeUntracked: true, context: 5, watch: false, ignoreWhitespace: true, whitespace: "all",
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
  // Flags the CLI derives and passes inward; nobody types them, and documenting them would advertise
  // plumbing. The `kakapo <path>` form they implement IS in the help.
  const INTERNAL = new Set(["--open", "--opened"]);
  const flags = new Set(Array.from(parser.matchAll(/"(--[a-z][a-z-]*)"/g), (m) => m[1]).filter((f) => !INTERNAL.has(f)));
  assert.ok(flags.size >= 6, `expected the parser to declare flags, found ${[...flags].join(", ") || "none"}`);

  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  const missing = [...flags].filter((flag) => !help.includes(flag));
  assert.deepEqual(missing, [], "flags the parser accepts but --help never mentions");
});

// An unknown flag opens the review app, which is right for a command whose job is "open this repo" — but
// it swallowed `--version`, so the one question you ask after installing launched a window instead of
// answering. --help was always handled; --version only looked like it was.
test("--version answers instead of opening the app", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const flag of ["--version", "-v"]) {
    const out = execFileSync(process.execPath, [cli, flag], { encoding: "utf8" }).trim();
    assert.equal(out, version, `${flag} prints the version`);
  }
  assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /--version, -v/,
    "and the help says it exists");
});

// The flags are checked HERE, in the process the person typed them in, not only inside the app.
//
// The app checks them too, but it is spawned detached with its stdio discarded, so `kakapo --base mian`
// printed "Opened kakapo review app.", exited 0, and no window ever appeared: the one message that
// explained it went to a pipe pointed at nothing. The CLI must refuse first, and say why, and say so
// with an exit code.
test("the CLI refuses review flags it cannot honour, instead of launching into nothing", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), "kakapo-cli-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@kakapo.test"]);
  git(["config", "user.name", "kakapo test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return { status: error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
    }
  };

  for (const [args, pattern] of [
    [["--base", "no-such-ref-xyz"], /not a commit in this repository/],
    [["--staged", "--base", "HEAD"], /either --staged or --base/],
    [["--context", "zero"], /--context/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(" ")} fails`);
    assert.match(result.stderr, pattern, `${args.join(" ")} says why`);
    assert.doesNotMatch(result.stdout, /Opened kakapo review app/, `${args.join(" ")} does not claim success`);
  }
  rmSync(repo, { recursive: true, force: true });
});

// A second folder opened by the SAME app is a different repository, and the launch's compare selection is
// not about it. The symptom was a window that never stopped loading: `kakapo --base HEAD~5` in one repo,
// then `kakapo` typed in a two-commit repo, which answered `fatal: bad revision 'HEAD~5'` and left the
// handed-over window on the loading mark for the rest of the session.
test("the compare selection stays in the repository it was typed in", () => {
  const launch = { base: "HEAD~5", baseLabel: undefined, staged: false };
  assert.deepEqual(compareSelectionFor("/repo", "/repo", launch), launch, "the launched repo keeps it");

  const elsewhere = compareSelectionFor("/repo", "/other", launch);
  assert.equal(elsewhere.base, undefined, "another repository gets no base");
  assert.equal(elsewhere.baseLabel, undefined, "and no label for one");
  assert.equal(elsewhere.staged, false, "and is not put into staged mode either");

  // Both halves: a branch name travels no better than a revision does.
  const named = { base: "main", baseLabel: "main", staged: true };
  assert.deepEqual(compareSelectionFor("/repo", "/repo", named), named);
  assert.deepEqual(compareSelectionFor("/repo", "/other", named), { base: undefined, baseLabel: undefined, staged: false });
});
