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
// `stale` is a registration that exists but was written by a version of this file that did not set
// ELECTRON_RUN_AS_NODE. It is connected and it answers, so nothing about it looks broken — it just also
// hands the agent's repository to the running window as a workspace every time it starts.
export type McpStatus = { agent: McpAgent; installed: boolean; connected: boolean; stale: boolean };

// `kakapo mcp` is the command an agent spawns. The npm install puts `kakapo` on PATH, but the packaged app
// is a bundle — nothing there is on anyone's PATH — so the registration names node and the bundled entry
// point explicitly. It is a path that keeps working when the app updates in place.
//
// ELECTRON_RUN_AS_NODE is not optional here, and leaving it out was a real bug rather than untidiness. In a
// PACKAGED app, process.execPath is the Electron binary and Electron ignores a script path in argv — it runs
// the bundle's own main (dist/app-main.js) regardless. So the agent's `kakapo mcp` spawn was starting a
// second copy of the REVIEW APP, which parsed the agent's working directory as the folder to review, took
// the single-instance handoff, and had the running window silently adopt that repository as a workspace.
// Resuming an old session in an unrelated repo was enough to make it appear in the rail, unasked. It never
// showed in development, where argv[1] IS the entry point and cli.js really does run.
//
// Measured both ways against the installed app: without the variable, one `initialize` handshake from a
// scratch repo took kakapo-open-workspaces from 6 entries to 7; with it, the same handshake answered
// identically and left it at 6.
export const MCP_SERVER_ENV = { ELECTRON_RUN_AS_NODE: "1" } as const;
export function mcpServerCommand(): { command: string; args: string[]; env: Record<string, string> } {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "cli.js");
  const env = { ...MCP_SERVER_ENV };
  // Only the bundled-entry form runs through Electron; `kakapo` on PATH is a shell script that already ends
  // up in node, and handing it the variable would be noise.
  if (existsSync(entry)) return { command: process.execPath, args: [entry, "mcp"], env };
  return { command: "kakapo", args: ["mcp"], env: {} };
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
    if (!installed) return { agent, installed, connected: false, stale: false };
    try {
      const connected = /(^|\s)kakapo\b/m.test(run(agent, ["mcp", "list"]));
      return { agent, installed, connected, stale: connected && !registrationHasEnv(agent) };
    } catch {
      return { agent, installed, connected: false, stale: false };
    }
  });
}

// Both CLIs print the server's environment in `mcp get`, so the CLI stays the source of truth here too —
// the same reason mcpStatus asks `mcp list` instead of reading a config file whose location has moved before.
// An unreadable answer counts as NOT stale: re-registering on a parse failure would churn the config on
// every launch, and the cost of missing one stale entry is smaller than that.
function registrationHasEnv(agent: McpAgent): boolean {
  if (!Object.keys(mcpServerCommand().env).length) return true;
  try {
    return Object.keys(MCP_SERVER_ENV).every((key) => run(agent, ["mcp", "get", "kakapo"]).includes(key));
  } catch {
    return true;
  }
}

// Rewrite a registration in place. `mcp add` will not overwrite an existing name on either CLI, so the
// removal is what makes this an update rather than a no-op.
export function reconnectMcp(agent: McpAgent): Promise<{ ok: boolean; message: string }> {
  try {
    run(agent, ["mcp", "remove", ...(agent === "claude" ? ["-s", "user"] : []), "kakapo"]);
  } catch { /* not there is the state we want anyway */ }
  return connectMcp(agent);
}

export function connectMcp(agent: McpAgent): Promise<{ ok: boolean; message: string }> {
  const { command, args, env } = mcpServerCommand();
  // Both CLIs take repeated `--env KEY=VALUE` before the `--` that ends the flags.
  const envFlags = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  // User scope, so it is not written into the repository: a block in a committed file would hand kakapo's
  // conventions to everyone who clones, whether they use kakapo or not.
  const add = agent === "claude"
    ? ["mcp", "add", "--scope", "user", "kakapo", ...envFlags, "--", command, ...args]
    : ["mcp", "add", "kakapo", ...envFlags, "--", command, ...args];
  return new Promise((resolve) => {
    execFile(agent, add, { timeout: 20_000 }, (error, stdout, stderr) => {
      const output = String(stderr || stdout || "").trim();
      resolve(error ? { ok: false, message: output || String(error.message) } : { ok: true, message: output });
    });
  });
}
