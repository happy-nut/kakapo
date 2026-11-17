---------------------------- MODULE CompareMode ----------------------------
(***************************************************************************)
(* The compare controls, and the one promise they make:                    *)
(*                                                                         *)
(*     the compare menu always ticks the row that describes the diff the   *)
(*     window is actually built from.                                      *)
(*                                                                         *)
(* Five handlers write the compare state and one derivation reads it back. *)
(* The writers are in src/app-main.ts, the reader in src/app-review-ipc.ts. *)
(* Nothing exercises them in sequence: test/compare-state.test.mjs checks   *)
(* the base the BUILD resolves for a repository, and                       *)
(* test/compare-menu-mode.test.mjs constructs one state at a time and asks  *)
(* the menu about it. No test presses two of these controls in a row, which *)
(* is the only way the fields can disagree.                                *)
(*                                                                         *)
(* Every action below names the handler it models and the lines it was read *)
(* from. A field this model treats as one assignment is one assignment in   *)
(* the handler.                                                            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    \* Does the automatic base resolution find a base? src/review-base.ts
    \* resolveAutomaticReviewBase returns undefined the moment `git status` says anything, and also when
    \* the branch has nothing ahead and no tracking branch. TRUE models a clean tree with commits ahead;
    \* FALSE models a dirty one. Both are ordinary, so both are checked.
    AutoResolves,
    \* Does resolveReadMark answer right now? (src/patch-sets.ts) FALSE models a repository nobody has
    \* handed a review off from, or one where the agent rebased the mark off the branch.
    MarkUsable,
    \* Did this window open with compareTip set? It cannot any more: restoreCompareRef (app-main.ts)
    \* brings the REF back and deliberately leaves the mode alone, because both of its callers run after
    \* the review has been built and neither build ever used the ref's tip as its base — so restoring the
    \* flag only made the menu claim a mode the window was not in, from the first frame.
    \* TRUE is still checked, and still fails. That is the record of why the restore was removed: if this
    \* arm ever starts holding, someone has put the restore back AND made the first build honour it.
    RestoredTip

(***************************************************************************)
(* options.base, as the shapes its writers can leave it in. The model holds *)
(* the MEANING of the value rather than a sha, because the question is      *)
(* which diff is on screen and two shas are not the same diff.             *)
(*                                                                         *)
(*   "auto"      undefined — the build resolves it (review-base.ts)         *)
(*   "HEAD"      the literal string, set only by mode "uncommitted"         *)
(*   "mergebase" merge-base with the chosen ref, set by mode "all"          *)
(*   "reftip"    the ref's own tip, set by mode "tip"                       *)
(*   "mark"      the read mark's commit, set by mode "since"                *)
(*   "commit"    some other commit — a patch-set pick, or an A->B base      *)
(***************************************************************************)
Bases == {"auto", "HEAD", "mergebase", "reftip", "mark", "commit"}
Modes == {"all", "uncommitted", "tip", "since", "other"}

VARIABLES
    base,    \* options.base
    label,   \* options.baseLabel is set — "a branch name stands behind this base"
    target,  \* options.target is set — an A->B compare
    scope,   \* state.compareScope is non-empty — a Cmd+9 range
    staged,  \* options.staged
    tip      \* state.compareTip — persisted (COMPARE_TIP_KEY, app-main.ts:322)

vars == <<base, label, target, scope, staged, tip>>

TypeOK ==
    /\ base \in Bases
    /\ label \in BOOLEAN
    /\ target \in BOOLEAN
    /\ scope \in BOOLEAN
    /\ staged \in BOOLEAN
    /\ tip \in BOOLEAN

(***************************************************************************)
(* GROUND TRUTH: which question the diff on screen is answering.           *)
(*                                                                         *)
(* A function of the OPTIONS alone, because the options are the whole of   *)
(* what readUnifiedDiff is given — `compareTip` is never passed to the     *)
(* build. It is a memory of which key was pressed, nothing more.           *)
(*                                                                         *)
(* That asymmetry is the point rather than a cheat. The flag exists        *)
(* (app-main.ts:313-321) precisely BECAUSE the menu cannot tell "all" from *)
(* "tip" by looking at base/baseLabel. So the flag is the claim and this is *)
(* the truth, and the invariant below asks whether the claim is kept up.   *)
(***************************************************************************)
Plain == ~label /\ ~target /\ ~scope /\ ~staged

BuiltMode ==
    IF target \/ scope THEN "other"
    ELSE IF staged THEN "uncommitted"
    ELSE IF base = "HEAD" /\ ~label THEN "uncommitted"
    ELSE IF base = "mergebase" /\ label THEN "all"
    ELSE IF base = "reftip" /\ label THEN "tip"
    ELSE IF base = "mark" /\ ~label THEN "since"
    \* No explicit base: the build resolves one itself. Clean tree with commits ahead gives the
    \* merge-base, which IS "all changes"; anything else falls through to HEAD-vs-worktree.
    ELSE IF base = "auto" /\ ~label THEN (IF AutoResolves THEN "all" ELSE "uncommitted")
    ELSE "other"

(***************************************************************************)
(* THE CLAIM: src/app-review-ipc.ts, the `mode` derivation in              *)
(* kakapo:compare-menu. Transcribed, not paraphrased.                      *)
(***************************************************************************)
ExplicitBase == base # "auto" /\ ~label /\ base # "HEAD"

SinceReadMark == MarkUsable /\ ~scope /\ ~target /\ ~label /\ base = "mark"

\* `!state.options.base && !state.reviewBase` — no explicit base AND the build resolved none either.
NoBaseAtAll == base = "auto" /\ ~AutoResolves

MenuMode ==
    IF SinceReadMark THEN "since"
    ELSE IF scope \/ target \/ ExplicitBase THEN "other"
    ELSE IF staged \/ base = "HEAD" \/ NoBaseAtAll THEN "uncommitted"
    ELSE IF tip THEN "tip"
    ELSE "all"

(***************************************************************************)
(* THE PROPERTY. One sentence: whatever you do with the compare controls,  *)
(* the row the menu ticks is the diff you are looking at.                  *)
(*                                                                         *)
(* When it fails, the reader opens the one control that exists to say what *)
(* the diff measures against and is told the wrong thing — and goes off to *)
(* read a diff believing it answers a question it does not answer.         *)
(***************************************************************************)
MenuTellsTheTruth == MenuMode = BuiltMode

(***************************************************************************)
(* The initial state: a window that has just opened. app-main.ts starts    *)
(* compareTip FALSE and restoreCompareRef leaves it there; RestoredTip is  *)
(* the counterfactual, kept because it is the finding that removed it.     *)
(***************************************************************************)
Init ==
    /\ base = "auto"
    /\ label = FALSE
    /\ target = FALSE
    /\ scope = FALSE
    /\ staged = FALSE
    /\ tip = RestoredTip

(***************************************************************************)
(* kakapo:set-compare-mode — app-main.ts:550.                              *)
(*                                                                         *)
(* Every branch first clears scope/target/staged and WRITES compareTip     *)
(* (:577-581), then sets base/baseLabel for its mode.                      *)
(***************************************************************************)
SetCompareModeAll ==                                       \* Alt+A, :608-619
    /\ base' = "mergebase"
    /\ label' = TRUE
    /\ target' = FALSE /\ scope' = FALSE /\ staged' = FALSE
    /\ tip' = FALSE

SetCompareModeUncommitted ==                               \* Alt+U, :582-584
    /\ base' = "HEAD"
    /\ label' = FALSE
    /\ target' = FALSE /\ scope' = FALSE /\ staged' = FALSE
    /\ tip' = FALSE

SetCompareModeTip ==                                       \* Alt+T, :592-607
    /\ base' = "reftip"
    /\ label' = TRUE
    /\ target' = FALSE /\ scope' = FALSE /\ staged' = FALSE
    /\ tip' = TRUE

(***************************************************************************)
(* Alt+N, :568-571 and :585-591. The refusal is resolved BEFORE anything is *)
(* touched, so an unusable mark leaves every field exactly as it was — the  *)
(* model says that by having no enabled action at all.                     *)
(***************************************************************************)
SetCompareModeSince ==
    /\ MarkUsable
    /\ base' = "mark"
    /\ label' = FALSE
    /\ target' = FALSE /\ scope' = FALSE /\ staged' = FALSE
    /\ tip' = FALSE

(***************************************************************************)
(* kakapo:set-review-base — app-main.ts:399. The patch-set bar's numbers   *)
(* and its "All" option, and Alt+] / Alt+[.                                *)
(*                                                                         *)
(* It clears baseLabel, staged and — because it REWRITES options.base, and  *)
(* compareTip is a claim about that value — the tip flag, through           *)
(* setCompareTip. It still leaves target and scope alone.                   *)
(***************************************************************************)
SetReviewBaseAuto ==                                       \* the bar's "All" option, :406
    /\ base' = "auto"
    /\ label' = FALSE
    /\ staged' = FALSE
    /\ tip' = FALSE                                        \* setCompareTip: this handler rewrote options.base
    /\ UNCHANGED <<target, scope>>

SetReviewBaseCommit ==                                     \* a numbered patch set, :409
    /\ base' = "commit"
    /\ label' = FALSE
    /\ staged' = FALSE
    /\ tip' = FALSE                                        \* setCompareTip: this handler rewrote options.base
    /\ UNCHANGED <<target, scope>>

(***************************************************************************)
(* kakapo:set-review-target — app-main.ts:423. The bar's right-hand group. *)
(*                                                                         *)
(* Note the asymmetry, which is in the handler: staged is cleared only on  *)
(* the commit branch (:432), not when returning to the working tree.       *)
(***************************************************************************)
SetReviewTargetWorktree ==                                 \* :429
    /\ target' = FALSE
    /\ UNCHANGED <<base, label, scope, staged, tip>>

SetReviewTargetCommit ==                                   \* :431-432
    /\ target' = TRUE
    /\ staged' = FALSE
    /\ UNCHANGED <<base, label, scope, tip>>

(***************************************************************************)
(* kakapo:set-review-compare — app-main.ts:466. Cmd+9 opening a range, and *)
(* the bar's exit button (#patchset-reset sends "auto"/"worktree").        *)
(***************************************************************************)
SetReviewCompareRange ==                                   \* a Cmd+9 A..F range, :474-480
    /\ base' = "commit"
    /\ label' = FALSE
    /\ target' = TRUE
    /\ scope' = TRUE
    /\ staged' = FALSE
    /\ tip' = FALSE

SetReviewCompareExit ==                                    \* the bar's reset button, :477-481
    /\ base' = "auto"
    /\ label' = FALSE
    /\ target' = FALSE
    /\ scope' = FALSE
    /\ staged' = FALSE
    /\ tip' = FALSE

(***************************************************************************)
(* kakapo:open-pull-request — app-main.ts:504. Lands as an A->B compare,   *)
(* and clears tip like every other writer of options.base.                 *)
(***************************************************************************)
OpenPullRequest ==
    /\ base' = "commit"
    /\ label' = FALSE
    /\ target' = TRUE
    /\ scope' = FALSE
    /\ staged' = FALSE
    /\ tip' = FALSE

Next ==
    \/ SetCompareModeAll
    \/ SetCompareModeUncommitted
    \/ SetCompareModeTip
    \/ SetCompareModeSince
    \/ SetReviewBaseAuto
    \/ SetReviewBaseCommit
    \/ SetReviewTargetWorktree
    \/ SetReviewTargetCommit
    \/ SetReviewCompareRange
    \/ SetReviewCompareExit
    \/ OpenPullRequest

Spec == Init /\ [][Next]_vars

=============================================================================
