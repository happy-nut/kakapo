# CMT — review comments and the hand-off

Comments are why kakapo is a reader rather than a diff viewer. You write one on a line, it sits beside
the code, and when you are done you hand the whole set to the agent that wrote the change: copying the
review out **is** the hand-off, so what you copy is archived out of the review and the commit you were
reading is recorded as where you stopped. Comments never leave the machine — no `gh`, no API.

## Sub-features

- `CMT-1` **`?` on a line** — open the composer, prefilled with the file:line label; `⌘Enter` saves.
  A second `?` on a line that already has one opens that comment for editing instead of stacking a new
  one.
- `CMT-2` **`F8` / `⇧F8`** — step to the next / previous comment.
- `CMT-3` **`e` / `Backspace` on a selected comment** — edit / delete it; `⌘Z` undoes a removal.
- `CMT-4` **`⌘⇧/`** — the hand-off document (`#mc-merged-panel`): every comment as one text. Again to
  close it.
- `CMT-5` **`⌘C` / `⌥Enter` in that panel** — hand over. Copies to the clipboard, archives what it
  copied, records the read mark, and toasts the count with the undo key. `⌘A` first selects all of it.
- `CMT-6` **the archive** — `#archive-panel` in the sidebar puts a handed-over review back; `⌘Z` undoes
  the hand-off, taking the comment out of the archive as well as back into the review.
- `CMT-7` **persistence** — comments are JSONL records in the reviewed repository's **git directory**:
  `<root>/.git/kakapo/comments.jsonl`, or `.git/worktrees/<name>/kakapo/comments.jsonl` in a worktree.
  Deliberately there and not under Electron's userData (`src/comments-file.ts`): git never tracks its own
  directory, so nothing appears in `git status`, but a cwd-sandboxed coding agent can still reach it —
  which is the whole point, since the agent is who the comments are written for. They survive a relaunch.

## How to get to it (user POV)

- Caret on a line in the diff or the source view, then `?`. Or drag a selection first, and the comment
  anchors to the dragged span.
- `⌘⇧/` for the whole-review document; the hand-off button in that panel; `⌥Enter` for the same.
- The sidebar's archive drawer, once something has been handed over.

## Driving it with the CDP harness

**Preconditions:** a fixture with at least one changed file and one deleted line. `doctor.mjs` exit 0.
Comments are written into the **fixture's own** `.git/kakapo/`, so they go with it when `drive()` removes
it — but the read mark and the renderer settings the hand-off also touches live under userData, which is
why the run still needs `KAKAPO_DEV=1`. Never write a comment into a repository you did not create.

- `CMT-1` — the caret has to be somewhere first, and there is no keyboard route to a *chosen* line:
  ```js
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  await h.click('.d2h-code-line-ctn', 0);
  await page.key("?", "Slash", 191, 8);                       // Shift is folded into the key here
  // Wait for the textarea to HOLD the keyboard, not merely to exist (see Gotchas).
  const prefill = await h.until(`(() => {
    const el = document.activeElement;
    return (el && el.classList && el.classList.contains('mc-input')) ? (el.value || '(empty)') : false;
  })()`);
  h.check(/^@\S+#L\d+/.test(prefill), "the composer opens focused and prefilled", prefill);
  for (const ch of "why") await page.char(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0));
  await page.key("Enter", "Enter", 13, 4);                    // ⌘Enter saves
  ```
  Observe, on screen **and** on disk:
  ```js
  await h.until(`document.querySelectorAll('.mc-comment-row').length === 1`);
  const stored = await h.until(`window.kakapoComments.read().then(r => r.records.length || false)`);
  h.check(stored === 1, "and it was written to the workspace record", stored);
  ```

- `CMT-4` — `⌘⇧/` is `page.key("/", "Slash", 191, 12)`.
  Observe: `#mc-merged-panel` exists and holds one `.mc-merged-card` per comment.

- `CMT-5` — with the panel up, `⌘A` then `⌘C`
  (`page.key("a", "KeyA", 65, 4)`, `page.key("c", "KeyC", 67, 4)`).
  Observe **all four** effects, because each has been broken on its own:
  ```js
  h.check(await page.evaluate(`window.kakapoComments.read().then(r => r.records.filter(c => !c.archivedAt).length)`) === 0,
    "the review is empty after the hand-off");
  h.check(!(await page.evaluate(`document.getElementById('archive-panel').classList.contains('hidden')`)),
    "the archive drawer has appeared");
  h.check(/archived|보관/i.test(await page.evaluate(`(document.querySelector('.mc-toast')||{}).textContent || ''`)),
    "and it said so");
  // the read mark: ⌥N must now be offered (CMP-4)
  ```

- `CMT-6` — `⌘Z` is `page.key("z", "KeyZ", 90, 4)`.
  Observe: the comment is back in the review **and gone from the archive**. Checking only the first half
  passes for the bug where undo left a duplicate card behind that survived a restart.

- `CMT-7` — relaunch on the same fixture (a second `drive()` with the same repo path, after the first
  returns) and read `kakapoComments.read()`.

- Screenshot: `h.shot("comment-on-a-line")` and `h.shot("hand-off-panel")`.

## Gotchas

- **`.mc-composer .mc-input` matches twice.** The diff view and the source view each own one, and the
  hidden one comes first in document order (`07-comments.js:1343`). `document.querySelector` returns the
  wrong textarea. Waiting for `document.activeElement` to be an `.mc-input` picks the right one *and*
  solves the focus race below in the same step.
- **The composer does not have the keyboard when it appears.** Electron restores focus to `<body>` after
  the keydown, so `07-comments.js` retries focus on a 25ms interval for ~300ms. Typing as soon as the
  textarea exists sends the characters nowhere — and then `⌘Enter` **refuses**, because a box still
  holding exactly its prefill is "untouched" and `saveComposer` says what is missing instead of saving
  an empty comment. The symptom is a composer that looks right in the screenshot and no record on disk.
- **The prefill is `@path#L12 `, not `path:12`.** It is the comment's target label, written into the
  text where the reviewer can edit or delete it, not a header above it.
- **The record is written a beat after the comment is drawn.** It goes through the main process, so
  reading `kakapoComments.read()` immediately after `⌘Enter` returns zero records. Poll it; do not read
  it once and conclude the write never happened.
- **An empty hand-off still records a read mark.** `archiveMergedItems` calls `markRead()`
  unconditionally, so `⌘A ⌘C` on a panel with no comments in it archives nothing and still moves the
  mark. A check that only asserts "the review is empty afterwards" therefore passes on a review that was
  empty to begin with — count the cards first.
- **`?` is driven by the key, not the code.** The shortcut table spells it `?`, and the matcher folds the
  Shift into a one-character non-alphanumeric key, so `page.key("?", "Slash", 191, 8)` matches and
  `page.key("/", "Slash", 191, 8)` does not. The opposite of every letter chord.
- **Do not call `addComment(...)`.** It is the internal writer; calling it proves nothing about the
  caret, the composer, the key or the prefill. The same goes for `window.kakapoGit.markRead()` — that is
  the hand-off's own IPC, so calling it leaves "does the hand-off call it" untested.
- **The hand-off has two paths into the same place.** The panel's own `⌘C` keydown and the Edit menu's
  native `copy` accelerator both fire; `08-dock.js` guards against archiving twice with a one-tick flag.
  A check that drives only one path does not cover the other.
- **Archiving one card does not close the panel; archiving all of it does.** Both are intended.
- **The clipboard is real.** `⌘C` writes to the operator's actual clipboard. Say so in the report if the
  run is on a machine someone is using.
- **A comment on a deleted line is its own case.** Stepping off one was broken for the whole of the
  diff view because the window was hard-coded; a fixture without a deleted line cannot see it.
