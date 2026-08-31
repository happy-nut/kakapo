// Switching workspaces re-renders the rail, and the rail's tiles are git-derived. Computing them the only
// synchronous way — spawnSync git — costs ~5ms per call and ~45ms for `status --porcelain` on a real repo,
// times every open workspace AND every pinned project. On the Electron main process that is frozen UI at the
// exact moment the user is interacting, which is what made switching hitch. gitAsync is the seam that lets a
// tile revalidate without blocking; this pins its contract (same output as git(), same "" on failure) and
// proves it actually yields the thread while a slow command runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitAsync } from "../dist/git.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-gitasync-"));
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "first");
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("gitAsync returns exactly what the blocking git() returns", async () => {
  const repo = makeRepo();
  try {
    for (const args of [["branch", "--show-current"], ["status", "--porcelain"], ["rev-parse", "--show-toplevel"]]) {
      assert.equal(await gitAsync(repo.root, args), git(repo.root, args), args.join(" "));
    }
    // ...including once there is something to report, so the dirty-count path is covered.
    writeFileSync(join(repo.root, "b.txt"), "two\n");
    assert.equal(await gitAsync(repo.root, ["status", "--porcelain"]), git(repo.root, ["status", "--porcelain"]));
    assert.match(await gitAsync(repo.root, ["status", "--porcelain"]), /b\.txt/);
  } finally {
    repo.cleanup();
  }
});

test("a failing command resolves to empty, so callers need no error branch", async () => {
  const repo = makeRepo();
  try {
    assert.equal(await gitAsync(repo.root, ["rev-parse", "--verify", "does-not-exist"]), "");
    assert.equal(await gitAsync(repo.root, ["definitely-not-a-git-command"]), "");
    assert.equal(await gitAsync(join(repo.root, "nope"), ["status"]), "");
  } finally {
    repo.cleanup();
  }
});

test("gitAsync leaves the event loop free while git runs — the whole point of the seam", async () => {
  const repo = makeRepo();
  try {
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 1);
    await gitAsync(repo.root, ["status", "--porcelain"]);
    clearInterval(ticker);
    assert.ok(ticks > 0, `event loop kept running during the git call (ticks=${ticks})`);

    // The contrast: the blocking call cannot be interrupted, so no timer fires while it runs.
    let blockedTicks = 0;
    const blockedTicker = setInterval(() => { blockedTicks++; }, 1);
    git(repo.root, ["status", "--porcelain"]);
    clearInterval(blockedTicker);
    assert.equal(blockedTicks, 0, "spawnSync blocks the thread outright — that is the cost being avoided");
  } finally {
    repo.cleanup();
  }
});

// The rail's working spinner was pty-driven only: an output chunk arriving in an attached pane set the flag.
// On the first launch of the day nothing is attached — panes are restored lazily — so every workspace reported
// "not working" and the rail drew a window full of finished agents while they were all mid-turn. tmux has been
// watching their output the whole time, and it is already scanned once per tick for the green running dot.
test("a workspace with no pty attached still reports a working agent, from tmux", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");

  const scan = main.match(/"list-panes", "-a", "-F", "([^"]*)"/)?.[1];
  assert.ok(scan, "the scan exists");
  assert.match(scan, /#\{session_name\}.#\{pane_current_command\}.#\{window_activity\}/,
    "activity rides along on the existing scan — one answer must not cost two subprocesses");
  assert.match(scan, /#\{pane_title\}/, "Claude's own task title rides on that same scan");

  // tmux replaces CONTROL characters in format output with "_", so a tab separator came back as one
  // unsplittable field and every pane was dropped for having no command — the rail showed a shell for panes
  // with an agent working in them. Only in the packaged app: a tmux talking to a terminal does not sanitise.
  // Measured in the running app: tab and \x1f both yield 1 field, pipe and space both yield 3.
  const separators = [...scan.matchAll(/\}(.)#/g)].map((m) => m[1]);
  assert.equal(separators.length, 3, "three separators, four fields (session, command, activity, pane title)");
  for (const sep of separators) {
    const code = sep.codePointAt(0);
    assert.ok(code > 31 && code !== 127, `separator U+${code.toString(16)} must be printable — tmux turns control characters into "_"`);
  }
  assert.match(main, /line\.split\("\|"\)/, "and the parse splits on the same character");

  const busy = main.match(/function tmuxSessionBusy\(session: string\): boolean \{[\s\S]*?\n\}/)?.[0];
  assert.ok(busy, "one place decides whether a tmux session is mid-turn");
  assert.match(busy, /Date\.now\(\) - at \* 1000 < TMUX_BUSY_WINDOW_MS/, "seconds from tmux, milliseconds here");

  // tmux stamps in whole seconds and the scan is cached, so the window must clear both or a working agent
  // blinks off between ticks.
  const win = Number(main.match(/const TMUX_BUSY_WINDOW_MS = (\d+);/)?.[1]);
  const ttl = Number(main.match(/const TMUX_SCAN_TTL_MS = (\d+);/)?.[1]);
  assert.ok(win > ttl + 1000, `busy window ${win}ms must outlast the ${ttl}ms scan cache plus tmux's 1s resolution`);

  assert.match(main, /running: true, busy: tmuxSessionBusy\(session\)/,
    "the detached-session row asks tmux instead of hardcoding idle");

  // Both pushes have to agree: the full render is the FIRST paint after launch, the activity tick every one
  // after it. Fixing only the tick would leave the launch itself still lying.
  const pushes = main.match(/busy: state\.busy(?![A-Za-z])[^,\n]*/g) ?? [];
  assert.equal(pushes.length, 2, "exactly two places report workspace busy to the rail");
  for (const p of pushes) {
    assert.match(p, /paneRows\.some\(\(pane\) => pane\.busy\)|rows\.some\(\(pane\) => pane\.busy\)/,
      `both fold in the pane rows, got: ${p}`);
  }
});

test("pane rows let the icon identify the agent without repeating its name", () => {
  const shell = readFileSync(new URL("../src/shell-pages.ts", import.meta.url), "utf8");
  assert.match(shell, /const title=p\.task\|\|\(!p\.agent\?paneWhat\(p\):''\)/);
  assert.doesNotMatch(shell, /AGENT_NAME\[p\.agent\]\+' · '\+p\.task/);
  assert.match(shell, /\.wt-pane>\.usage-ico\{width:11px;height:11px;margin-top:2px\}/);
});

test("an empty startup capture does not permanently discard the pane task", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const task = main.match(/function paneTask\([\s\S]*?\n\}/)?.[0];
  assert.ok(task);
  assert.match(task, /if \(screen\.trim\(\)\) scannedSessionTasks\.add\(session\)/);
  assert.doesNotMatch(task, /if \(!scannedSessionTasks\.has\(session\)\) \{\s*scannedSessionTasks\.add/);
});
