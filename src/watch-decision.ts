// The pure decision at the heart of the per-second watch tick, split out from app-main's refreshIfChanged so
// it can be unit-tested without an Electron main process — the watch loop is otherwise executed by no test,
// yet it gates the single biggest main-thread cost (the review rebuild). Keep this free of WinState/Electron:
// the orchestrator supplies the two signatures and performs the I/O (diff hash, rebuild, IPC send).

export type WatchTickDecision =
  | { action: "skip" } //                unchanged diff — the common case; no rebuild
  | { action: "rebuild"; diffSig: string }; // the diff changed — rebuild and adopt the new baseline

/**
 * Decide what a watch tick should do from the baseline the last build adopted and the signature seen now.
 *
 * There is no "seed" answer any more, and the absence is the point. A third branch used to say: with no
 * baseline, record what the tree says now and return WITHOUT rebuilding. Every rebuild trigger cleared the
 * baseline to reach it, so a write that landed between a build's own read of the tree and the next tick was
 * folded into the baseline and never drawn — and since every later tick then compared equal, the review
 * stayed one write out of date indefinitely. The baseline is now handed over by the build that rendered the
 * review (DiffReviewBuild.watchSignature), so a missing one is not a normal state. If one ever is missing,
 * rebuilding is the safe answer: a redundant rebuild costs a reader nothing they can see, and a skipped one
 * costs them the change they opened the app to read.
 *
 * @param lastDiffSig the baseline the last applied build read ("" only before any build has been applied)
 * @param diffSig     this tick's diff signature
 */
export function decideWatchTick(lastDiffSig: string, diffSig: string): WatchTickDecision {
  if (!lastDiffSig) return { action: "rebuild", diffSig };
  if (diffSig === lastDiffSig) return { action: "skip" };
  return { action: "rebuild", diffSig };
}

/** After a rebuild, the renderer only needs the update pushed when the review signature actually changed. */
export function shouldPushUpdate(lastSignature: string, nextSignature: string): boolean {
  return nextSignature !== lastSignature;
}
