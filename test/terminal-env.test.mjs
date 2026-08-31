// CORE USER FLOW: the integrated terminal opens a clean login shell.
//
// Launching kakapo through npm (`npm run dev`, or a global install behind an npm shim) injects
// npm_config_* vars into the process. Inheriting them into the pty makes nvm warn on every new shell
// ("nvm is not compatible with the npm_config_prefix environment variable") — which doesn't happen in
// iTerm. sanitizeTerminalEnv keeps the integrated terminal indistinguishable from the user's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sanitizeTerminalEnv, ensureUtf8Locale, tmuxSessionName, tmuxSessionsForRoot, tmuxSessionPrefix, unreachableSessions, unreachableTranscripts, transcriptSlug, nextTerminalOrdinal, tmuxSpawnArgs } from "../dist/util.js";

test("strips every npm_*-injected var (incl. the npm_config_prefix nvm rejects)", () => {
  const out = sanitizeTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    npm_config_prefix: "/Users/x/.nvm/versions/node/v22.22.2",
    npm_config_cache: "/Users/x/.npm",
    npm_lifecycle_event: "dev",
    npm_package_name: "@happy-nut/kakapo",
    npm_node_execpath: "/usr/bin/node",
  });
  assert.equal("npm_config_prefix" in out, false, "the var nvm rejects is gone");
  assert.equal(
    Object.keys(out).some((k) => k.startsWith("npm_")),
    false,
    "no npm_* var leaks into the shell",
  );
});

test("preserves the user's real shell environment", () => {
  const out = sanitizeTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
  });
  assert.deepEqual(out, {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
  });
});

// Launching kakapo from inside a Claude Code session leaves CLAUDE_CODE_CHILD_SESSION=1 in our env; a
// `claude` run in the integrated terminal would inherit it, decide it's a nested child, and stop saving its
// transcript — so the session is invisible to --resume.
test("strips the inherited CLAUDE_CODE_CHILD_SESSION marker", () => {
  const out = sanitizeTerminalEnv({
    PATH: "/usr/bin",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDECODE: "1",
  });
  assert.equal("CLAUDE_CODE_CHILD_SESSION" in out, false, "the pty shell starts as a top-level session");
  assert.equal(out.CLAUDECODE, "1", "other CLAUDE_* vars are left alone");
});

test("drops undefined holes and never mutates the input", () => {
  const input = { FOO: undefined, BAR: "1" };
  const out = sanitizeTerminalEnv(input);
  assert.equal("FOO" in out, false, "undefined values are dropped");
  assert.equal(out.BAR, "1");
  assert.deepEqual(input, { FOO: undefined, BAR: "1" }, "input object is untouched");
});

// A GUI launch (Finder/Spotlight/`mo`) hands us no LANG/LC_*, so git's `less` pager renders Korean commit
// messages as escaped bytes ("<EA><B5><AD>"). ensureUtf8Locale forces a UTF-8 codeset in that case.
test("forces a UTF-8 locale when none is set (the Finder-launch case)", () => {
  const out = ensureUtf8Locale({ PATH: "/usr/bin" });
  assert.equal(out.LANG, "en_US.UTF-8", "LANG defaults to a UTF-8 locale that exists on macOS");
});

test("leaves an already-UTF-8 locale untouched", () => {
  assert.equal(ensureUtf8Locale({ LANG: "ko_KR.UTF-8" }).LANG, "ko_KR.UTF-8");
  assert.equal(ensureUtf8Locale({ LC_ALL: "en_US.UTF-8" }).LANG, undefined, "no LANG added when LC_ALL is already UTF-8");
});

test("preserves the user's region but forces the UTF-8 codeset", () => {
  assert.equal(ensureUtf8Locale({ LANG: "ko_KR" }).LANG, "ko_KR.UTF-8");
  assert.equal(ensureUtf8Locale({ LANG: "fr_FR.ISO8859-1" }).LANG, "fr_FR.UTF-8");
});

test("a non-UTF-8 LC_ALL/LC_CTYPE can't defeat the forced UTF-8 LANG", () => {
  const out = ensureUtf8Locale({ LC_ALL: "C", LANG: "ko_KR" });
  assert.equal("LC_ALL" in out, false, "a C LC_ALL (overrides everything) is dropped");
  assert.equal(out.LANG, "ko_KR.UTF-8");
  const out2 = ensureUtf8Locale({ LC_CTYPE: "C", PATH: "/usr/bin" });
  assert.equal("LC_CTYPE" in out2, false, "a C LC_CTYPE (overrides LANG for ctype) is dropped");
  assert.equal(out2.LANG, "en_US.UTF-8");
});

// Persistent terminals: a pane reopened after a restart must land on the SAME tmux session the previous
// pane 1 left running — that reconnection is the entire feature. Ordinals are therefore reused lowest-first,
// and session names are per-workspace so two repos never share one.
test("reopened panes re-attach to the session the last run left behind", () => {
  const repo = "/Users/x/repos/kakapo";
  const other = "/Users/x/repos/other";
  assert.equal(tmuxSessionName(repo, 1), tmuxSessionName(repo, 1), "the name is stable across runs");
  assert.notEqual(tmuxSessionName(repo, 1), tmuxSessionName(other, 1), "workspaces never collide");
  assert.notEqual(tmuxSessionName(repo, 1), tmuxSessionName(repo, 2), "panes within a workspace differ");
  assert.match(tmuxSessionName(repo, 1), /^kakapo-[0-9a-f]{8}-1$/, "no '.' or ':' — tmux parses those as targets");

  // No live panes (fresh app start) -> ordinal 1 -> the pre-existing session 1.
  assert.equal(nextTerminalOrdinal([]), 1);
  assert.equal(nextTerminalOrdinal([1]), 2, "a second pane opens its own session");
  assert.equal(nextTerminalOrdinal([1, 3]), 2, "a closed middle pane's ordinal is reused, not skipped");
});

test("the tmux session is created in the workspace, with per-session env", () => {
  const args = tmuxSpawnArgs("kakapo-abc12345-1", "/repo", { KAKAPO_ANSWERS_FILE: "/tmp/a.json" });
  const cwd = args.indexOf("-c");
  assert.equal(args[cwd + 1], "/repo", "without -c the session inherits the tmux server's cwd, not ours");
  const env = args.indexOf("-e");
  assert.equal(args[env + 1], "KAKAPO_ANSWERS_FILE=/tmp/a.json", "a session on a pre-existing server would miss it otherwise");
  assert.ok(args.includes("status") && args.includes("off"), "the pane should look like a plain shell");
  const mouse = args.indexOf("mouse");
  assert.equal(args[mouse + 1], "on", "the wheel enters tmux copy mode so fullscreen agent history remains scrollable");
  const wheel = args.indexOf("WheelUpPane");
  assert.ok(wheel > 0 && args.slice(wheel).includes("copy-mode -e"), "a mouse-aware Codex TUI cannot turn wheel scroll into caret movement");
  assert.ok(args.join(" ").includes("Tc"), "truecolor stays on inside tmux (Claude Code's logo)");
});

// Deleting a workspace is the only thing that ends its terminals, and it has to end ALL of them — including
// sessions this app run never attached to (panes are not restored on launch, so the in-memory pty -> session
// map is nearly always incomplete after a restart). Selecting by the workspace's own prefix is what makes the
// cleanup complete without ever touching another workspace's agents.
test("deleting a workspace selects every session of that workspace, and only those", () => {
  const repo = "/Users/x/repos/kakapo";
  const other = "/Users/x/repos/other";
  const listed = [
    tmuxSessionName(repo, 1),
    tmuxSessionName(other, 1),
    tmuxSessionName(repo, 3), // opened in an earlier run: never in this run's session map
    "unrelated-user-session",
    "",
  ].join("\n");

  const doomed = tmuxSessionsForRoot(repo, listed);
  assert.deepEqual(doomed.sort(), [tmuxSessionName(repo, 1), tmuxSessionName(repo, 3)].sort());
  assert.equal(tmuxSessionsForRoot(other, listed).length, 1, "a sibling workspace keeps its own sessions");
  assert.deepEqual(tmuxSessionsForRoot(repo, ""), [], "no tmux server running is not an error");
});

// ⌘W on a pane ends what was running in it. The pane is a tmux session, so "ends it" means the session goes,
// and with it everything inside. Against a real tmux, on a session named so it can never collide with a
// workspace's.
test("closing a pane ends its session, and the process running inside it", async () => {
  const { endTmuxSession } = await import("../dist/util.js");
  const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));
  if (!tmux) return; // no tmux -> plain ptys, nothing to end
  const { execFileSync } = await import("node:child_process");
  const session = `kakapo-selftest-${process.pid}`;
  const live = () => { try { execFileSync(tmux, ["has-session", "-t", session], { stdio: "pipe" }); return true; } catch { return false; } };

  execFileSync(tmux, ["new-session", "-d", "-s", session, "sleep", "60"], { stdio: "pipe" });
  try {
    assert.equal(live(), true, "the session is up");
    endTmuxSession(tmux, session);
    assert.equal(live(), false, "the session \u2014 and the process inside it \u2014 is gone");
  } finally {
    try { execFileSync(tmux, ["kill-session", "-t", session], { stdio: "pipe" }); } catch { /* already gone */ }
  }
});

// The confirmation shown before that has to name what is really in the pane, and only tmux knows: the pty's
// own foreground process is the tmux CLIENT, so node-pty calls an idle pane busy and a working agent "tmux".
test("the close confirmation names the process the pane is actually running", async () => {
  const { tmuxPaneCommand } = await import("../dist/util.js");
  const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));
  if (!tmux) return;
  const { execFileSync } = await import("node:child_process");
  const session = `kakapo-selftest-fg-${process.pid}`;

  execFileSync(tmux, ["new-session", "-d", "-s", session, "sleep", "60"], { stdio: "pipe" });
  try {
    assert.equal(tmuxPaneCommand(tmux, session), "sleep", "the pane's own process, not the tmux client");
  } finally {
    try { execFileSync(tmux, ["kill-session", "-t", session], { stdio: "pipe" }); } catch { /* already gone */ }
  }
  assert.equal(tmuxPaneCommand(tmux, session), "", "a session that is gone reports nothing running");
});

// Sessions outlive the app on purpose — that is what resume is — so nothing ever ended the ones belonging to
// a workspace that has since been closed or moved away. Eleven sessions for four workspaces is a list nobody
// can reason about. An orphan is not "old" and not "idle": it is a session whose name matches no workspace
// this app knows, which means no tile to click and no window to come back to.
test("unreachable sessions are the ones no workspace can name, and nothing else", () => {
  const HOUR = 3600;
  const now = 1_000_000;
  const mine = tmuxSessionPrefix("/repos/acme");
  const gone = tmuxSessionPrefix("/tmp/scratch/probe");
  const old = now - 48 * HOUR;

  const listed = [
    `${mine}1 1 ${now}`,            // attached, reachable
    `${mine}2 0 ${old}`,            // detached and idle, but its workspace is right there
    `${gone}1 0 ${old}`,            // nothing can reach it, quiet for days
    `${gone}2 1 ${old}`,            // unreachable BUT something is attached to it
    `${gone}3 0 ${now - HOUR}`,     // unreachable, but busy an hour ago
    `other-tool-1 0 ${old}`,        // not ours to end
  ].join("\n");

  assert.deepEqual(unreachableSessions(listed, ["/repos/acme"], now), [`${gone}1`],
    "only the detached, quiet, unreachable one");

  // The guards, stated one at a time so a future change cannot quietly drop one.
  assert.equal(unreachableSessions(`${gone}2 1 ${old}`, [], now).length, 0, "attached is never touched");
  assert.equal(unreachableSessions(`${gone}3 0 ${now - HOUR}`, [], now).length, 0, "nor is one that was busy recently");
  assert.equal(unreachableSessions(`other-tool-1 0 ${old}`, [], now).length, 0, "nor another tool's session");
  assert.equal(unreachableSessions(`${mine}2 0 ${old}`, ["/repos/acme"], now).length, 0,
    "and a workspace kakapo knows keeps its sessions however long they idle");
});

test("transcripts of deleted workspaces are swept; every other history is left alone", () => {
  const HOUR = 3600 * 1000;
  const now = 1_700_000_000_000;
  const old = now - 30 * 24 * HOUR;
  const container = "/Users/me/kakapo/workspaces";
  const live = `${container}/acme/quiet-warbler`;

  assert.equal(transcriptSlug(live), "-Users-me-kakapo-workspaces-acme-quiet-warbler");
  // Underscores and dots collapse to dashes exactly like the slashes do, which is why nothing here ever
  // tries to read a name backwards into a path.
  assert.equal(transcriptSlug("/a/b_c.d"), "-a-b-c-d");

  const entries = [
    { name: transcriptSlug(live), mtimeMs: old },                         // its worktree is still on disk
    { name: transcriptSlug(live) + "-src", mtimeMs: old },                // a session started inside it
    { name: transcriptSlug(`${container}/acme/olive-quail`), mtimeMs: old },       // worktree deleted
    { name: transcriptSlug(`${container}/acme/eager-lark`), mtimeMs: now - HOUR }, // deleted, but busy an hour ago
    { name: transcriptSlug("/Users/me/orca/workspaces/acme/feature-s3"), mtimeMs: old }, // another tool's
    { name: transcriptSlug("/Users/me/repos/acme"), mtimeMs: old },       // an ordinary checkout
  ];

  assert.deepEqual(unreachableTranscripts(entries, container, [live], now),
    [transcriptSlug(`${container}/acme/olive-quail`)], "only the deleted, long-quiet, kakapo-made one");

  // The guards, one at a time, so a future change cannot quietly drop one.
  const only = (name, mtimeMs, roots = [live]) => unreachableTranscripts([{ name, mtimeMs }], container, roots, now).length;
  assert.equal(only(transcriptSlug(live), old), 0, "a worktree still on disk keeps its history however long it idles");
  assert.equal(only(transcriptSlug(live) + "-src", old), 0, "and so does a session started in a subdirectory of it");
  assert.equal(only(transcriptSlug("/Users/me/orca/workspaces/acme/x"), old), 0, "another tool's worktree is not ours to clean");
  assert.equal(only(transcriptSlug("/Users/me/repos/acme"), old), 0, "nor is an ordinary checkout");
  assert.equal(only(transcriptSlug(`${container}/acme/fresh`), now - HOUR), 0, "nor one that was written to today");
  // A workspace kakapo forgot the tile for is still a folder you can cd into and `claude --continue` in, so
  // "kakapo has no record of it" must never be what decides this — only the folder being gone.
  assert.equal(only(transcriptSlug(live), old, []), 1, "but an empty live list means the folders really are gone");
});
