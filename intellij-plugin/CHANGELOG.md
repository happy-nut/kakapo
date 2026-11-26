# kakapo comments

## 0.0.6

A comment could be written and then not read again. The gutter mark carried a tooltip and nothing else,
so a comment was readable only while the mouse was on its icon, in the one file it was in, and the
Kakapo Review tool window listed the archive alone — a comment you had just written was in no list
anywhere. Clicking the mark now opens the comment, and the tool window has an **Open** list beside
**Archived**. Which lists exist is a table, and the format check holds that table to covering every
state a comment can be in, so a state with no list is a failed build rather than a comment nobody can
find.

The box is one card for the whole line instead of a form for a new comment: it shows the comments
already there with the line they are about, and each carries **Edit** and **Delete**. An edit changes
the body in the line it already is, the way archiving does, so the fields kakapo keeps and this plugin
does not model survive being edited.

The card itself is drawn rather than assembled — rounded, on the editor's own notification colour, with
the review's accent down its left edge, the quoted line set in the editor's font, and the body wrapped
to a width that fits the editor it sits in. A line with two comments shows one mark and not two stacked
in the same gutter row, where the second one was simply never seen.

## 0.0.5

⌃⇧⌘/ now archives what it copies, so a hand-off carries only what is new, and the archive is readable
in the Kakapo Review tool window rather than gone. A record is archived in place, so the fields kakapo
keeps and this plugin does not model survive it.

A comment written in the Diff window is recorded as a diff comment and says which side it was written
on. Until now every comment claimed to be a source comment, so kakapo reopened it in the wrong view,
and one written on the left carried a line number the working file does not have.

Ids are taken from the review file's own header, which states the next free one and says that ids are
shared with the file kakapo keeps beside it. Counting from the highest id in one file was how two
records could end up with the same id and a reply land on the wrong comment.

The comment box shows the line it is about under its location, and its Comment button is the primary
one and is off until there is something to keep — pressing it on an empty box used to close the box and
write nothing, which reads as a comment that vanished. The format and the git directory
are plain Kotlin now, run for real by `npm run idea:review` — every check on them used to be a regular
expression over the source, which passes whether or not the code is ever called.

## 0.0.4

A comment written in a linked worktree or a submodule used to vanish. The review lives in the
repository's own git directory, and the plugin looked for `.git` as a directory — in a worktree and in
a submodule it is a file holding `gitdir: <path>`, so there was nowhere to write and the comment was
dropped without a word. It follows that pointer now, and a comment that still cannot be stored is said
out loud with its text, rather than swallowed.

The line a comment is about is shown in the box the whole time it is being written. It used to be the
box's placeholder, which the first keystroke wipes. It is also no longer copied into the comment's own
text: the hand-off builds it from the record, so editing a comment can no longer lose its address.

## 0.0.3

The comment chord moves off block comment. 0.0.1 and 0.0.2 asked for ⌘⇧/, which is what IntelliJ
gives to Comment with Block Comment on macOS, so one of the two lost. Writing a comment is ⌥⇧⌘/ now,
and handing the review over is ⌃⇧⌘/. Both are free in the IDE's own keymap and in macOS's.

## 0.0.2

A review written in kakapo is now marked in the gutter when the file is opened, not only inside the
Diff window. The painter had two callers in 0.0.1 and neither of them was "a file was opened", so a
review written in kakapo stayed invisible here until a diff was opened.

## 0.0.1

First release: a review comment at the caret, in the editor and in the Diff window, kept in the
repository's own .git/kakapo/comments.jsonl so kakapo and the IDE read one review.
