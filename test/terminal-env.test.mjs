// CORE USER FLOW: the integrated terminal opens a clean login shell.
//
// Launching kakapo through npm (`npm run dev`, or a global install behind an npm shim) injects
// npm_config_* vars into the process. Inheriting them into the pty makes nvm warn on every new shell
// ("nvm is not compatible with the npm_config_prefix environment variable") — which doesn't happen in
// iTerm. sanitizeTerminalEnv keeps the integrated terminal indistinguishable from the user's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminalEnv, ensureUtf8Locale, tmuxSessionName, nextTerminalOrdinal, tmuxSpawnArgs } from "../dist/util.js";

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
  assert.ok(args.join(" ").includes("Tc"), "truecolor stays on inside tmux (Claude Code's logo)");
});
