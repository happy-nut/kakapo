---
name: verify-kakapo
description: Launch kakapo — the Electron desktop review app in this repository — against a throwaway git repository, drive it over the Chrome DevTools Protocol as a reviewer would, and leave screenshots and a transcript as evidence. Use when asked to run the app, show a change working, take a screenshot of it, or confirm behaviour in the real app rather than in the test suite.
---

# Verifying kakapo

kakapo is an Electron desktop app that opens a diff reader for the git repository you run it in. The
surface a user touches is that window: a file tree, a diff, review comments beside the code, and keyboard
navigation measured against IntelliJ. There is no server, no web UI and no login. The CLI (`kakapo
[path]`, plus `--base`, `--staged`, `--context`, `--whitespace`) chooses which folder the window opens on
and how the first diff is framed; `install-app` / `uninstall-app` are the only commands.

This skill is how you make it prove something. `npm test` is a jsdom suite against a stubbed main
process; it cannot answer "does ⌥N reach the renderer on macOS", "is the stripe actually painted", or
"what does this look like in Korean". The app answers those, driven over CDP.

**Read `AGENTS.md` first — it outranks this file.** The rules that bite here: generated artifacts belong
under the app's user-data workspace mirror, never inside a reviewed project; a keyboard shortcut is a row
in `src/shortcuts.ts` and nothing else; and navigation changes are measured with `npm run nav:matrix`,
not against themselves.

## Launch

The app needs a build and a repository to review. `dist/` is gitignored, so there may not be one:

```bash
npm run build
```

Then launch from a script, never by hand — the lifecycle is four things that all have to happen
(see **Drive** below for the body):

```js
// a script beside this skill; from anywhere else, import drive.mjs by its absolute path
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("compare");          // mkdtemp + git init + user config
repo.put("src/a.ts", "export const a = 1;\n");
repo.commit("initial");
repo.put("src/a.ts", "export const a = 2;\n");   // an uncommitted change to read

await drive("compare", repo, async (page, h) => {
  // … press keys, ask the page questions, h.check(...) each answer
});
```

[`example.mjs`](example.mjs) is that shape filled in and runnable — a review opening on the right work,
each compare mode answering differently, a comment written on a line and handed over, `⌥N` showing what
arrived since. Copy it and change the fixture and the checks:

```bash
node .claude/skills/verify-kakapo/example.mjs
KAKAPO_VERIFY_LOCALE=ko node .claude/skills/verify-kakapo/example.mjs   # the same run, in Korean
node .claude/skills/verify-kakapo/ledger.mjs                            # the patch-set ledger (CMP-8)
node .claude/skills/verify-kakapo/caret-chords.mjs                      # what each caret chord selects (READ-8)
node .claude/skills/verify-kakapo/compare-tip.mjs                       # the compare menu tells the truth (CMP-3/7)
node .claude/skills/verify-kakapo/worktree-cache.mjs                    # a sibling worktree reuses the index
node .claude/skills/verify-kakapo/clangd-index-hidden.mjs               # a server's own index stays out of the review
node .claude/skills/verify-kakapo/dock-paste.mjs                        # an open dock still lets ⌘V reach a field
node .claude/skills/verify-kakapo/statement-keywords.mjs                # synchronized/lock/foreach are not declarations
```

The renderer's own scan (`findSymbolDefinition`) reads only the files it has materialised, so a script
that asks it about a file nobody opened gets `null` for every name, including ones that plainly exist.
Open the file first (`openSourceFile`, then wait on `sourceOpenPath()`), and open the file you want
scanned, because the index answers before the renderer ever gets a turn.

`drive()` takes an options object as its fourth argument, and `args` reaches the CLI — the only way to set
something the window has no control for. `--include-untracked` is not one of those: the CLI forwards it on
every launch, so passing it changes nothing and untracked files always count as additions.

`drive()` does, in order:

1. **Refuses if a Kakapo from this checkout is already up.** `app.requestSingleInstanceLock`
   (`src/app-main.ts:187`) hands a second launch to the first instance, so a run that did not refuse would
   silently drive someone else's window. It names the pids.
2. **Refuses if port 9333 is taken**, naming the holder. It is a popular debugger port; a Chrome started
   with `--remote-debugging-port` holds it, and the symptom without this check is "the review page never
   became ready" with the real reason buried in Electron's stderr. Override with `KAKAPO_SMOKE_PORT`.
3. **Launches with `KAKAPO_DEV=1` and `KAKAPO_REMOTE_DEBUG=9333`.** `KAKAPO_DEV=1` moves the user-data
   directory to `<userData>/dev` (`src/app-main.ts:155`). This is the isolation, and it matters: the
   repository's own `launchApp()` does not set it, so a bare `npm run nav:smoke` writes into the
   operator's **real** Kakapo state — read marks, renderer settings, restored tabs, the per-workspace
   review and symbol mirrors. Prefix those scripts with `KAKAPO_DEV=1` too. It does **not** cover review
   comments: those live in the reviewed repository's own git directory
   (`<root>/.git/kakapo/comments.jsonl`), on purpose, so they go wherever the fixture goes.
4. **Waits until the app is usable, not merely responding.** `readyPage()` from the shared harness answers
   "the viewer's functions are defined", which is true well before the first diff has been built and
   painted. `drive()` then waits for the boot overlay to go and for a file to appear. Driving at the
   earlier moment reads an empty tree and reports a regression that is not there.

Taking it down is not `child.kill()`: the launcher is a node process and the app is its Electron
children, which outlive it. `drive()` always runs the harness's `stopApp()` in a `finally`, and removes
the fixture repository with it. Leftovers make the **next** run refuse at step 1.

Two instances cannot run side by side: one debugger port, one single-instance lock. Run verification
scripts one at a time.

## Doctor

```bash
node .claude/skills/verify-kakapo/doctor.mjs
```

Read-only. Starts nothing, kills nothing, writes nothing. It answers:

- is `dist/` built, and not older than `src/` (a stale build is the failure that looks most like a
  product regression);
- which version this checkout is;
- is port 9333 free, or who holds it;
- is a Kakapo from this checkout running — and if so, does its page answer, is the viewer loaded, which
  repository is it on, and was **every** process of ours started with `KAKAPO_DEV=1`. That last one is
  read off the process environment (`ps eww`), not guessed from a path: nothing the renderer can see
  says whether main redirected userData, and a stale process from an earlier run sits in the pid list
  beside the live one.

Exit 0 means the environment is in one of the two states a run can start from (nothing of ours up, or one
reachable ready window of ours). Exit 1 names what it is instead.

Run it before the first drive of a session and after any drive that failed strangely. A screenshot of a
wedged window and a screenshot of a working one look identical until something asks the page a question.
If the page is wedged, relaunch — do not wait for it.

## Drive

Keys and clicks go in below the page over CDP, at the browser's input layer. That is why this works where
`osascript` does not: synthetic AppleScript input never reaches Electron (and the suite's own
`KeyboardEvent`s are fields this repository chose, which cannot answer whether macOS delivers the chord).

Inside the body, `page` is the harness `Page` and `h` carries the run:

| | |
| --- | --- |
| `page.evaluate(js)` | run JS in the viewer, get the value back |
| `page.key(key, code, vk, mods)` | a real chord. **mods: Alt=1 Ctrl=2 Meta=4 Shift=8** |
| `page.char(ch, code, vk)` | a printable keystroke that carries text — a field that drops focus mid-query is invisible to `key` and to `type` |
| `page.type(text)` | bulk text into Quick Open's input |
| `page.drag(x1, y1, x2, y2)` | a real drag, several moves, not one jump |
| `h.click(selector, nth)` | a real mouse click at an element's centre — the only way to put the diff caret on a chosen line |
| `h.until(js, ms)` | poll until truthy. **Prefer this to `h.sleep`** — a sleep is a bet on the clock, and that bet is what made `comment-nav` flake |
| `h.check(ok, what, detail)` | one transcript line; a false one sets the exit code |
| `h.shot(label)` | a PNG in the evidence directory |

The viewer is one concatenated script with no modules, so its top-level `function`s and `var`s are on
`window` and `page.evaluate` can call them directly. **`let`/`const` top-levels are not** — `viewerCursor`
and `navList` are invisible to CDP for that reason. A handful of surfaces also expose a deliberate test
handle: `window.__kakapoCompareMenu`, `__kakapoPatchSet`, `__kakapoFileFind`, `__kakapoHistory`,
`__kakapoAnalysisStatus`, `__kakapoCoach`, `__kakapoCloseDocks`.

Prefer stable handles to coordinates. The ones every feature file builds on:

| Selector | What it is |
| --- | --- |
| `.d2h-file-wrapper` (`data-path`) | one file in the diff — the list of these IS "what the review is showing" |
| `#files-panel` / `#changes-panel` | the sidebar's two tabs (`⌘1` / `⌘2`) |
| `#changes-panel .file-link`, `.change-row` | one changed file in the Changes list |
| `#files-tree-html` | **not a tree** — a `<script type="text/html">` island the Files tab hydrates from |
| `#compare-pill` / `.compare-refs` | the compare control and the text of what it measures |
| `#compare-menu .compare-menu-row[data-mode=…]` | its four rows: `since`, `all`, `uncommitted`, `tip`. (`other` is a mode the IPC can report — a ⌘9 scope, an A→B target, a patch-set pick — but it has no row, so no row is ticked.) |
| `#patchset-bar` | the patch-set bar |
| `#patchset-ledger-btn`, `#patchset-ledger`, `.patchset-ledger-row` | the ledger the bar's numbers summarise; a row carries `is-read` / `is-unread` only where there is a read mark to go by |
| `#mc-merged-panel`, `.mc-merged-card` | the hand-off dock and its cards |
| `.mc-comment-row`, `.mc-composer .mc-input` | a comment in the diff, and the composer's textarea |
| `#source-viewer`, `#source-body`, `#source-tabs` | the source view |
| `#quick-open`, `#quick-open-input`, `#quick-open-results` | Quick Open / Search Everywhere |
| `#usages`, `#usages-results` | the usages panel |
| `#history-view`, `#history-list` | `⌘9` git history |

Three more things it costs a run to learn:

- **`.mc-composer .mc-input` matches twice.** The diff view and the source view each have one, and the
  hidden one comes first in document order. Pick the one in the visible view (`07-comments.js:1343`).
- **The physical `code` is what matches, not the character.** `shortcutChords()`
  (`src/viewer/00-shortcuts.js`) reads `event.code` first, so a letter chord is driven by its code and a
  `key` that spells nothing: `⌥N` is `page.key("Dead", "KeyN", 78, 1)`, never `key: "n"` (on macOS ⌥N is
  a dead key anyway). The exception is a chord written as a shifted character — the table says `?`, not
  `⇧/` — where the matcher folds the Shift into the key and you must pass it: `page.key("?", "Slash",
  191, 8)`.
- **A chord the application menu holds never reaches the page.** Electron consumes a menu accelerator
  before any renderer keydown. `test/menu-accelerators.test.mjs` guards the table against the real menu;
  if a key does nothing here and everything in jsdom, that is the first thing to check.

Four scripted paths already exist and should be driven rather than re-written. All of them want
`KAKAPO_DEV=1`:

```bash
KAKAPO_DEV=1 npm run nav:smoke     # does each navigation key still work
KAKAPO_DEV=1 npm run nav:matrix    # does it still do what IntelliJ does — 18 rows, side by side
KAKAPO_DEV=1 npm run review:smoke  # .http requests, git history filters, the diff's overview stripe
KAKAPO_DEV=1 npm run mermaid:smoke # Mermaid rendering
```

## Evidence

`drive()` writes to `.kakapo-verify/<timestamp>-<name>/` at the repository root — gitignored, outside the
build, and **not removed by cleanup**. It holds `run.log` (every `h.check` line in order) and the
screenshots, numbered in the order they were taken.

What counts as proof here:

- **Go through the user's path.** Press the key; do not call the function the key dispatches to, and do
  not call a bridge method that the UI would have called. `window.kakapoGit.markRead()` is the hand-off's
  own IPC, so calling it proves the IPC and *not* that the hand-off calls it.
- **Photograph the feature, one shot each.** A DOM assertion passes for a mark that draws nothing — that
  is literally how an invisible bookmark gutter shipped. One screenshot per feature, not one per run.
- **Check the side effect too, not just the screen.** A comment that renders is not a comment that was
  written: ask `window.kakapoComments.read()` as well. A compare mode that highlights a row is not a
  compare that ran: read the `.d2h-file-wrapper` list.
- **Shoot Korean when the change touches text.** `KAKAPO_VERIFY_LOCALE=ko` re-renders the window in
  place before the body runs, so one script photographs both catalogues. A label that overflows its row
  is visible in no assertion.

## Cleanup

`drive()` already does it, in a `finally` so a thrown check still cleans up: `stopApp()` (SIGTERM, then
SIGKILL, then every Electron pid from this checkout), `rmSync` of the fixture repository, and `rmSync` of
that fixture's user-data mirror — the review build, symbol index, perf trace and `state.json` the run
left under `<userData>/dev/workspaces/…`, which the fixture's removal otherwise orphans. The evidence
directory survives on purpose.

When a run crashed hard enough to skip the `finally`, do both by hand:

```bash
pgrep -fl "$PWD/node_modules/electron" || echo "nothing of ours is running"
```

and the isolated workspace mirrors the run left behind — note the depth, a shallow `find` silently
matches nothing and looks exactly like having nothing to clean:

```bash
find ~/Library/Application\ Support/Kakapo/dev/workspaces -maxdepth 12 -name 'kakapo-verify-*' -print0 | xargs -0 rm -rf
```

Never `killall Electron`: that takes the operator's other work with it.

**Never drive the app, and never run that `pgrep`/`pkill` pair, while `npm test` is running.**
`test/menu-accelerators.test.mjs` spawns the real Electron binary out of this same `node_modules` to
build the application menu and check it against `src/shortcuts.ts`. `stopApp()` kills every Electron pid
from this checkout and cannot tell that one apart, so a drive — or a hand-rolled cleanup — overlapping
the suite kills that test's app and invalidates the run without either side saying so. Suite first, then
drive, or the other way round; never at once.

## Feature map

[`features/`](features/) is the catalogue of what a user can do and how to drive each one. It is the
repository's record of what verification means, so when behaviour changes, change it there. Re-run
`/devkit:verify-setup` after a change to the app and it will re-align the map.

## Going deeper than driving

Driving cannot see every class of defect. These are worth proposing, once each, when the symptom fits:

- **Property-based sweeps of the viewer.** The viewer is one concatenated script whose surfaces keep
  growing second readers of the same fact; `test/viewer-slices.test.mjs` enforces one-fact-one-reader by
  grep. A property run ("the compare pill always names the base the diff was built from") would catch the
  drift that grep cannot see.
- **A model checker for the compare/patch-set state machine.** Base, target, scope, label, staged and the
  read mark interact, and the bug they have produced twice is a refusal that leaves the window describing
  a diff it is not showing. TLA+ over that state is a better fit than more fixtures.

`/devkit:formal-setup` builds the skill for either, once the need is confirmed.
