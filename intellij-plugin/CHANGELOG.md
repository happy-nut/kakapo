# kakapo comments

## 0.0.2

A review written in kakapo is now marked in the gutter when the file is opened, not only inside the
Diff window. The painter had two callers in 0.0.1 and neither of them was "a file was opened", so a
review written in kakapo stayed invisible here until a diff was opened.

## 0.0.1

First release: a review comment at the caret, in the editor and in the Diff window, kept in the
repository's own .git/kakapo/comments.jsonl so kakapo and the IDE read one review.
