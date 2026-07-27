export function resumeCommandForInput(input: string): string | undefined {
  const command = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  if (/^claude(?:\s|$)/.test(command)) return "claude --continue";
  if (/^codex(?:\s|$)/.test(command)) return "codex resume --last";
  return undefined;
}
