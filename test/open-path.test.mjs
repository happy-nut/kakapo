// CORE USER FLOW: `kakapo <path>`. A bare argument is the thing to open — a folder, or a single file, with
// or without git behind it. The file case is how you read something that was never going to be committed
// (a design note under ~/.claude); before this it opened a window that sat on its loading mark for ever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseReviewArgs } from "../dist/cli-args.js";
import { enumerateProjectPaths, collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "../dist/diff.js";
import { initialReviewSources } from "../dist/render-tree.js";

function folderWithoutGit() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-nogit-"));
  mkdirSync(join(root, "design"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(root, "design", "PLAN.md"), "# Plan\n\nnot in any repository.\n");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  writeFileSync(join(root, "README.md"), "# Readme\n"); // what a clean tree opens by default
  writeFileSync(join(root, "node_modules", "junk", "index.js"), "module.exports = 1;\n");
  return root;
}

test("a folder with no repository has an empty diff, not an exception", () => {
  const root = folderWithoutGit();
  try {
    assert.equal(readUnifiedDiff({ staged: false, context: 12, includeUntracked: true, root }), "",
      "no repository means no diff — the review is the source tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without git, the project index comes from a bounded filesystem walk", () => {
  const root = folderWithoutGit();
  try {
    const paths = enumerateProjectPaths(root, new Set());
    assert.deepEqual([...paths].sort(), ["README.md", "design/PLAN.md", "notes.md"], "every readable file");
    assert.ok(!paths.some((p) => p.includes("node_modules")), "and nothing from node_modules");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file named on the command line leads the initial sources, so the first paint has its content", () => {
  const root = folderWithoutGit();
  try {
    const sources = collectSourceFiles(parseUnifiedDiff(""), root, { previewLargeText: true, deferSourceContent: true });
    assert.ok(sources.length >= 2, "both files are in the index");

    const lazy = initialReviewSources([], sources, "design/PLAN.md");
    assert.equal(lazy[0]?.path, "design/PLAN.md", "the requested file leads");

    // Without it the lazy path ships what a clean tree always opens — the README, not the file you asked for.
    assert.equal(initialReviewSources([], sources)[0]?.path, "README.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--open carries the file the CLI resolved, and --cwd still parses beside it", () => {
  const parsed = parseReviewArgs(["--cwd", "/repo", "--open", "/repo/src/a.ts"]);
  assert.equal(parsed.requestedCwd, "/repo");
  assert.equal(parsed.openPath, "/repo/src/a.ts");
  assert.equal(parseReviewArgs(["--cwd", "/repo"]).openPath, undefined, "absent unless asked for");
});

// The flags the CLI accepts have to REACH the app. They did not: launchReviewApp forwarded only --cwd and a
// hard-coded context, so `kakapo --base main` silently reviewed the working tree while --help promised
// otherwise. A dry run prints the argv it would have launched.
test("the review flags survive the hop from the CLI into the app", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-flags-"));
  try {
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    // --help short-circuits before launching, so drive the parser the app itself uses instead: the contract
    // under test is that every flag below is understood on the far side of the hop.
    const parsed = parseReviewArgs(["--cwd", root, "--base", "main", "--context", "7", "--ignore-whitespace", "--no-watch"]);
    assert.equal(parsed.baseValue, "main");
    assert.equal(parsed.context, 7);
    assert.equal(parsed.ignoreWhitespace, true);
    assert.equal(parsed.watch, false);

    // And that the CLI actually emits them. It refuses a path that does not exist, which is the one
    // observable it gives without launching Electron.
    const missing = join(root, "nope");
    assert.throws(() => execFileSync(process.execPath, [cli, missing], { encoding: "utf8", stdio: "pipe" }),
      /Path does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// REGRESSION: a GUI launch (Launchpad, Spotlight, the Applications icon from `kakapo install-app`) inherits
// "/" as its cwd and names no path. The welcome screen exists for exactly that — but the flag that decides
// it, explicitRoot, was hardcoded true for every window, so "/" read as a deliberate choice and the build
// worker set off walking the whole filesystem. The CLI marks a named path; nothing else may claim to be one.
test("only a NAMED path counts as explicit — an inherited cwd does not", () => {
  assert.equal(parseReviewArgs(["--cwd", "/"]).openedExplicitly, false,
    "--cwd alone is how the CLI forwards whatever cwd it started in");
  assert.equal(parseReviewArgs(["--cwd", "/repo", "--opened"]).openedExplicitly, true,
    "--opened is the marker the CLI adds when the user actually named somewhere");
});

test("a terminal launch always names its folder; only the GUI can be unmarked", () => {
  // The marker separates "told where to go" from "inherited a cwd". The second one is a GUI launch —
  // Launchpad, Spotlight, the Applications icon — which comes up in "/" and must reach the picker instead
  // of indexing the whole filesystem. That is a real hazard and this guard still covers it; what changed is
  // WHERE the line falls.
  //
  // It used to be drawn inside the CLI: `kakapo /some/path` counted as naming a place and a bare `kakapo`
  // did not. But both of those are someone typing in a terminal, and the directory they typed in is as
  // clear a statement of where to go as an argument is — so typing `kakapo` in a folder that is not a git
  // repository opened the folder picker instead of the folder they were standing in. A git repository hid
  // it, because bootWindow's welcome test needs BOTH no marker and no repository.
  //
  // The GUI cannot reach this file at all, and that is the fact the rule rests on, so assert it: `main` is
  // what the icon starts and `bin` is what a shell runs. If those ever became the same entry point, a GUI
  // launch would start sending --opened and "/" would read as a choice again — which is the regression this
  // test is named after, and it would land here rather than in someone's fan.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "dist/app-main.js", "the GUI starts the app directly");
  assert.equal(pkg.bin?.kakapo, "bin/kakapo.js", "and the terminal goes through the CLI");
  assert.notEqual(pkg.main, pkg.bin?.kakapo, "two entry points, which is what lets the CLI speak for all of its launches");

  const cli = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8");
  assert.match(cli, /^\s*appArgs\.push\("--opened"\);/m,
    "so every launch through it is marked, named path or not");
  assert.doesNotMatch(cli, /if \(named !== undefined\) appArgs\.push\("--opened"\);/,
    "and not only the ones that named a path");
});
