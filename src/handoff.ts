// Which folder a second `kakapo` launch should open, extracted from the Electron `second-instance` handler
// so it can be tested without a window.
//
// Three kinds of second launch arrive here and they want different things:
//
//   `kakapo` in a folder          — additionalData carries that folder and says it was named explicitly.
//   `kakapo` from an older build  — no additionalData; the folder is only in `--cwd` on the command line.
//   Clicking the app icon again   — nothing names a folder, and the working directory is "/".
//
// The last one must not be treated as "review /". That is the whole reason the gate exists, and for a long
// time it was spelled `isGitRepository`, which answered that question by accident and got the common case
// wrong: a plain source tree is reviewable, so typing `kakapo` in one while a window was open did nothing.
export interface HandoffRequest {
  additionalData?: unknown;
  /**
   * A LAZY, best-effort read of `--cwd` off the forwarded command line, for a second instance old enough
   * to send no additionalData. Lazy and fenced because Chromium does not forward the command line it was
   * given: it parses it, keeps switches and loose arguments in separate lists, and re-serialises them
   * switches-first. Measured on `kakapo --cwd /tmp/x --opened`, the primary is handed
   *
   *   ["…/MacOS/kakapo", "--cwd", "--opened", …chromium's own switches…, "dist/app-main.js", "/tmp/x"]
   *
   * — `--cwd` has become a valueless switch and its path is the last positional. So the option reader,
   * which is right to reject a missing value on OUR OWN argv, throws on this one; and when it was called
   * eagerly to build this request, that throw escaped the second-instance handler and killed the whole
   * handoff for every folder, git or not. additionalData is the real source; this is the fallback, and it
   * is never worth an exception.
   */
  commandLineRoot?: () => string | undefined;
  workingDirectory?: string;
}

export interface HandoffChecks {
  reviewable: (path: string) => boolean;
  gitRepository: (path: string) => boolean;
}

export function handoffRoot(request: HandoffRequest, checks: HandoffChecks): string | undefined {
  const data = request.additionalData as { workspaceRoot?: unknown; explicitRoot?: unknown } | undefined;
  const sent = data && typeof data.workspaceRoot === "string" ? data.workspaceRoot : "";
  let named: { root: string; explicit: boolean } | undefined;
  if (sent) named = { root: sent, explicit: data?.explicitRoot !== false };
  else {
    let fallback: string | undefined;
    try { fallback = request.commandLineRoot?.(); } catch { fallback = undefined; }
    if (fallback) named = { root: fallback, explicit: true };
  }
  const root = named?.root ?? request.workingDirectory;
  if (!root || !checks.reviewable(root)) return undefined;
  // Nothing named this folder on purpose — it is the launcher's working directory, or a CLI launched with
  // no path of its own. Launchpad, Spotlight and the Applications icon all hand over "/", so a folder that
  // reached this line unnamed is only worth opening when it looks like a repository.
  if (!named?.explicit && !checks.gitRepository(root)) return undefined;
  return root;
}
