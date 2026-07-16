import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RelaunchTarget = {
  relaunch(options?: { args?: string[] }): void;
  exit(exitCode?: number): void;
};

type SpawnFn = typeof spawn;
type SpawnSyncFn = typeof spawnSync;
type ExistsFn = typeof existsSync;

type RelaunchDeps = {
  spawn?: SpawnFn;
  spawnSync?: SpawnSyncFn;
  existsSync?: ExistsFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type SelfUpdateInstallAttempt = {
  label: string;
  command: string;
  args: string[];
  shell: boolean;
};

const UPDATE_PACKAGE = "@happy-nut/kakapo@latest";
const UPDATE_NPM_ARGS = ["install", "-g", UPDATE_PACKAGE];
const UPDATE_NPM_COMMAND = "npm install -g " + UPDATE_PACKAGE;

export function selfUpdateInstallAttempts(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SelfUpdateInstallAttempt[] {
  const attempts: SelfUpdateInstallAttempt[] = [
    { label: "npm", command: "npm", args: UPDATE_NPM_ARGS, shell: true },
  ];
  if (platform === "darwin") {
    const shells = new Set<string>();
    if (env.SHELL && env.SHELL.startsWith("/")) shells.add(env.SHELL);
    shells.add("/bin/zsh");
    for (const shellPath of shells) {
      attempts.push({ label: shellPath + " login shell", command: shellPath, args: ["-lc", UPDATE_NPM_COMMAND], shell: false });
    }
  }
  return attempts;
}

export function relaunchArgsForCwd(argv: string[], cwd: string): string[] {
  const args = argv.slice(1);
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex >= 0) {
    if (cwdIndex === args.length - 1) args.push(cwd);
    else args[cwdIndex + 1] = cwd;
  } else {
    args.push("--cwd", cwd);
  }
  return args;
}

export function cliArgsForCwd(argv: string[], cwd: string): string[] {
  const args = ["--cwd", cwd];
  if (argv.includes("--no-watch")) args.push("--no-watch");
  return args;
}

export function globalKakapoBinCandidates(prefix: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [join(prefix, "kakapo.cmd"), join(prefix, "kakapo")];
  }
  return [join(prefix, "bin", "kakapo"), join(prefix, "kakapo")];
}

export function resolveGlobalKakapoBin(deps: RelaunchDeps = {}): string | null {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const existsImpl = deps.existsSync ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const result = spawnSyncImpl("npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: true,
    env: deps.env ?? process.env,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const prefix = result.stdout.trim().split(/\r?\n/).pop()?.trim();
  if (!prefix) return null;
  return globalKakapoBinCandidates(prefix, platform).find((candidate) => existsImpl(candidate)) ?? null;
}

function spawnDetached(spawnImpl: SpawnFn, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, shell: boolean): ChildProcess {
  const child = spawnImpl(command, args, { cwd, detached: true, stdio: "ignore", env, shell });
  child.unref();
  return child;
}

export function relaunchUpdatedApp(app: RelaunchTarget, argv: string[], cwd: string, deps: RelaunchDeps = {}): void {
  const spawnImpl = deps.spawn ?? spawn;
  const env = deps.env ?? process.env;
  const cliArgs = cliArgsForCwd(argv, cwd);

  const kakapoBin = resolveGlobalKakapoBin(deps);
  if (kakapoBin) {
    try {
      spawnDetached(spawnImpl, kakapoBin, cliArgs, cwd, env, false);
      app.exit(0);
      return;
    } catch {
      // Fall through to npm exec; the bin path can exist but still fail to spawn if a manager rewrites it.
    }
  }

  try {
    spawnDetached(spawnImpl, "npm", ["exec", "-g", "--", "kakapo", ...cliArgs], cwd, env, true);
    app.exit(0);
    return;
  } catch {
    // Last resort only. app.relaunch() uses the current executable path; after a rebrand update that path
    // may be the stale Electron.app/Contents/MacOS/Electron, so prefer the freshly installed CLI above.
  }

  app.relaunch({ args: relaunchArgsForCwd(argv, cwd) });
  app.exit(0);
}
