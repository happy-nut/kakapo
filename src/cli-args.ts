import { parsePositiveInteger, readOption } from "./util.js";
import type { WhitespaceMode } from "./types.js";
export { parsePositiveInteger, readOption };

export type ParsedReviewArgs = {
  requestedCwd: string | undefined;
  openPath: string | undefined;
  // The launch NAMED a path (`kakapo <path>` / `--cwd`), rather than inheriting whatever cwd it started in.
  // A GUI launch inherits "/", which must reach the welcome screen and not a review of the whole disk.
  openedExplicitly: boolean;
  staged: boolean;
  baseValue: string | undefined;
  includeUntracked: boolean;
  context: number;
  watch: boolean;
  ignoreWhitespace: boolean;
  whitespace: WhitespaceMode;
};

function whitespaceMode(value: string | undefined, legacyIgnore: boolean): WhitespaceMode {
  if (value === "none" || value === "trim" || value === "all") return value;
  return legacyIgnore ? "all" : "none";
}

export function runtimeArgv(argv: string[], packaged: boolean): string[] {
  const ENTRY_SCRIPT_IS_ITS_OWN_ARGUMENT = !packaged;
  return argv.slice(ENTRY_SCRIPT_IS_ITS_OWN_ARGUMENT ? 2 : 1);
}

export function parseReviewArgs(args: string[]): ParsedReviewArgs {
  const staged = args.includes("--staged");
  const baseValue = readOption(args, "--base");
  if (staged && baseValue !== undefined) {
    throw new Error("Use either --staged or --base, not both: --staged compares the index against HEAD.");
  }
  const contextValue = readOption(args, "--context");
  return {
    requestedCwd: readOption(args, "--cwd"),
    openPath: readOption(args, "--open"),
    openedExplicitly: args.includes("--opened"),
    staged,
    baseValue,
    includeUntracked: args.includes("--include-untracked"),
    context: contextValue ? parsePositiveInteger(contextValue, "--context") : 12,
    watch: !args.includes("--no-watch"),
    ignoreWhitespace: args.includes("--ignore-whitespace"),
    whitespace: whitespaceMode(readOption(args, "--whitespace"), args.includes("--ignore-whitespace")),
  };
}

export function compareSelectionFor(
  launchRoot: string,
  windowRoot: string,
  launch: { base?: string; baseLabel?: string; staged: boolean },
): { base: string | undefined; baseLabel: string | undefined; staged: boolean } {
  if (launchRoot === windowRoot) return { base: launch.base, baseLabel: launch.baseLabel, staged: launch.staged };
  return { base: undefined, baseLabel: undefined, staged: false };
}
