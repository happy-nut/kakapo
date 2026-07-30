// Cubic-bezier easing for the workspace-rail width animation, split out of app-main so it's a pure,
// unit-testable function instead of a helper buried in the Electron orchestrator. app-main keeps the timer
// loop (animateHubWidth) that drives layout; this owns only the math.

/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` easing as a pure `progress -> eased` function. Solves x(t)=p with a
 * few Newton iterations, then returns y(t) — the same technique browsers use for the matching CSS transition.
 */
export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return (p) => {
    let t = p;
    for (let i = 0; i < 6; i++) {
      const x = ((ax * t + bx) * t + cx) * t - p;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= x / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

// cubic-bezier(.2,.8,.2,1) — the exact easing the review sidebar's grid-template-columns transition uses, so
// the rail push and the file-tree collapse stay in lockstep for one continuous motion.
export const easeRail = cubicBezierEase(0.2, 0.8, 0.2, 1);
