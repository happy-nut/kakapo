export type AgentKind = "claude" | "codex";

export function resumeCommandForInput(input: string): string | undefined {
  const command = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  if (/^claude(?:\s|$)/.test(command)) return "claude --continue";
  if (/^codex(?:\s|$)/.test(command)) return "codex resume --last";
  return undefined;
}

// How kakapo starts each agent when a new workspace asks for one. Both flags turn off the per-action
// confirmation prompt: an agent launched into a fresh worktree is being handed that worktree deliberately,
// and stopping on every command is the thing the worktree existed to make unnecessary. Codex's also drops
// its own sandbox, which is what its equivalent flag is called.
// Named here, beside agentForCommand, so the command that STARTS an agent and the parse that RECOGNISES one
// cannot drift: the first word of each of these has to stay something agentForCommand answers to, or the
// workspace would run an agent whose tile could never badge it.
export const AGENT_LAUNCH: Record<AgentKind, string> = {
  claude: "claude --dangerously-skip-permissions",
  codex: "codex --dangerously-bypass-approvals-and-sandbox",
};

// Which agent a command belongs to, for the rail's tile badge. Takes anything shaped like a command line: a
// recorded resume command ("codex resume --last"), or a live foreground process name from a pty or a tmux
// pane, where a login shell surfaces as "-zsh". Kept here so the agents we recognize are named in one file.
export function agentForCommand(command: string | undefined): AgentKind | undefined {
  const name = (command ?? "").trim().replace(/^-/, "").split(/\s+/)[0];
  return name === "claude" || name === "codex" ? name : undefined;
}
