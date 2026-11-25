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
```

Evidence lands in `.kakapo-verify/<stamp>-idea-<name>/`: numbered screenshots, `run.log`, and the IDE's
own `idea.log`.

## The contract a script has to meet

`drive.mjs` gives `h.check`, `h.control`, `h.absent`, `h.shot`, `h.until`, and `h.ideLog()`. The rule
from `AGENTS.md` — a probe that reports an absence has to show a presence first — is enforced, not
advised: `h.absent(...)` fails unless an `h.control(...)` has already passed, and a run that passes no
control at all fails even if every other check was green.

The control that costs nothing and catches the most is the IDE's own line:

```js
h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
  "the IDE loaded the plugin from the distribution zip");
```

## Reaching a window a chord opens

`h.key("alt+shift+cmd+/")` sends a chord to the IDE, and `h.front()` raises it first. Both go through
System Events, which the Mac grants per application: without that grant it answers -1743 and the run
fails rather than going on. `burrow click` and `burrow key` report success and reach nothing, so they
are not what this harness types with.

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

## What it cannot do

It cannot press a keyboard shortcut or click a button: ⌘⇧/ cannot be driven from here, so a run proves
what the plugin does on its own — loading, painting an existing review, surviving a project open — and
not what a keystroke does. Anything that needs a keystroke is checked by `npm test` against the sources
and by a person pressing the key.
