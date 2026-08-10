// CORE USER FLOW: closing or parking a workspace must leave nothing behind.
//
// Several language servers are launchers that fork the real engine as a child of their own (the bundled
// Kotlin server spawns a ~1.9 GB JVM). dispose() used to send one SIGTERM to the launcher, so the engine was
// orphaned onto PPID 1 and kept its memory for hours — issue #24 caught one 5 hours older than the app
// session that started it. dispose() now signals the server's whole process group.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, reapEscapedGradleDaemons } from "../dist/lsp.js";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(label);
}

test("dispose kills the server's grandchildren, not just the launcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-lsp-dispose-"));
  const pidFile = join(root, "grandchild.pid");
  const launcher = join(root, "launcher.mjs");
  // Stands in for typescript-language-server/intellij-server: forks the real work as its own child, then
  // sits on stdin speaking no LSP at all (the handshake never has to complete for dispose to matter).
  writeFileSync(launcher, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);

  const client = new LspClient(root, {
    family: "test", name: "test-launcher", command: process.execPath, args: [launcher], source: "project",
  });
  client.workspaceSymbols("x").catch(() => { /* the fake server never answers initialize */ });

  await waitFor(() => existsSync(pidFile), 10_000, "launcher never spawned its child");
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  await waitFor(() => alive(grandchild), 2_000, "grandchild never started");

  client.dispose();
  await waitFor(() => !alive(grandchild), 5_000, "grandchild outlived dispose() — it was orphaned");
});

// A Gradle daemon puts itself in a new session on purpose, so signalling the server's process group cannot
// reach it — issue #24's machine had 15 of them from our bundled JVM, one holding 500 MB. Reaping matches on
// the bundle path, and must stay narrow: a daemon is a restartable cache, a language server is not.
test("escaped Gradle daemons are reaped, other bundled processes are not", { skip: process.platform === "win32" }, async () => {
  const bundle = join(mkdtempSync(join(tmpdir(), "kakapo-reap-")), "kotlin");
  mkdirSync(join(bundle, "jbr", "bin"), { recursive: true });
  const java = join(bundle, "jbr", "bin", "java");
  symlinkSync(process.execPath, java);
  // detached: its own process group, exactly like the daemon that escaped dispose().
  const idle = ["-e", "setInterval(() => {}, 1000)"];
  const daemon = spawn(java, [...idle, "GradleDaemon"], { detached: true, stdio: "ignore" });
  const server = spawn(java, [...idle, "kotlin-lsp"], { detached: true, stdio: "ignore" });
  daemon.unref(); server.unref();
  await waitFor(() => alive(daemon.pid) && alive(server.pid), 5_000, "test processes never started");

  reapEscapedGradleDaemons(bundle);

  await waitFor(() => !alive(daemon.pid), 5_000, "the escaped Gradle daemon survived the reap");
  assert.ok(alive(server.pid), "the reap killed a language server, not just the daemon");
  server.kill("SIGKILL");
});
