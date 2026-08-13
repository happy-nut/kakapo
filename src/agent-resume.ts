export type AgentKind = "claude" | "codex";

export function resumeCommandForInput(input: string): string | undefined {
  const command = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  if (/^claude(?:\s|$)/.test(command)) return "claude --continue";
  if (/^codex(?:\s|$)/.test(command)) return "codex resume --last";
  return undefined;
}

// Which agent a command belongs to, for the rail's tile badge. Takes anything shaped like a command line: a
// recorded resume command ("codex resume --last"), or a live foreground process name from a pty or a tmux
// pane, where a login shell surfaces as "-zsh". Kept here so the agents we recognize are named in one file.
export function agentForCommand(command: string | undefined): AgentKind | undefined {
  const name = (command ?? "").trim().replace(/^-/, "").split(/\s+/)[0];
  return name === "claude" || name === "codex" ? name : undefined;
}
