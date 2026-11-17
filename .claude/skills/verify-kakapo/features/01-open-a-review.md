# OPEN — opening a review

You run `kakapo` in the terminal of the worktree you are working in, and a window opens showing that
repository's current change: a sidebar listing the changed files, the diff beside it, and a compare
control naming what the change is measured against. Git is optional — a folder without a repository opens
as its source tree instead. This is the entry to everything else; if it is wrong, nothing below it is
being tested.

## Sub-features

- `OPEN-1` **bare `kakapo`** — the current working directory becomes the review, against the base it
  works out for itself: the upstream merge-base when the branch has unpushed commits **and the worktree
  is clean**, otherwise `HEAD`.
- `OPEN-2` **`kakapo <folder>`** — a named folder, same as `--cwd <path>`.
- `OPEN-3` **`kakapo <file>`** — opens the file's repository and lands on that file.
- `OPEN-4` **`--base <rev>`** — compare the working tree against a branch, tag or commit.
- `OPEN-5` **`--staged`** — compare the index against HEAD instead.
- `OPEN-6` **a folder with no git** — opens as a source tree, no diff.
- `OPEN-7` **a second `kakapo`** — handed to the window already open, not a second app.
- `OPEN-8` **`--help` / `--version`** — the CLI answers without launching anything.

## How to get to it (user POV)

- A terminal in the repository: `kakapo`, `kakapo .`, `kakapo src/parser.ts`, `kakapo --base main`,
  `kakapo --staged`, `kakapo ~/some/folder`.
- The Applications icon added by `kakapo install-app` (Spotlight, Launchpad, Dock) — opens the welcome
  screen rather than a repository.
- Inside an open window: `⌘O` opens another folder, `⌘⇧O` opens it in a new window.

## Driving it with the CDP harness

**Preconditions:** `npm run build`; `doctor.mjs` exit 0; nothing of ours running.

- `OPEN-8` — costs no app at all, so do it first and separately:
  ```bash
  node dist/cli.js --help     # prints usage; exit 0
  node dist/cli.js --version  # prints the version in package.json; exit 0
  ```
  Observe: the help text lists `install-app`, `--base`, `--staged`, `--whitespace`, `--context`.

- `OPEN-1` / `OPEN-2` — the default drive, and the base it picks is half of what is being tested, so
  drive **both** worktree states:
  ```js
  const files = await page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).filter(Boolean).sort()`);
  ```
  - *dirty tree* (a branch commit plus an uncommitted edit): `files` is the uncommitted edit alone.
    `resolveAutomaticReviewBase` returns `undefined` the moment `git status` says anything, so the base
    is `HEAD`. `⌥A` is what widens it to the branch.
  - *clean tree* (the agent committed and stopped — the workflow's own case): `files` is everything the
    branch has ahead of its upstream or default branch.

  Observe either way: the Changes list agrees —
  `document.querySelectorAll('#changes-panel .file-link').length` is the same count.

- `OPEN-4` — `drive()` always launches bare, so a base is driven through the app instead, which is the
  same code path the CLI flag lands in (`kakapo:set-compare-mode`). See `CMP-5`. To verify the **flag**
  itself, spawn `bin/kakapo.js <repo> --base <sha> --foreground` directly with `KAKAPO_DEV=1` and
  `KAKAPO_REMOTE_DEBUG`, then read the same file list.

- `OPEN-6` — `makeRepo` then `rm -rf <dir>/.git` before launching:
  ```js
  h.check(await page.evaluate(`(document.getElementById('files-panel')||{}).childElementCount > 0`),
    "a folder with no git opens as its source tree");
  h.check(await page.evaluate(`document.querySelectorAll('.d2h-file-wrapper').length === 0`),
    "and shows no diff");
  ```

- `OPEN-7` — while the first is up, run `node bin/kakapo.js <same repo>` and let it exit. Observe:
  `checkoutElectronPids()` has not grown, and the first window is still the one on the debugger port.

- Screenshot: `h.shot("open-review")` with the diff on screen.

## Gotchas

- **The window answers before it is usable.** `readyPage()` is satisfied by the viewer's functions being
  defined, which happens before the first diff is built. `drive()` waits further; a hand-rolled launch
  must too, or it reads an empty tree and reports a regression that is not there.
- **A second launch is silent.** It is handed to the first instance by design, so a verification run that
  did not refuse at startup drives the operator's window and reports about the wrong repository.
- **`#files-tree-html` is a `<script>` island, not a tree.** Counting rows inside it finds nothing. The
  live project tree is `#files-panel`, hydrated from that island on first use.
- **A dirty worktree changes which base the app picks.** `resolveAutomaticReviewBase` bails on any
  `git status` output at all, so "the review opens on the whole branch" is only true of a clean tree. A
  fixture built with an uncommitted edit opens on that edit alone — correct, and the most common way to
  write a wrong expectation here. It cost this map one failed check to learn.
- **An empty review is a legitimate state.** A repository whose working tree is clean and whose branch
  has no commits ahead *and nothing behind* shows no files. (Clean, nothing ahead, something behind is
  not empty: the review flips to the incoming changes, right side pinned to the tracking branch.)
- **The fixture needs `user.email`/`user.name`.** `makeRepo` sets them; a commit in a repository without
  them fails, and the failure surfaces much later as "the review is empty".
