import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const PORT = Number(process.env.KAKAPO_SMOKE_PORT) || 9333;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function checkoutElectronPids() {
  try {
    return execFileSync("pgrep", ["-f", `${ROOT}/node_modules/electron`], { encoding: "utf8" })
      .split("\n").map((v) => v.trim()).filter(Boolean);
  } catch { return []; }
}

export function portHolder(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n").slice(1).filter(Boolean).map((line) => line.split(/\s+/).slice(0, 2).join(" ")).join(", ");
  } catch { return ""; }
}

export function preflightPort(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export class Page {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    });
    await Promise.race([
      new Promise((resolve) => this.ws.addEventListener("open", resolve)),
      sleep(10000).then(() => { throw new Error("the debugger socket never opened"); }),
    ]);
    await this.send("Runtime.enable", {});
    await this.send("Page.enable", {});
  }
  send(method, params) {
    const n = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(n, { resolve, reject });
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result.result?.value;
  }
  async drag(fromX, fromY, toX, toY, steps = 6) {
    const common = { button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, buttons: 1, ...common });
    for (let step = 1; step <= steps; step += 1) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: fromX + ((toX - fromX) * step) / steps,
        y: fromY + ((toY - fromY) * step) / steps,
        buttons: 1,
        button: 'left',
      });
      await sleep(20);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, buttons: 0, ...common });
    await sleep(120);
  }
  async key(key, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    });
    await sleep(140);
  }
  async char(ch, code, vk) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: ch, text: ch, unmodifiedText: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(70);
  }
  async type(text) {
    await this.send("Input.insertText", { text });
    await this.evaluate(`(() => { const el = document.getElementById('quick-open-input'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(200);
  }
  async shot(name) {
    const dir = process.env.KAKAPO_SMOKE_SHOTS;
    if (!dir) return;
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  close() { try { this.ws.close(); } catch { } }
}

const READY = `typeof openFileStructure === 'function' && typeof goToNextSymbol === 'function'
  && typeof openFindUsages === 'function' && typeof openProblemsView === 'function'`;

export async function readyPage(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let list = [];
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { }
    for (const target of list) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      if (String(target.url).startsWith("devtools://")) continue;
      const page = new Page(target.webSocketDebuggerUrl);
      try {
        await page.open();
        if (await page.evaluate(READY) === true) return page;
      } catch { }
      page.close();
    }
    await sleep(500);
  }
  return null;
}

export function launchApp(repo, extraArgs = []) {
  const child = spawn("node", [join(ROOT, "bin/kakapo.js"), repo, "--foreground", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, KAKAPO_REMOTE_DEBUG: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return { child, log: () => log };
}

export async function stopApp(child) {
  child.kill("SIGTERM");
  await sleep(600);
  child.kill("SIGKILL");
  for (const pid of checkoutElectronPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { } }
  await sleep(400);
}
