// The pure decision at the heart of the per-second watch tick, split out from app-main's refreshIfChanged so
// it can be unit-tested without an Electron main process — the watch loop is otherwise executed by no test,
// yet it gates the single biggest main-thread cost (the review rebuild). Keep this free of WinState/Electron:
// the orchestrator supplies the two signatures and performs the I/O (diff hash, rebuild, IPC send).

export type WatchTickDecision =
  | { action: "seed"; diffSig: string } // first tick: record the baseline the initial build already produced
  | { action: "skip" } //                unchanged diff — the common case; no rebuild
  | { action: "rebuild"; diffSig: string }; // the diff changed — rebuild and adopt the new baseline

/**
 * Decide what a watch tick should do from the diff signature seen last tick and the one seen now.
 * @param lastDiffSig the previous tick's diff signature ("" before the first tick has run)
 * @param diffSig     this tick's diff signature
 */
export function decideWatchTick(lastDiffSig: string, diffSig: string): WatchTickDecision {
  if (!lastDiffSig) return { action: "seed", diffSig };
  if (diffSig === lastDiffSig) return { action: "skip" };
  return { action: "rebuild", diffSig };
}

/** After a rebuild, the renderer only needs the update pushed when the review signature actually changed. */
export function shouldPushUpdate(lastSignature: string, nextSignature: string): boolean {
  return nextSignature !== lastSignature;
}
