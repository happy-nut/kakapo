# Bug bounty 2026-10-26, round 2 — main process IPC and the comment thread

Round 1 covered the newest ~2,500 lines. This round went where it had not: the thread files and the
window state the IPC handlers read. Three bugs, and one second-order effect of my own fix caught before
it shipped.

## G1 The app points a window at BOTH of its thread files
`state.knowledgeFile` was assigned by no production code at all — only by three test files, each of which
built the state itself. So the split comments-file.ts is designed around never ran in the shipped app:
agent knowledge stayed in the workspace's own conversation and died with the worktree, which is the one
thing the shared file exists to prevent. It was invisible to the compiler because every field of
CommentsIpcState is optional, so a WinState missing one is still structurally a CommentsIpcState.
    CHECK: node --test test/comments-file.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G2 An agent's follow-up to its own note keeps pointing at that note
Renumbering a kept record out of an id collision moved the parent alone; the child's `re:` stayed on a
number that now belonged to one of the reviewer's comments. Measured: note 2 -> 4, follow-up still re:2.
    CHECK: node --test test/comments-concurrency.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G3 Switching a window to another repository takes nothing of the old one with it
`delivered` answers "has this window's renderer seen this record" — a question about one repository's
conversation — and survived a repo switch. Both call sites now go through one function, and a source
guard keeps them from drifting apart again, which is how G1 happened.
    CHECK: node --test test/comments-file.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G4 A workspace with no conversation of its own still folds in its legacy stores
Not a pre-existing bug: turning the shared file on (G1) made `exists` true in a workspace that had never
had a comment, because a sibling worktree had written knowledge — and the renderer reads that flag as
"there is a thread, skip the migration". Narrowing the flag alone would have been worse: the migration
saves the whole list, and a list without the shared notes writes the shared file back empty. Both facts
now travel, and the migration starts from what the files already hold.
    CHECK: node --test test/comments-file.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G5 Nothing else regressed
    CHECK: npm test 2>&1 | tail -8
    EXPECT: # fail 0

## G6 The real app still passes its own checks
    CHECK: npm run nav:smoke 2>&1 | tail -4
    EXPECT: checks passed in the real app
