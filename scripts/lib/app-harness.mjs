// Driving the real app over CDP: the plumbing both navigation scripts need.
//
// Extracted when the second one arrived (navigation-matrix.mjs) rather than copied. A second copy of a
// CDP client is a second place for "does this key reach the renderer" to be answered differently, and
// the two scripts ask that about the SAME keys — navigation-smoke.mjs checks that each behaves, and
// navigation-matrix.mjs tabulates them against IntelliJ. Two clients that drift would make the two
// scripts disagree about the app rather than about the question.
//
// The port is overridable because 9333 is a popular debugger port — a Chrome started with
// --remote-debugging-port holds it on this machine, and the failure that produced was "the review page
// never became ready", with the real reason (bind() failed) buried in Electron's stderr. preflightPort
// says it outright.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const PORT = Number(process.env.KAKAPO_SMOKE_PORT) || 9333;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// holds it on this machine, and the failure that produced was "the review page never became ready" with

export function checkoutElectronPids() {
  try {
    return execFileSync("pgrep", ["-f", `${ROOT}/node_modules/electron`], { encoding: "utf8" })
      .split("\n").map((v) => v.trim()).filter(Boolean);
  } catch { return []; }
}

/** Whoever already has the debugger port, if anyone — so the run refuses for a reason it can name. */
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
  /**
   * A real drag, injected below the page like the keys are.
   *
   * Several moves rather than one: a selection is dragged out by the moves, and a single jump to the end
   * is not the gesture a hand makes — the bug this exists for only shows up once the pointer is past the
   * content, which is where the last moves are.
   */
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
  /** A real key, injected below the page. mods: Alt=1 Ctrl=2 Meta=4 Shift=8. */
  async key(key, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    });
    await sleep(140);
  }
  /**
   * A real printable keystroke: keyDown CARRYING text, then keyUp.
   *
   * `key()` above sends rawKeyDown, which fires a keydown and inserts nothing, and `type()` below uses
   * Input.insertText, which inserts without a keydown at all. Neither models a hand: a field that loses
   * focus mid-query, or a keydown handler that consumes the letter, is invisible to both, and that is
   * exactly how "type one character and no further character is accepted" shipped unnoticed.
   */
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
  /**
   * A picture of the window, when KAKAPO_SMOKE_SHOTS names a directory to put them in.
   *
   * Worth keeping rather than deleting as unused: a DOM assertion passes for a mark that draws nothing,
   * and a screenshot is how the empty bookmark gutter was found in the first place.
   */
  async shot(name) {
    const dir = process.env.KAKAPO_SMOKE_SHOTS;
    if (!dir) return;
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const READY = `typeof openFileStructure === 'function' && typeof goToNextSymbol === 'function'
  && typeof openFindUsages === 'function' && typeof openProblemsView === 'function'`;

export async function readyPage(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let list = [];
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* not up */ }
    for (const target of list) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      if (String(target.url).startsWith("devtools://")) continue;
      const page = new Page(target.webSocketDebuggerUrl);
      try {
        await page.open();
        if (await page.evaluate(READY) === true) return page;
      } catch { /* not this one */ }
      page.close();
    }
    await sleep(500);
  }
  return null;
}

/**
 * Start the app on a repository. The caller gets the child too, because taking the app down is not
 * `child.kill()`: the launcher is a node process and the app is its Electron children, which outlive it.
 * Leaving them up makes the NEXT run refuse, since a second launch is handed to the instance already up.
 */
export function launchApp(repo) {
  const child = spawn("node", [join(ROOT, "bin/kakapo.js"), repo, "--foreground"], {
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
  for (const pid of checkoutElectronPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  await sleep(400);
}
