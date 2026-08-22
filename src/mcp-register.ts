// Registering kakapo's vocabulary server with the agent CLIs on this machine.
//
// This runs once per machine, not once per repository: the server works out which repository it is being
// asked about from the directory the agent is running in (repoRootFrom), so one user-scoped registration
// covers every workspace, every worktree and every session — including the ones the reviewer starts in
// their own shell, which is exactly what a launch flag could never reach.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type McpAgent = "claude" | "codex";
export type McpStatus = { agent: McpAgent; installed: boolean; connected: boolean };

// `kakapo mcp` is the command an agent spawns. The npm install puts `kakapo` on PATH, but the packaged app
// is a bundle — nothing there is on anyone's PATH — so the registration names node and the bundled entry
// point explicitly. It is a path that keeps working when the app updates in place.
export function mcpServerCommand(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "cli.js");
  if (existsSync(entry)) return { command: process.execPath, args: [entry, "mcp"] };
  return { command: "kakapo", args: ["mcp"] };
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
}

function has(command: string): boolean {
  try {
    run("which", [command]);
    return true;
  } catch {
    return false;
  }
}

// Asking the CLI itself rather than parsing its config file: where that file lives is the CLI's business and
// has moved before, and `mcp list` is the one answer that cannot be out of date.
export function mcpStatus(): McpStatus[] {
  return (["claude", "codex"] as McpAgent[]).map((agent) => {
    const installed = has(agent);
    if (!installed) return { agent, installed, connected: false };
    try {
      return { agent, installed, connected: /(^|\s)kakapo\b/m.test(run(agent, ["mcp", "list"])) };
    } catch {
      return { agent, installed, connected: false };
    }
  });
}

export function connectMcp(agent: McpAgent): Promise<{ ok: boolean; message: string }> {
  const { command, args } = mcpServerCommand();
  // User scope, so it is not written into the repository: a block in a committed file would hand kakapo's
  // conventions to everyone who clones, whether they use kakapo or not.
  const add = agent === "claude"
    ? ["mcp", "add", "--scope", "user", "kakapo", "--", command, ...args]
    : ["mcp", "add", "kakapo", "--", command, ...args];
  return new Promise((resolve) => {
    execFile(agent, add, { timeout: 20_000 }, (error, stdout, stderr) => {
      const output = String(stderr || stdout || "").trim();
      resolve(error ? { ok: false, message: output || String(error.message) } : { ok: true, message: output });
    });
  });
}
