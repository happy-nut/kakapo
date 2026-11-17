# READ — reading the diff

Once a review is open, this is the reading surface: two sidebar tabs (the changed files, and the whole
project tree), the side-by-side diff beside them, a caret you move with the keyboard, and keys that step
from one change to the next without you hunting for them. Marking a file *Viewed* is how you keep your
place across a long review.

## Sub-features

- `READ-1` **`⌘1` / `⌘2`** — Files tab / Changes tab.
- `READ-2` **`F7` / `⇧F7`** — next / previous change. One stop per edit, deleted lines included — not one
  per `@@` hunk.
- `READ-3` **`⌘⇧→` / `⌘⇧←`** — next / previous file in the diff.
- `READ-4` **`Space` on a changed file** — toggle *Viewed*.
- `READ-5` **`⌘F`** — find in the open file; `Enter` / `⇧Enter` to step, `⌥M` `⌥W` `⌥X` for case, whole
  words, regex, `⌥D` to search only the changed lines.
- `READ-6` **the overview stripe** — the painted minimap beside the diff. *(Already driven by
  `review:smoke`; see that script rather than re-writing it.)*
- `READ-7` **`⌘⇧W` whitespace**, the Diff menu's context size, `⌥W` line wrap, `⇧⌥A` align changes.
- `READ-8` **the caret** — `↑` / `↓` move it; clicking a line puts it there; `⌘L` goes to a line.

## How to get to it (user POV)

- Open a review (`OPEN`) — the diff is what you land on.
- Click a file in the Changes list, or use `⌘⇧→`.
- The toolbar's own buttons: `#diff-next-change`, `#diff-prev-change`, `#diff-next-file`,
  `#diff-prev-file`, `#diff-sidebar-toggle`, `#diff-line-wrap-toggle`, `#diff-open-source`.
- The application menu: Diff ▸ whitespace, context size.

## Driving it with the CDP harness

**Preconditions:** a fixture whose diff has **two files** and, in one of them, **two separate edits plus
a deleted line** — otherwise `F7` cannot be distinguished from "scroll to the next file" and the deleted
line case (the one that was broken) is not exercised.

- `READ-1` — `⌘2` is `page.key("2", "Digit2", 50, 4)`, `⌘1` is `Digit1` / 49.
  Observe:
  ```js
  await page.evaluate(`[document.getElementById('changes-panel').classList.contains('hidden'),
                        document.getElementById('files-panel').classList.contains('hidden')]`)
  ```
  flips between `[false, true]` and `[true, false]`.

- `READ-2` — `F7` is `page.key("F7", "F7", 118, 0)`; `⇧F7` adds `8`.
  Observe: the composer-free way to see where it stopped is the scroll position plus the highlighted row.
  Press `F7` as many times as the fixture has changes and check it visits each one **and that the
  backward pass visits the same set** — a reverse walk that skips a change is the defect this exists for.

- `READ-4` — focus the Changes tab, move with `↓`, press `Space`
  (`page.key(" ", "Space", 32, 0)`).
  Observe: the row carries the viewed state, and it survives a watch rebuild — touch a file in the
  fixture, wait for the diff to update, and check the mark is still there.

- `READ-5` — `⌘F` is `page.key("f", "KeyF", 70, 4)`. Then type with `page.char(...)`, one character at a
  time, **not** `page.type`:
  ```js
  for (const ch of "parse") await page.char(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0));
  h.check(await page.evaluate(`document.getElementById('file-find-count').textContent.trim()`) !== "",
    "the find bar counts matches");
  ```
  `page.char` carries text on the keydown; a field that loses focus after the first letter is invisible
  to `page.key` and to `Input.insertText` alike, and that is how "type one character and no further
  character is accepted" once shipped.

- `READ-7` — `⌘⇧W` is `page.key("w", "KeyW", 87, 12)`. Observe: the file list or the hunk count changes
  for a fixture whose only difference in one file is whitespace.

- `READ-8` — `h.click('.d2h-code-line-ctn', n)` puts the caret on a line, where `n` counts among the rows
  that are **drawn** (the diff paints a window and leaves the rest as zero-height placeholders, so the
  Nth match is routinely unclickable). The caret cannot be read back:
  `diffCursor` is a top-level `let`, so it is not on `window`. Read it through something that prints it
  — press `?` and read the composer's prefilled target label (`CMT-1`), or `⌘K` and read the clipboard.

- Screenshot: `h.shot("reading-diff")` after an `F7` pass, with the stripe and sidebar in frame.

## Gotchas

- **jsdom has no layout, so nothing in the suite can see the stripe, the caret's position or a label that
  overflows.** A DOM assertion passes for a mark that draws nothing — that is how an invisible bookmark
  gutter shipped. Anything geometric is proved here or not at all.
- **`F7`'s stops are per edit, not per hunk, and deleted lines are stops.** A check that counts `@@`
  markers is measuring something else and will agree with a broken implementation.
- **A watch rebuild replaces `#changes-panel` wholesale.** Element references captured before an edit to
  the fixture are detached afterwards; re-query, and use `h.until` to wait for the rebuild rather than
  sleeping through it.
- **The two sidebar tabs are not symmetric.** `#changes-panel` is rendered with the review;
  `#files-panel` is hydrated on first use from the `#files-tree-html` script island. A project tree that
  is empty immediately after launch is not yet a bug.
- **`⌘1`/`⌘2` are window-scope shortcuts** (`WINDOW_SHORTCUT_IDS`), so they fire even from a focused text
  field. If a test wants to prove a text field swallows a key, pick a content-scope one.
