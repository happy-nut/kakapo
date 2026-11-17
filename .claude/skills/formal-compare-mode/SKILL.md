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
| `kakapo:set-compare-mode` (⌥A ⌥U ⌥T ⌥N) | `src/app-main.ts:550` | base, baseLabel, target, staged, compareScope, compareTip |
| `kakapo:set-review-base` (the bar's numbers, ⌥] ⌥[) | `src/app-main.ts:399` | base, baseLabel, staged |
| `kakapo:set-review-target` (the bar's right group) | `src/app-main.ts:423` | target, staged |
| `kakapo:set-review-compare` (⌘9 range, the bar's reset) | `src/app-main.ts:466` | base, baseLabel, target, compareScope, staged |
| `kakapo:open-pull-request` (⌥L) | `src/app-main.ts:504` | base, baseLabel, target, compareScope, staged, compareTip |
| `restoreCompareRef` (on open) | `src/app-main.ts:323` | compareRef, compareTip |

| Read by | File |
| --- | --- |
| the `mode` derivation in `kakapo:compare-menu` | `src/app-review-ipc.ts:433-449` |

The model holds the **meaning** of `options.base` rather than a sha — `auto`, `HEAD`, `mergebase`,
`reftip`, `mark`, `commit` — because the question is which diff is on screen, and two shas are not the
same diff.

`BuiltMode` (ground truth) is a function of the options alone, because the options are all
`readUnifiedDiff` is given. `compareTip` is never passed to the build; it is a memory of which key was
pressed. That asymmetry is the point rather than a cheat: the flag exists (`app-main.ts:313-321`)
*because* the menu cannot tell "all" from "tip" by looking at base/baseLabel, so the flag is the claim
and `BuiltMode` is the truth, and the invariant asks whether the claim is kept up.

## Running it

```bash
.claude/skills/formal-compare-mode/check.sh
```

Exit 0 = the promise holds in all eight shapes. Exit 1 = at least one violated, and the trace above the
summary is a sequence of the handler names in the table. Runs in a few seconds; the state space is tens
of states.

It needs a JVM and `tla2tools.jar`. The script says so and prints the one command that fetches it:

```bash
mkdir -p ~/.cache/kakapo-formal && curl -sL -o ~/.cache/kakapo-formal/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
```

`TLA_TOOLS=/path/to/tla2tools.jar` overrides the location. Checked with TLC 2.19.

Read every result with `/devkit:statechart`: it turns a violation into the shortest path in plain words,
and draws how the controls move between modes when the check passes.

## The eight shapes

Three constants, because all eight combinations are ordinary situations and the answer differs between
them.

- `AutoResolves` — does the automatic base resolution find a base? `resolveAutomaticReviewBase`
  (`src/review-base.ts`) returns nothing the moment `git status` says anything. **TRUE** = a clean
  worktree with commits ahead, which is this product's own workflow (an agent committed and stopped).
  **FALSE** = a dirty worktree.
- `MarkUsable` — does `resolveReadMark` (`src/patch-sets.ts`) answer? FALSE = nothing handed off yet, or
  the agent rebased the mark off the branch.
- `RestoredTip` — did the window open with `compareTip` restored from the workspace file? TRUE = the last
  thing done in this worktree was ⌥T.

## Current result: the promise does not hold

**Two findings, both real, neither fixed** — this skill reports, it does not change product code.

### 1. `compareTip` outlives the base it describes

Violated in every shape with `AutoResolves = TRUE`. The counterexample is four steps:

1. open the window
2. **⌥A** — base becomes the merge-base with the branch, labelled with its name, `compareTip := FALSE`
3. **⌥T** — base becomes the ref's tip, `compareTip := TRUE`
4. **the patch-set bar's "All" option** (`kakapo:set-review-base` with `"auto"`) — base goes back to
   automatic and the label is cleared, **and `compareTip` is left TRUE**

The window is now showing "all changes"; the compare menu ticks **tip**. The patch-set bar beside it says
"all changes · main" at the same time.

`compareTip` is cleared by exactly two writers — `set-compare-mode` (`app-main.ts:580`) and
`open-pull-request` (`app-main.ts:523`). `set-review-base`, `set-review-target` and `set-review-compare`
all leave it. It is persisted (`COMPARE_TIP_KEY`), so the wrong tick survives a restart.

**What the fix is not.** Clearing the flag in all three siblings makes it worse, and the model says so in
two steps: `set-review-target` does not move the base, so after ⌥T the diff is *still* tip mode and
clearing the flag there makes the menu claim "all" for a tip diff. The flag has to be cleared exactly
where the base is rewritten — `set-review-base` and `set-review-compare`, not `set-review-target`. With
that narrower change the model holds in six of the eight shapes (the two left are finding 2).

### 2. A restored `compareTip` describes a build that never used it

Violated in both shapes with `RestoredTip = TRUE` and `AutoResolves = TRUE`, **in the initial state**,
with no interaction at all. `restoreCompareRef` (`app-main.ts:323`) runs *after* the first build, so a
window whose workspace file remembers ⌥T opens showing the automatic base while the menu ticks tip.

## Changing the code this covers

1. Run the check first, unchanged, and note the result. Four violations today; a fifth means the change
   introduced something.
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
