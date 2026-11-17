# CMP — choosing what to compare

The review always measures a change between two points, and this is where you choose them. The compare
pill in the toolbar names what is in force; its menu offers the handful of answers that matter in this
workflow, and each has a key. The patch-set bar underneath narrows further, to one commit at a time. This
is the feature the app exists for — an agent worked in a worktree, and you need to see the right slice of
what it did.

## Sub-features

- `CMP-1` **`⌥A` all changes** — everything on the branch, measured from the merge-base with the chosen
  branch.
- `CMP-2` **`⌥U` uncommitted only** — base is the literal `HEAD`.
- `CMP-3` **`⌥T` branch tip** — the ref's own tip, with no merge-base reduction. For "local vs remote".
- `CMP-4` **`⌥N` since you last read** — base is the commit the last hand-off recorded. The row hides
  itself until a hand-off has left a mark and the branch has moved past it.
- `CMP-5` **patch sets** — `#patchset-bar`, and `⌥]` / `⌥[` to step. Picking one sets the base to a
  commit, which clears the branch label.
- `CMP-8` **the ledger** — `#patchset-ledger-btn` (the bar's own name) opens `#patchset-ledger`: one row
  per patch set with its subject, file count, `+`/`−` and date, the read ones dotted and anything that
  arrived since the last hand-off marked unread. A row picks the base, like its number does. Arrows walk
  it, Esc closes it and returns focus to the button.
- `CMP-6` **`⌥C` choose the branch** — the picker that names what `⌥A` measures against; persisted per
  repository and restored on reopen.
- `CMP-7` **the pill itself** — `#compare-pill` opens the same menu with the mouse, and `.compare-refs`
  prints the two ends the diff was actually built from.

## How to get to it (user POV)

- The pill in the toolbar (click), or its keys `⌥A` `⌥U` `⌥T` `⌥N` `⌥C` from anywhere in the window.
- `⌥]` / `⌥[` to step patch sets; the bar's own buttons for the same.
- From the terminal, before the window exists: `--base <rev>`, `--staged`.
- The choice is remembered per repository (`kakapo-compare-ref`, `kakapo-compare-tip`), so reopening the
  same worktree comes back to it.

## Driving it with the CDP harness

**Preconditions:** a fixture with a branch that has commits ahead of `main` *and* an uncommitted edit, so
the modes give different answers. `doctor.mjs` exit 0. Note that the uncommitted edit also decides where
the review *starts*: a dirty worktree makes the automatic base `HEAD`, so the window opens in something
very close to `⌥U` and `⌥A` is what widens it (see `OPEN-1`).

- The one question every mode answers, asked the same way each time:
  ```js
  const shown = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).filter(Boolean).sort()`);
  const pill = () => page.evaluate(
    `document.querySelector('.compare-refs').textContent.replace(/\\s+/g,' ').trim()`);
  ```

- `CMP-1` `⌥A` — `await page.key("Dead", "KeyA", 65, 1)`.
  Observe: `shown()` lists every file the branch touches, committed and not.
- `CMP-2` `⌥U` — `await page.key("Dead", "KeyU", 85, 1)`.
  Observe: `shown()` lists only the uncommitted edit. `pill()` stops naming a branch, because this mode's
  base is the literal string `HEAD` and not a ref the menu resolved — read the exact text off your first
  run rather than asserting a string this file guessed.
- `CMP-3` `⌥T` — `await page.key("Dead", "KeyT", 84, 1)`.
- `CMP-4` `⌥N` — `await page.key("Dead", "KeyN", 78, 1)`.
  Precondition: a hand-off has happened (`CMT-5`) and commits have landed since. Observe: `shown()` is
  exactly the files of the commits after the mark, and `pill()` contains the mark's short sha.
  With no mark, the key must toast and change nothing — drive that case too.
- `CMP-7` the menu — it has a deliberate test handle, so the rows can be read without chasing the pill's
  geometry:
  ```js
  await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
  await page.evaluate(`window.__kakapoCompareMenu.open()`);
  await h.until(`!document.getElementById('compare-menu').classList.contains('hidden')`);
  const rows = await page.evaluate(`Array.from(
    document.querySelectorAll('#compare-menu .compare-menu-main .compare-menu-row')
  ).map(r => ({ mode: r.dataset.mode, hidden: r.classList.contains('hidden'),
                checked: r.getAttribute('aria-checked'), label: r.textContent.trim() }))`);
  ```
  Observe: the mode in force is the one with `aria-checked="true"`, and it is the mode you just pressed.
- `CMP-5` patch sets — `window.__kakapoPatchSet` is the handle; `⌥]` is
  `page.key("Dead", "BracketRight", 221, 1)`. Observe: `pill()` turns into a sha with no branch name.
- `CMP-3`/`CMP-7` the tip flag — driven by [`../compare-tip.mjs`](../compare-tip.mjs), which walks the
  counterexample `formal-compare-mode` found (⌥A, ⌥T, then the bar's "All") and asks the menu what it
  thinks after each step. It also drives the half the model refuted: a target change does not move the
  base, so tip mode survives it.
- `CMP-8` the ledger — driven end to end by [`../ledger.mjs`](../ledger.mjs); run that rather than
  re-writing it. `node .claude/skills/verify-kakapo/ledger.mjs`, and with `KAKAPO_VERIFY_LOCALE=ko` for
  the Korean pass. It builds three patch sets that each did a visibly different amount — so the figures
  cannot all be right by accident — hands the review over, lets one more commit land, and checks the
  read/unread split.
- Screenshot: `h.shot("compare-menu")` with the menu open, and `h.shot("compare-since")` on the `⌥N`
  diff.

## Gotchas

- **Press the key; do not call `kakapoGit.setCompareMode`.** That bridge is what the key dispatches to,
  so calling it proves the IPC and leaves the keymap, the menu and the pill untested — which is exactly
  the layer where a chord the application menu swallows would show up.
- **The mode is derived, not stored.** `since` is "the base is the read-mark commit and there is no
  branch label, no target and no scope" (`src/app-review-ipc.ts`). So a patch-set pick that happens to
  land on the same commit ticks the `since` row. That is not a bug — both rows describe the same diff —
  and a check that asserts "only ⌥N ever ticks it" will fail honestly.
- **`baseLabel` is the discriminator between `all` and a patch set.** A base with a label came from a
  branch; a base without one names a commit. Reading only `options.base` cannot tell them apart.
- **The menu's data is a snapshot.** It is read when the menu opens. If the fixture commits while the
  menu is up, call `__kakapoCompareMenu.refresh()` before asserting on the rows.
- **A refusal must leave everything alone.** `⌥N` with no mark returns `{error: "no-read-mark"}` *before*
  any option is touched. If a future change moves that refusal down into the mode chain, the scope,
  target and staged flag are already cleared when it fires and the window shows a diff its own options no
  longer describe. Assert the pill is unchanged after a refusal, not just that a toast appeared.
- **`⌥T` is remembered with a flag** (`kakapo-compare-tip`), unlike `since` — but a window does NOT open
  in tip mode: `restoreCompareRef` brings the ref back and deliberately leaves the mode alone, because it
  runs after the first build. A fixture that reopens the same workspace comes back saying "all changes".
- **The flag is a claim about `options.base`.** Every handler that rewrites the base clears it
  (`setCompareTip`); `set-review-target`, which does not, must not — clearing it there makes the menu
  claim "all" for a diff that is still a tip diff. The model in `.claude/skills/formal-compare-mode`
  proves both halves; `compare-tip.mjs` shows this app doing them.
- **The ledger re-opens itself on a diff update**, so that a commit landing while it is up does not leave
  a list that no longer describes the branch. That re-render re-focuses a row *asynchronously* — so a key
  sent right after a commit lands on whatever had focus a moment ago, and `Esc` looks broken. Wait for
  `document.activeElement` to be a `.patchset-ledger-row`; do not sample it and hope.
- **Waiting for a non-empty file list proves nothing after a pick.** The previous mode's list is already
  there and satisfies it instantly. Capture the list first and wait for it to *differ*.
- **Right after a hand-off there is no read mark to find.** The mark is HEAD, so HEAD has not moved past
  it and `compareMenu().readMark` is correctly empty. It becomes visible one commit later. A check that
  looks for it immediately is asserting the opposite of the design.
