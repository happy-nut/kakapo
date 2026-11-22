# kakapo verification map

The repository's record of what a user can do and how to prove each one still works. Read this index,
then the file for the feature you are verifying, and use it as the method. When behaviour changes, change
the file — a map that describes a build nobody is running teaches the wrong steps.

## Standing preconditions

- `npm run build` first. `dist/` is gitignored, and a stale build is the failure most easily mistaken for
  a product regression.
- `node .claude/skills/verify-kakapo/doctor.mjs` before the first drive, and again after any drive that
  failed strangely.
- Every drive launches its own instance on its own throwaway repository, through
  `drive()` in [`../drive.mjs`](../drive.mjs). One instance at a time — one debugger port, one
  single-instance lock.
- Never drive an instance this run did not launch. A second `kakapo` is handed to the first window.
- `KAKAPO_DEV=1` is not optional. Without it the run writes into the operator's real Kakapo state.

## Driving conventions

- Keys and clicks go in over CDP at the browser's input layer, below the page.
- Prefer the ids and classes listed in [`../SKILL.md`](../SKILL.md) to coordinates, and
  `h.until(...)` to `h.sleep(...)`.
- Press the key the user presses. Calling the function it dispatches to, or the bridge method the UI
  would have called, proves the callee and not the path.
- One screenshot per feature, into the run's evidence directory.

## Evidence and skip reporting

- Capture the action and the state it left, not only the final screen.
- Check the side effect as well as the screen: what the comments bridge now holds, which files the diff
  now lists, what the compare pill now names.
- Record the exact entry point used. A feature with three entry points and one driven is partly covered,
  and the report says so.
- An unreachable path reports the command attempted and the precondition that was not met. It is never
  reported as covered by another route.

## Features

| ID | Feature | File |
| --- | --- | --- |
| OPEN | Opening a review on a folder, a file, a base | [01-open-a-review.md](01-open-a-review.md) |
| CMP | Choosing what to compare — `⌥A` `⌥U` `⌥T` `⌥N` `⌥C`, patch sets | [02-choosing-what-to-compare.md](02-choosing-what-to-compare.md) |
| READ | Reading the diff — panels, change stepping, find, viewed | [03-reading-the-diff.md](03-reading-the-diff.md) |
| CMT | Review comments and the hand-off | [04-comments-and-hand-off.md](04-comments-and-hand-off.md) |
| NAV | Code navigation — declaration, usages, source view | [05-code-navigation.md](05-code-navigation.md) |
| STACK | Analyze a stack trace — `⌘⇧S`, frames to places in this project | [06-analyze-stack-trace.md](06-analyze-stack-trace.md) |

## Not mapped yet

Real user surfaces this map does not cover. They are not verified by the files above, and a report must
not imply otherwise.

- `.http` requests (`⌘Enter`), git history (`⌘9`), the diff's overview stripe — **already driven** by
  `KAKAPO_DEV=1 npm run review:smoke`; they want map entries, not new machinery.
- Mermaid rendering — driven by `KAKAPO_DEV=1 npm run mermaid:smoke`.
- Project search (`⌘⇧F`) and its scope rail, Quick Open / Search Everywhere (`⌘P`, `⇧⇧`), Problems
  (`⌘6`), Endpoints (`⌘7`), bookmarks (`F3`), Settings including locale and theme, the pull-request
  draft (`⌥L`), `install-app` / `uninstall-app`.
