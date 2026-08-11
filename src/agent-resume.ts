export type AgentKind = "claude" | "codex";

export function resumeCommandForInput(input: string): string | undefined {
  const command = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  if (/^claude(?:\s|$)/.test(command)) return "claude --continue";
  if (/^codex(?:\s|$)/.test(command)) return "codex resume --last";
  return undefined;
}

// Which agent a workspace is running, read back off the resume command the terminal recorded for it. The
// rail badges each expanded tile with this, so the two halves of the mapping — the input we recognize, and
// the agent it belongs to — stay in the one file that already knows which agents exist.
export function agentForResumeCommand(command: string | undefined): AgentKind | undefined {
  const name = (command ?? "").trim().split(/\s+/)[0];
  return name === "claude" || name === "codex" ? name : undefined;
}
