# STACK — analyze a stack trace

A reader pastes a stack trace and reads it as a list of places in this project. IntelliJ's Analyze Stack
Trace, with the half that groups threads and finds deadlocks left out on purpose. The standard it is held
to is IntelliJ's own parser for JVM frames — not internal consistency — and the output of real crashing
programs for every other language kakapo reads.

## Sub-features

- `STACK-1` **`⌘⇧S`** — open the panel. It is also in Find Action (`⌘⇧A`), which reads the same
  shortcut table, so both ways in exist and both are driven.
- `STACK-2` **the clipboard prefill** — on open, the textarea fills itself from
  `window.kakapoClipboard.read()`, but only when that text holds at least one frame, and never over text
  the reader has already typed. There is no parse button: editing the text re-reads it after ~120ms.
- `STACK-3` **a frame row** — the repo-relative path and line, the symbol beside it. Click, or `Enter` on
  the selected row, opens that file at that line through `openSourceAt`. `⌘Enter` from anywhere in the
  panel takes the first frame that resolves, which is where it blew up.
- `STACK-4` **a frame that resolves to nothing** — dimmed, and it names the file it looked for. A frame
  that names no line at all (`Native Method`) is one of these. So is a line no reader claims, which
  renders as the prose it is rather than being dropped.
- `STACK-5` **the row-ranking** — two files called `Bar.java` are told apart by the package in the class
  name (`com.foo.Bar` wants `com/foo/`), then by what this review changed, then by the shortest path. A
  row whose ranking tied carries `+N`, because then the jump is a guess.
- `STACK-6` **the keyboard** — `↓` from the textarea moves into the list and `↑`/`↓` walk it; `↑` inside
  the textarea stays the textarea's, so a pasted trace is still editable. `Esc` closes and hands the
  keyboard back to whatever opened the panel.

## How to get to it (user POV)

- `⌘⇧S` anywhere in the window, with a trace already on the clipboard — the common path.
- `⌘⇧A`, then the Analyze Stack Trace row.

## Driving it with the CDP harness

```bash
node .claude/skills/verify-kakapo/stack-trace.mjs
KAKAPO_VERIFY_LOCALE=ko node .claude/skills/verify-kakapo/stack-trace.mjs
```

The fixture repository carries `src/main/java/com/foo/Bar.java`, `src/main/java/com/qux/Bar.java` and
`src/app/handler.ts`, so the JVM reader, the V8 reader and the package ranking are all exercised against
files that really exist. The script borrows the operator's clipboard to drive `STACK-2` and puts back
what was in it.

Two things it costs a run to learn:

- **Ask where the caret was painted, not what the model holds.** `#source-body .source-row.cursor-line`
  and `.code-cursor` are the answer; `viewerCursor` is a `let` and invisible to CDP anyway.
- **`⌘⇧S` is `page.key("S", "KeyS", 83, 12)`** — the physical `code` is what `shortcutChords()` matches,
  and 12 is Meta plus Shift.

## What the suite already covers, and what only the app can say

`test/stack-trace.test.mjs` holds the parser against IntelliJ's captured answers for every corpus line,
the five real-crash captures, the reader order, the normalize-by-count rule in both directions and the
resolver's ranking. What it cannot say is whether `⌘⇧S` reaches the renderer on macOS, whether the
clipboard bridge returns anything, and what the panel's Korean labels look like at 900px — which is what
this script and `npm run ui:text` are for.
