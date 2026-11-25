# kakapo comments, in IntelliJ

Write a review comment at the caret, and hand the whole review to an agent in one copy.

| | |
| --- | --- |
| ⌥⇧⌘/ | comment on the caret's line |
| ⌃⇧⌘/ | copy every unaddressed comment |

Comments live in the repository's own `.git/kakapo/comments.jsonl` — the file kakapo reads — so a
comment written in the IDE opens in kakapo, and one written in kakapo is marked in the IDE's gutter.

## Where the marks come from

A comment written in kakapo is painted in the gutter when the file is opened, by `CommentMarksOnOpen`,
and inside the Diff window by `DiffCommentExtension`. Both go through the one painter, `CommentMarks`.
The first of those was missing for the whole of 0.0.1: the painter had two callers and neither of them
was "a file was opened", so a review written in kakapo stayed invisible here until you opened a diff.

## The part that is not obvious

`RangeMarker` follows edits inside one open editor. It does not survive a restart, a branch switch,
or an agent editing the file from outside, which is the whole point of this workflow. So a comment
stores the text of the line it was written on, and `Anchor.line()` searches outward from the stored
line for that text, staying put when the text is gone rather than jumping somewhere wrong.

That rule is plain Kotlin with no IDE classes in it, so it is checked without an IDE:

```bash
npm run idea:anchor
```

## Build

```bash
npm run idea:build
```

The zip lands in `build/distributions/`. Install it with Settings → Plugins → Install Plugin from Disk.

Run these through npm rather than `gradle` directly: this machine has no system Java, and the npm
scripts hand Gradle the JDK 21 the repository already bundles for reading Java, so there is one
pinned Java here instead of a second one downloaded per machine.

## Releasing

```bash
npm run idea:build    # build/distributions/kakapo-comments-<version>.zip
npm run idea:publish  # uploads that zip to the Marketplace
```

The **first** version had to go through <https://plugins.jetbrains.com/plugin/add> and Marketplace
moderation; 0.0.1 is published at <https://plugins.jetbrains.com/plugin/36424-kakapo-comments>.
Every version after it is the command above.

`publishPlugin` reads `JETBRAINS_MARKETPLACE_TOKEN` from the environment, and falls back to
`~/.config/kakapo/jetbrains-marketplace-token` on a machine that keeps one there. The token is never
in this repository.

A release's notes come from `CHANGELOG.md`, read by version, so bumping the version without writing
its section fails the build rather than shipping the previous release's sentences.
