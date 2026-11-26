---
name: verify-kakapo-idea
description: Install the IntelliJ plugin's own distribution zip into a throwaway IDE sandbox, open a scratch repository in the real IntelliJ IDEA the user has, and leave screenshots and a transcript as evidence. Use when asked to show the plugin working, to screenshot it, or to confirm its behaviour in a real IDE rather than in the test suite.
---

# Verifying the IntelliJ plugin

`intellij-plugin/` is a separate product from the Electron app, and `npm test` cannot see it: the suite
reads its sources as text. Whether the plugin **loads**, whether the IDE accepts its extension points,
and whether a review written in kakapo is actually painted are questions only a running IDE answers.

**Read `AGENTS.md` first — it outranks this file.**

## What this harness installs, and why it matters

It installs `intellij-plugin/build/distributions/kakapo-comments-<version>.zip` — the artifact the
Marketplace serves — and refuses to run without it.

It deliberately does **not** use `gradle runIde`. That task builds `build/idea-sandbox`, whose plugin
directory carries jars the zip does not: `kotlin-stdlib` among them, which the platform supplies at
runtime and newer builds therefore exclude from the distribution. A run against the sandbox layout can
pass while the zip a user downloads fails to load, so the zip is the only thing this harness installs.

## Running one

```bash
npm run idea:build                                    # the zip, through the bundled JDK
node .claude/skills/verify-kakapo-idea/marks-from-kakapo.mjs
node .claude/skills/verify-kakapo-idea/comment-box-and-history.mjs   # needs System Events permission
node .claude/skills/verify-kakapo-idea/reading-a-comment-again.mjs   # needs System Events permission
node .claude/skills/verify-kakapo-idea/clicking-the-card.mjs         # pauses for a point to click
```

A script that drives the keyboard takes the screen while it runs, so it is worth running on a Mac
nobody is working at. Nothing raises the IDE on its own: `h.key` and `h.action` raise only where the
caller asked, because an IDE that keeps jumping to the front is a harness interrupting the person it
reports to.

Evidence lands in `.kakapo-verify/<stamp>-idea-<name>/`: numbered screenshots, `run.log`, and the IDE's
own `idea.log`.

## The contract a script has to meet

`drive.mjs` gives `h.check`, `h.control`, `h.absent`, `h.shot`, `h.until`, `h.clickInWindow` and
`h.ideLog()`. The rule
from `AGENTS.md` — a probe that reports an absence has to show a presence first — is enforced, not
advised: `h.absent(...)` fails unless an `h.control(...)` has already passed, and a run that passes no
control at all fails even if every other check was green.

The control that costs nothing and catches the most is the IDE's own line:

```js
h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
  "the IDE loaded the plugin from the distribution zip");
```

## Reaching a window a chord opens

`h.key("alt+shift+cmd+/")` sends a chord to the IDE, and `h.raise()` puts it in front first. Both go
through System Events, which the Mac grants per application: without that grant it answers -1743 and
the run fails rather than going on. `burrow click` and `burrow key` report success and reach nothing,
so they are not what this harness types with.

An input method is between the keystroke and the IDE. With `com.apple.inputmethod.Korean` selected an
Option chord does not fire the action — the IME takes it and types a character, and one run edited the
source file it was supposed to be commenting on. Latin typed into a popup arrives as Hangul too, and a
Find Action query once opened Local History that way. So `h.action(text)` switches the input source
first and then reaches the action by name, which needs no Option at all.

`⌃Space` is that switch and it **cycles**: pressed once per action it went back to Korean on the second
one. `h.latin()` presses it once a run, and the run puts it back at the end — it is the person's own
Mac setting, not the run's.

A window opened by a chord needs a control that is not the picture, because a keystroke that went
nowhere leaves a screenshot of the editor and nothing says so. Use what the action changed on disk:

```js
await h.key("ctrl+shift+cmd+/", 4000);
await h.until(() => readFileSync(comments, "utf8").includes('\"addressed\":true'), 30000,
  "the hand-off chord to reach the IDE and archive the comment");
await h.shot("history");
```

A tool window cannot be opened by seeding `.idea/workspace.xml` instead. That was tried, and the IDE
opened with the window shut; the action's own `ToolWindow.show` is the way in.

For a window with no file to write, the control is to write one through it: `h.type(...)` then `⌘⏎`,
and then the record on disk. A screenshot says a card is on the screen; only the record says the card
had the keyboard.

## What a fresh IDE does that has to be arranged, not clicked

Four things stop a never-used config before any project opens, and none of them is worth answering with
a keystroke even now that keystrokes work: a dialog that appears before the window is up has nothing to
aim at. `drive.mjs` arranges all four:

| Stop | Arranged by |
| --- | --- |
| Language and Region dialog (the gate reads the system locale) | `JAVA_TOOL_OPTIONS` with an English locale — the native launcher drops unknown `-D` arguments, so the JVM has to be told directly |
| JetBrains user agreement | `jb.consents.confirmation.enabled=false` — copying the user's config does **not** carry it, which was measured, not assumed |
| "Trust and Open Project?" | a seeded `options/trusted-paths.xml` naming the scratch directory |
| Nothing open in the editor | a seeded `.idea/workspace.xml` with the file and the caret line, written while the IDE is down — it rewrites that file on exit |

## Clicking what the card draws

A keystroke is addressed to a process; a click is not. System Events' click is swallowed by the Java
window, which is why the card's Edit and Delete links and the gutter mark went untested for a release
while only the store calls underneath them were covered. `burrow`'s click goes through screen sharing
and arrives as a real event — the same path that can answer a permission window — so `h.clickInWindow`
sends it there.

Three coordinate spaces meet in that one call and none of them may be guessed:

| Space | Read from |
| --- | --- |
| the evidence picture's pixels | the PNG's own IHDR width |
| the window's points | `kCGWindowBounds` for this run's process |
| burrow's screen pixels | `NSScreen.backingScaleFactor` |

`burrow click` counts in the pixels of `burrow shot`, not in points (`burrow/main.go` says so in the
`click` case). A click sent in points lands at half the intended place: the first run that clicked put
its click in the project tree, which took focus off the card and read exactly like a plugin ignoring
clicks. The failure picture is what told them apart — the card was still open, and its field had lost
focus, which no un-delivered click could have done.

The point itself is still read off the picture by whoever is running the scenario:
`clicking-the-card.mjs` writes `aim-needed-<label>.json` into the evidence directory and waits for
`aim-<label>.json` with `{x, y}` in that picture's pixels. Nothing here can ask Swing where it put a
link.

Judge the result by the file, never by the next picture. `Edit` fills the field with the comment's
current text and leaves the caret at the end, so typing alone appends: a check that only looked for the
new words passed on `…the raw argument.Greet by display name…` and would have passed on a plugin that
never replaced anything. Select all first, then assert equality.

## What it cannot do

It cannot choose where to click. The chord the plugin declares still does not reach a Java window when
it is synthesised — macOS turns Option into a character before Java sees it — so an action is reached
through Find Action, and only the first one in a run lands: a later one loses the screen to the terminal
the run was started from, whatever action it asks for. Put the thing being photographed in that first
slot.
