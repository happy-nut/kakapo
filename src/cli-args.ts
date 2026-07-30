// Pure CLI parsing for the review flags, split out of app-main (which mixed it with window/watch/IPC/hub
// orchestration). The flag semantics — option values, --staged/--base exclusivity, context validation — are
// now unit-testable without git or Electron. The caller resolves the git-dependent bits (repo root, base
// ref validation) from these parsed values; everything here is a pure function of argv.
//
// readOption/parsePositiveInteger already live in util.js (shared with the CLI entrypoint); re-export them
// as the CLI-option helpers rather than keep a second copy.
import { parsePositiveInteger, readOption } from "./util.js";
export { parsePositiveInteger, readOption };

export type ParsedReviewArgs = {
  requestedCwd: string | undefined; // raw --cwd (unresolved); caller resolves + checks it's a git repo
  staged: boolean;
  baseValue: string | undefined; // raw --base ref; caller validates it against the repo
  includeUntracked: boolean;
  context: number;
  watch: boolean;
  ignoreWhitespace: boolean;
};

/** Parse the review flags from argv. Pure: no filesystem/git — the caller resolves root and validates base. */
export function parseReviewArgs(args: string[]): ParsedReviewArgs {
  const staged = args.includes("--staged");
  const baseValue = readOption(args, "--base");
  if (staged && baseValue !== undefined) {
    throw new Error("Use either --staged or --base, not both: --staged compares the index against HEAD.");
  }
  const contextValue = readOption(args, "--context");
  return {
    requestedCwd: readOption(args, "--cwd"),
    staged,
    baseValue,
    includeUntracked: args.includes("--include-untracked"),
    context: contextValue ? parsePositiveInteger(contextValue, "--context") : 12,
    watch: !args.includes("--no-watch"),
    ignoreWhitespace: args.includes("--ignore-whitespace"),
  };
}
