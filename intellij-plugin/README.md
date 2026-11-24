# kakapo comments, in IntelliJ

Write a review comment at the caret, and hand the whole review to an agent in one copy.

| | |
| --- | --- |
| ⌘⇧/ | comment on the caret's line |
| ⌃⌘⇧/ | copy every unaddressed comment |

Comments live in the repository's own `.git/kakapo/comments.jsonl` — the file kakapo reads — so a
comment written in the IDE opens in kakapo, and one written in kakapo is marked in the IDE's gutter.

## The part that is not obvious

`RangeMarker` follows edits inside one open editor. It does not survive a restart, a branch switch,
or an agent editing the file from outside, which is the whole point of this workflow. So a comment
stores the text of the line it was written on, and `Anchor.line()` searches outward from the stored
line for that text, staying put when the text is gone rather than jumping somewhere wrong.

That rule is plain Kotlin with no IDE classes in it, so it is checked without an IDE:

```bash
gradle anchorCheck
```

## Build

```bash
gradle buildPlugin
```

The zip lands in `build/distributions/`. Install it with Settings → Plugins → Install Plugin from Disk.
