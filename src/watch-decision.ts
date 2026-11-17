
export type WatchTickDecision =
  | { action: "skip" }
  | { action: "rebuild"; diffSig: string };

export function decideWatchTick(lastDiffSig: string, diffSig: string): WatchTickDecision {
  if (!lastDiffSig) return { action: "rebuild", diffSig };
  if (diffSig === lastDiffSig) return { action: "skip" };
  return { action: "rebuild", diffSig };
}

export function shouldPushUpdate(lastSignature: string, nextSignature: string): boolean {
  return nextSignature !== lastSignature;
}
