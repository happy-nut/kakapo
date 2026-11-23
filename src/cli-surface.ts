export type CliCommand = { name: string; help: string[] };

export type CliOption = {
  flag: string;
  alias?: string;
  value?: string;
  help: string[];
  forward: "boolean" | "value" | "handled";
};

export const CLI_COMMANDS: CliCommand[] = [
  {
    name: "install-app",
    help: [
      "add a Kakapo icon to Applications (Spotlight, Launchpad, Dock).",
      "npm installs a CLI only; this is the opt-in that gives it an icon.",
    ],
  },
  { name: "uninstall-app", help: ["remove that icon again"] },
];

export const CLI_OPTIONS: CliOption[] = [
  { flag: "--version", alias: "-v", help: ["print the version and exit"], forward: "handled" },
  { flag: "--cwd", value: "<path>", help: ["same as the bare <path> form, for a folder"], forward: "handled" },
  {
    flag: "--base",
    value: "<rev>",
    help: [
      "compare the working tree against a branch, tag or commit",
      "default: the upstream merge-base when the branch has unpushed",
      "commits, otherwise HEAD. Changeable in the app — see Alt+A/U/C.",
    ],
    forward: "value",
  },
  { flag: "--staged", help: ["compare the index against HEAD instead (not with --base)"], forward: "boolean" },
  { flag: "--ignore-whitespace", help: ["hide changes that are only whitespace (= --whitespace=all)"], forward: "boolean" },
  {
    flag: "--whitespace",
    value: "<mode>",
    help: [
      "how much whitespace difference counts as a difference:",
      "none (default) | trim (ignore how much) | all (ignore it).",
      "Changeable in the app — Diff menu, or Cmd/Ctrl+Shift+W.",
    ],
    forward: "value",
  },
  {
    flag: "--context",
    value: "<n>",
    help: ["unchanged lines kept around each hunk; default: 12.", "Changeable in the app — Diff menu."],
    forward: "value",
  },
  { flag: "--pull-request", value: "<link>", help: ["same as the bare <pr link> form"], forward: "handled" },
  { flag: "--no-watch", help: ["stop refreshing the review when the working tree changes"], forward: "boolean" },
  { flag: "--help", alias: "-h", help: ["this text"], forward: "handled" },
];

// Tokens the CLI accepts but does not advertise. An option the help text lists must be one a user can
// change something with; these cannot, so listing them would promise an effect that is not there.
export const CLI_INTERNAL_ARGS: Array<{ flag: string; reason: string }> = [
  {
    flag: "--include-untracked",
    reason: "always forwarded — untracked files always count as additions, so there is nothing to opt into",
  },
  { flag: "--opened", reason: "always forwarded; tells the app the launch named a root rather than defaulting to cwd" },
  { flag: "--open", reason: "forwarded only when the positional path is a file; set from that path, never typed" },
  { flag: "--foreground", reason: "test and debug harnesses only — keeps the app attached to this terminal" },
];

export function cliValueOptions(): Set<string> {
  return new Set(CLI_OPTIONS.filter((option) => option.value).map((option) => option.flag));
}

// The geometry the hand-written help text used: two spaces of indent, the flag padded into an 18-column
// field, and at least two spaces before the description however long the flag is.
function helpBlock(label: string, rows: Array<{ head: string; help: string[] }>): string {
  const indent = "  ";
  const column = 18;
  return `${label}:\n` + rows.map((row) => {
    const gap = Math.max(2, column - row.head.length);
    return row.help
      .map((line, index) => (index === 0
        ? `${indent}${row.head}${" ".repeat(gap)}${line}`
        : `${indent}${" ".repeat(column)}${line}`))
      .join("\n");
  }).join("\n");
}

export function commandsHelp(): string {
  return helpBlock("Commands", CLI_COMMANDS.map((command) => ({ head: command.name, help: command.help })));
}

export function optionsHelp(): string {
  return helpBlock("Options", CLI_OPTIONS.map((option) => ({
    head: [option.alias ? `${option.flag}, ${option.alias}` : option.flag, option.value].filter(Boolean).join(" "),
    help: option.help,
  })));
}
