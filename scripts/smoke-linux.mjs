#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxBundleName, normalizeLinuxArch } from "./package-linux.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export async function waitForKakapoRenderer({
  port,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  processState = () => ({}),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    const state = processState();
    if (state.error) throw state.error;
    if (state.exited) {
      throw new Error(`Kakapo exited before its Linux renderer was ready (${state.code ?? state.signal ?? "unknown"}).`);
    }
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = Array.isArray(pages)
          ? pages.find((candidate) => (
            candidate?.type === "page"
            && String(candidate?.title || "").startsWith("Kakapo")
            && String(candidate?.url || "").startsWith("file:")
          ))
          : undefined;
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Kakapo Linux renderer was not ready within ${timeoutMs}ms.${detail}`);
}

async function stopProcessGroup(child) {
  const childExited = child.exitCode !== null || child.signalCode !== null;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch {} }

  if (!childExited) {
    await Promise.race([
      new Promise((resolveStop) => child.once("exit", resolveStop)),
      delay(2_000),
    ]);
  } else {
    // xvfb-run may exit before its Electron descendant. Give the process group a brief TERM window.
    await delay(100);
  }

  try { process.kill(-child.pid, 0); process.kill(-child.pid, "SIGKILL"); }
  catch {}

  // A surviving descendant can otherwise keep these inherited pipes open for several minutes after the
  // renderer check has already passed, making a successful CI smoke step look hung.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Launch the packaged app in Xvfb and require a real Chromium renderer page. */
export async function smokeLinux({
  platform = process.platform,
  arch = process.arch,
  repoRoot = defaultRepoRoot,
  executablePath,
  timeoutMs = 20_000,
} = {}) {
  if (platform !== "linux") {
    throw new Error("Kakapo Linux GUI smoke testing requires Linux and xvfb-run.");
  }

  const targetArch = normalizeLinuxArch(arch);
  const executable = resolve(executablePath || join(repoRoot, "release", linuxBundleName(targetArch), "Kakapo"));
  if (!existsSync(executable)) throw new Error(`Packaged Kakapo executable not found: ${executable}`);

  const port = await availablePort();
  const output = [];
  const append = (chunk) => {
    output.push(String(chunk));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  const child = spawn("xvfb-run", [
    "-a",
    executable,
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--cwd", repoRoot,
  ], {
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, KAKAPO_LINUX_SMOKE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = { error: undefined, exited: false, code: undefined, signal: undefined };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => { state.error = error; });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });

  try {
    const page = await waitForKakapoRenderer({ port, timeoutMs, processState: () => state });
    process.stdout.write(`Linux renderer ready: ${page.title} (${targetArch})\n`);
    return page;
  } catch (error) {
    const logs = output.join("").trim();
    if (logs) process.stderr.write(`${logs}\n`);
    throw error;
  } finally {
    await stopProcessGroup(child);
  }
}

if (resolve(process.argv[1] || "") === scriptPath) {
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  smokeLinux({ executablePath }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
