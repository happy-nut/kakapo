---
name: formal-compare-mode
description: Model-check the compare controls — Alt+A/U/T/N, the patch-set bar, Cmd+9 ranges and the pull-request compare — against the promise that the compare menu always ticks the row describing the diff the window is actually built from. Use before and after changing any handler that writes options.base, options.baseLabel, options.target, options.staged, state.compareScope or state.compareTip, or the mode derivation in kakapo:compare-menu.
---

# The compare controls tell the truth

## The promise

**The compare menu always ticks the row that describes the diff the window is actually built from.**

When it breaks, the reader opens the one control that exists to say what the diff measures against, is
told the wrong thing, and goes off to read a diff believing it answers a question it does not answer.
There is nothing on screen to catch it: the diff looks fine, and the two controls that disagree sit a few
pixels apart.

## What is checked, and where

`CompareMode.tla` is a model of six fields and eleven transitions. Every action names the handler it
models and the lines it was read from.

| Written by | File | Fields |
| --- | --- | --- |
| `kakapo:set-compare-mode` (⌥A ⌥U ⌥T ⌥N) | `src/app-main.ts:406` | base, baseLabel, target, staged, compareScope, compareTip |
| `kakapo:set-review-base` (the bar's numbers, ⌥] ⌥[) | `src/app-main.ts:285` | base, baseLabel, staged |
| `kakapo:set-review-target` (the bar's right group) | `src/app-main.ts:306` | target, staged |
| `kakapo:set-review-compare` (⌘9 range, the bar's reset) | `src/app-main.ts:342` | base, baseLabel, target, compareScope, staged |
| `openPullRequestIn` (⌥L, and the `<pr link>` argument) | `src/app-main.ts:363` | base, baseLabel, target, compareScope, staged, compareTip |
| `restoreCompareRef` (on open) | `src/app-main.ts:235` | compareRef, compareTip |

| Read by | File |
| --- | --- |
| the `mode` derivation in `kakapo:compare-menu` | `src/app-review-ipc.ts:348-356` |

The model holds the **meaning** of `options.base` rather than a sha — `auto`, `HEAD`, `mergebase`,
`reftip`, `mark`, `commit` — because the question is which diff is on screen, and two shas are not the
same diff.

`BuiltMode` (ground truth) is a function of the options alone, because the options are all
`readUnifiedDiff` is given. `compareTip` is never passed to the build; it is a memory of which key was
pressed. That asymmetry is the point rather than a cheat: the flag exists (`app-main.ts:229-233`)
*because* the menu cannot tell "all" from "tip" by looking at base/baseLabel, so the flag is the claim
and `BuiltMode` is the truth, and the invariant asks whether the claim is kept up.

## Running it

```bash
.claude/skills/formal-compare-mode/check.sh
```

Exit 0 = the promise holds in all four shapes. Exit 1 = at least one violated, and the trace above the
summary is a sequence of the handler names in the table. Runs in a few seconds; the state space is tens
of states.

It needs a JVM and `tla2tools.jar`. The script says so and prints the one command that fetches it:

```bash
mkdir -p ~/.cache/kakapo-formal && curl -sL -o ~/.cache/kakapo-formal/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
```

`TLA_TOOLS=/path/to/tla2tools.jar` overrides the location. Checked with TLC 2.19.

Read every result with `/devkit:statechart`: it turns a violation into the shortest path in plain words,
and draws how the controls move between modes when the check passes.

## The shapes

Three constants. The first two are checked both ways, because both are ordinary situations and the answer
differs between them; the third is pinned (see finding 2).

- `AutoResolves` — does the automatic base resolution find a base? `resolveAutomaticReviewBase`
  (`src/git.ts`) returns nothing the moment `git status` says anything. **TRUE** = a clean
  worktree with commits ahead, which is this product's own workflow (an agent committed and stopped).
  **FALSE** = a dirty worktree.
- `MarkUsable` — does `resolveReadMark` (`src/patch-sets.ts`) answer? FALSE = nothing handed off yet, or
  the agent rebased the mark off the branch.
- `RestoredTip` — did the window open with `compareTip` set? Pinned FALSE: the code no longer restores
  it. Kept as the record of finding 2 below.

## Current result: the promise holds

`check.sh` exits 0 in all four shapes. It did not when this model was written, and what it found is worth
keeping, because both were invisible to every test in the suite.

### 1. `compareTip` outlived the base it described — fixed

Four steps: open the window, **⌥A**, **⌥T**, then the patch-set bar's **"All"** option. The base went
back to automatic and `compareTip` was left TRUE, so the window showed "all changes" while the menu
ticked **tip** — and the patch-set bar beside it said "all changes · main" at the same time. Only on a
clean worktree with commits ahead, which is this product's own workflow.

The flag was cleared by two of its four writers. It is now written in one place, `setCompareTip`
(`src/app-main.ts`), and every handler that rewrites `options.base` calls it — because the flag is a
claim *about* that value.

**The obvious wider fix was wrong, and the model said so in two steps.** Clearing the flag in all three
siblings of `set-compare-mode` makes it worse: `set-review-target` does not move the base, so after ⌥T
the diff is still a tip diff and clearing the flag there makes the menu claim "all" for it. The mirror
image of the bug being fixed. `set-review-target` still leaves the flag alone, on purpose.

### 2. A restored `compareTip` described a build that never used it — fixed

`restoreCompareRef` brought the flag back from the workspace file, so a worktree whose last action was ⌥T
opened violating the promise in its first frame, with no interaction at all. Both of that function's
callers run *after* the review has been built — the cold boot at the end of the first build, the folder
switch before a build that takes its base from `compareSelectionFor` — so neither build ever used the
ref's tip as its base. The restore is gone: the ref comes back, the mode does not.

Nothing that worked was lost. Before, a reopened worktree *claimed* tip and showed all-changes; now it
says all-changes and shows all-changes, and ⌥T is one key away. Making a launch genuinely resume tip mode
is a different change — the base would have to be resolved before the first build, and it would have to
yield to `--base` and `--staged`.

`RestoredTip` survives as a constant, pinned FALSE by `check.sh`. Set it TRUE in `CompareMode.cfg` and
run TLC by hand to see that failure again; it is the shape of the finding, not a claim about today's code.

### 3. A pull request's base claimed a branch stood behind it — fixed

The model said `label' = FALSE` for `OpenPullRequest` and the handler set `baseLabel`, so the model was
describing code that did not exist. Corrected to match, it failed in four steps: open, **⌥A**, **⌥L**,
then the patch-set bar's **WT**. Clearing the target leaves the pull request's base in place, and a set
`baseLabel` makes `ExplicitBase` false, so the menu ticks **all changes** over a diff measured against
another pull request's merge base.

`baseLabel` means "a branch name stands behind this base", and after this change the base is a merge
base rather than a branch tip — so the claim was wrong on its own terms as well as dangerous. The handler
no longer writes it, which is what the model always said. Setting `label' = TRUE` in that action is the
negative control: it reproduces the violation above.

## Changing the code this covers

1. Run the check first, unchanged. It exits 0 today, so a failure before you have changed anything means
   the model has drifted from code someone else moved — read it before you read your own change.
2. Make the change.
3. Decide which of these the change is, and act accordingly:
   - **No effect on the model.** It does not write any field in the table and does not touch the `mode`
     derivation. Nothing to do.
   - **The model no longer describes the code.** A handler gained or lost an assignment, a field moved,
     a new handler writes one of these fields. Fix the action in `CompareMode.tla` — read the handler and
     write what it does, do not shape the model to make the check pass — and move the sync commit below.
   - **The promise changed on purpose.** Only with evidence inside the change itself: a doc comment, a
     test, a commit message. Quote it, change `MenuTellsTheTruth` or `BuiltMode`, and say so.
4. Run it again. **A pass is not enough**: a model that has lost its ability to fail passes too. Break
   the new behaviour the way the invariant is supposed to catch (drop a new assignment, flip a new
   condition), confirm the check reports it, and throw the break away.
5. Tell the difference between a model error and a bug by walking the counterexample through the real
   handlers. If a step cannot happen in the code, the model is wrong — fix the model and say what was
   wrong. If every step can happen, it is a bug: report it with the counterexample as a list of control
   presses, and do not commit a product fix from this skill.

## Scope — what a pass would and would not mean

- **Only the six fields in the table.** `compareRef` itself, `reviewBase`/`reviewTarget` (the values the
  build resolved), the patch-set bar's own option list and the diff content are all outside it.
- **One window, one repository, no concurrency.** The watch tick that rebuilds on a file change is not
  modelled; neither is a second window on the same workspace.
- **The constants are fixed for a run.** A mark that becomes unusable *while* the review sits on it — the
  agent rebasing under an open ⌥N — is not reachable in the model. It is a real situation, and a
  reasonable thing to add.
- **`BuiltMode` is a model of the build, not the build.** It says which question the options ask. It does
  not run `git diff`.

## Sync

Covered code last read at **`06828e7`** — the last commit that touched it (`src/app-main.ts` lines 310–640, `src/app-review-ipc.ts` lines
420–460). Move this forward only after confirming the model still describes the code at the new commit —
not merely that the check still returns the same number.
