import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceRoot } from "../dist/git.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("workspace identity normalizes nested folders but keeps worktrees distinct", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-single-instance-"));
  try {
    const repo = join(base, "repo");
    const nested = join(repo, "packages", "app");
    const worktree = join(base, "feature-worktree");
    mkdirSync(nested, { recursive: true });
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Kakapo Test");
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo });
    git(repo, "worktree", "add", "-b", "feature/test", worktree);

    assert.equal(resolveWorkspaceRoot(nested), resolveWorkspaceRoot(repo));
    assert.notEqual(resolveWorkspaceRoot(worktree), resolveWorkspaceRoot(repo));
    assert.equal(resolveWorkspaceRoot(join(worktree, ".")), resolveWorkspaceRoot(worktree));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("desktop composition is one BrowserWindow per repository", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(source, /requestSingleInstanceLock\(\{ workspaceRoot: options\.root, explicitRoot: options\.explicitRoot \}\)/);
  // A second launch in the SAME repository focuses the window already reviewing it; another repository gets
  // its own. That is the whole of the multi-window story now — no shell, no views, no detached hosts.
  assert.match(source, /function openOrFocusWorkspace/);
  assert.doesNotMatch(source, /new WebContentsView/, "a review is a window, not a view inside a shell");
  assert.doesNotMatch(source, /function activateWorkspace/, "there is no workspace to activate");
  assert.equal((source.match(/new BrowserWindow\(/g) || []).length, 1,
    "exactly one place makes a window, and it makes the review's own");
});

// The second-instance handler must not read `--cwd` off the forwarded command line while BUILDING its
// request. Electron does not forward the command line the second process was given: Chromium parses it,
// keeps switches and loose arguments in separate lists, and re-serialises them switches-first, so `--cwd`
// arrives as a VALUELESS switch with its path moved to the end. kakapo's option reader is right to reject a
// missing value on this app's own argv, and it throws on that one — which, read eagerly, escaped the
// handler and killed the handoff for every folder, repository or not, silently. The root is in
// additionalData; the command line is a fallback for a second instance old enough not to send one, and it
// is read lazily, inside handoffRoot, which fences it. Pinned as text because no test can reach the real
// event: it needs two live Electron processes.
test("the handoff does not read the forwarded command line until it has to", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const handler = source.match(/app\.on\("second-instance"[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler, "the second-instance handler is still here");
  assert.match(handler, /commandLineRoot: \(\) => readOption\(commandLine, "--cwd"\)/,
    "the command-line read is a thunk, so it only runs when additionalData named nothing");
  assert.doesNotMatch(handler, /commandLineRoot: readOption\(/,
    "and never an eager call, whose throw took the whole handoff with it");
});

// The one predicate every entrance asks. It used to be `isGitRepository` in five places, which is the wrong
// question in both directions: a plain source tree reviews fine, and a path that vanished cannot open
// whether git knows it or not.
test("one predicate decides what folder this app can open", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(source, /function isReviewableFolder\(path: string\): boolean \{/);
  assert.match(source, /new AppPreferences\(app\.getPath\("userData"\), isReviewableFolder\)/,
    "what gets remembered as a recent project asks it too");
  // isGitRepository survives for the questions that really are about git — resolving a review base, the
  // welcome screen's "nobody told me where to go" test, and the handoff's unnamed-folder guard — but no
  // longer stands between the reader and a folder they named.
  for (const entrance of [
    /ipcMain\.handle\("kakapo:open-folder"[\s\S]*?\n\}\);/,
    /ipcMain\.handle\("kakapo:open-recent"[\s\S]*?\n\}\);/,
    /async function pickRepo\([\s\S]*?\n\}/,
  ]) {
    const block = source.match(entrance)?.[0];
    assert.ok(block, `entrance ${entrance} is still here`);
    assert.doesNotMatch(block, /isGitRepository/, "an entrance does not ask git whether a folder may be opened");
    assert.match(block, /isReviewableFolder/);
  }
});
