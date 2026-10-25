// Drives the REAL app over the Chrome DevTools Protocol for the three surfaces the jsdom suite can only
// approximate: running a request from a .http file, the Git history's kinds and filters, and the diff's
// overview stripe.
//
// Why these three, and why here rather than in the suite:
//   .http   jsdom stubs the main-process bridge, so "the request went out and came back" is a stub
//           answering itself. Here a real server is listening and the app really sends to it.
//   history the filters are applied by git in the main process; the suite stubs that bridge too.
//   stripe  it is painted geometry. jsdom has no layout, so a mark that draws nothing passes every DOM
//           assertion — which is exactly how a bookmark mark shipped invisible once already.
//
// `npm run review:smoke`. Refuses while a Kakapo from this checkout is open: a second launch is handed to
// that instance, and this would drive the wrong window. KAKAPO_SMOKE_SHOTS=<dir> keeps screenshots.
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkoutElectronPids() {
  try {
    return execFileSync("pgrep", ["-f", `${ROOT}/node_modules/electron`], { encoding: "utf8" })
      .split("\n").map((v) => v.trim()).filter(Boolean);
  } catch { return []; }
}

/** The server the .http file in the fixture actually talks to. */
function apiServer() {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    if (request.url === "/items") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [{ id: 7, name: "kakapo" }] }));
      return;
    }
    if (request.url === "/echo") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ seen: Buffer.concat(chunks).toString("utf8") }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { server, hits };
}

function fixtureRepo(apiPort) {
  const repo = mkdtempSync(join(tmpdir(), "kakapo-review-smoke-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git(["init", "-qb", "main"]);
  git(["config", "user.email", "smoke@kakapo.test"]);
  git(["config", "user.name", "Ada Lovelace"]);
  git(["config", "commit.gpgsign", "false"]);

  put("http-client.env.json", JSON.stringify({ local: { host: `http://127.0.0.1:${apiPort}` } }, null, 2));
  put("api.http", [
    "### list items",
    "GET {{host}}/items",
    "Accept: application/json",
    "",
    "> {%",
    '  client.test("the list came back", function () { client.assert(response.body.items.length === 1, "no items"); });',
    '  client.global.set("firstId", response.body.items[0].id);',
    "%}",
    "",
    "### echo it back",
    "POST {{host}}/echo",
    "Content-Type: application/json",
    "",
    '{ "id": {{firstId}} }',
    "",
  ].join("\n"));
  // Two files whose change is whitespace only / real, so the stripe has marks to draw.
  put("src/wide.ts", ["export const a = 1;", "const keep = 1;", "export const b = 1;", ""].join("\n"));
  git(["add", "-A"]);
  git(["commit", "-qm", "first: the api and a module"]);

  put("src/wide.ts", ["export const a = 99;", "const keep = 1;", "export const b = 99;", ""].join("\n"));
  git(["add", "-A"]);
  git(["commit", "-qm", "second: change both constants", "--author=Grace Hopper <grace@kakapo.test>"]);
  // An uncommitted change, so the app opens on a review rather than nothing.
  put("src/wide.ts", ["export const a = 99;", "const keep = 1;", "export const b = 42;", ""].join("\n"));
  return repo;
}

class Page {
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
  async key(key, code, vk, modifiers = 0) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    }
    await sleep(140);
  }
  async shot(name) {
    const dir = process.env.KAKAPO_SMOKE_SHOTS;
    if (!dir) return;
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const READY = `typeof runHttpRequest === 'function' && typeof renderDiffStripe === 'function' && typeof openHistory === 'function'`;

async function readyPage(timeoutMs) {
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

async function run() {
  const already = checkoutElectronPids();
  if (already.length) {
    process.stdout.write(`a Kakapo from this checkout is already running (pid ${already.join(", ")}); quit it first.\n`);
    return 2;
  }
  const api = apiServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const apiPort = api.server.address().port;
  const repo = fixtureRepo(apiPort);
  const child = spawn("node", [join(ROOT, "bin/kakapo.js"), repo, "--foreground"], {
    cwd: ROOT,
    env: { ...process.env, KAKAPO_REMOTE_DEBUG: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  let page = null;
  try {
    page = await readyPage(60000);
    if (!page) {
      process.stdout.write(`the review page never became ready.\n${log.slice(-1500)}\n`);
      return 1;
    }

    // ---- .http: a request that really goes out ----------------------------------------------------
    await page.evaluate(`(() => { openSourceFile('api.http'); return true; })()`);
    await sleep(900);
    const envPicked = await page.evaluate(`(() => {
      const select = document.getElementById('http-env-select');
      return { options: Array.from(select.options).map((o) => o.value), value: select.value };
    })()`);
    check("the .http environment from http-client.env.json is offered", envPicked.options.includes("local"), JSON.stringify(envPicked));

    await page.evaluate(`(() => { setSourceCursor('api.http', 1, 0, true, -1); return true; })()`);
    await page.key("Enter", "Enter", 13, 4); // ⌘Enter — run the request at the caret
    await sleep(1800);
    // Read the PARTS of the panel, not a slice of its text: a status line, a body and a test list are
    // three different claims, and "the string 1 appears somewhere" is satisfied by "11 ms".
    const first = await page.evaluate(`(() => {
      const panel = document.getElementById('http-resp-0');
      if (!panel) return { missing: true };
      return {
        status: panel.querySelector('.http-status')?.textContent ?? '',
        body: panel.querySelector('.http-resp-body')?.textContent ?? '',
        tests: panel.querySelector('.http-tests-head')?.textContent ?? '',
        failed: Boolean(panel.querySelector('.http-test.bad')),
      };
    })()`);
    check("⌘Enter sends it and the response lands under the request",
      /^200/.test(first.status) && /kakapo/.test(first.body), `${first.status} | ${first.body.replace(/\s+/g, " ").slice(0, 60)}`);
    check("the response handler's test result is shown",
      /1/.test(first.tests) && first.failed === false, `${first.tests} (a failure shown: ${first.failed})`);
    await page.shot("http-response");

    // The second request reads {{firstId}}, which only exists because the first one's handler set it.
    await page.evaluate(`(() => { runHttpRequest(1, 'api.http'); return true; })()`);
    await sleep(1800);
    const chained = await page.evaluate(`(() => {
      const panel = document.getElementById('http-resp-1');
      return {
        status: panel?.querySelector('.http-status')?.textContent ?? '',
        body: panel?.querySelector('.http-resp-body')?.textContent ?? '',
      };
    })()`);
    // The echo server returns what it was sent, so `7` in the body is the id the FIRST request's handler
    // stored — the whole point of the chain.
    check("a handler's client.global reaches the next request",
      /^201/.test(chained.status) && /7/.test(chained.body),
      `${chained.status} | ${chained.body.replace(/\s+/g, " ").slice(0, 60)}`);
    check("the server saw both requests", api.hits.length >= 2, api.hits.join(" | "));

    // ---- the diff's overview stripe ---------------------------------------------------------------
    await page.evaluate(`(() => { showDiffView(); showOnlyFile('src/wide.ts'); return true; })()`);
    await sleep(700);
    const stripe = await page.evaluate(`(() => {
      renderDiffStripe();
      const el = document.getElementById('diff-stripe');
      if (!el) return { present: false };
      const marks = Array.from(el.querySelectorAll('.diff-stripe-mark')).map((mark) => ({
        kind: mark.className, top: mark.style.top, height: mark.style.height,
        painted: getComputedStyle(mark).backgroundColor, box: mark.getBoundingClientRect().height,
      }));
      const box = el.getBoundingClientRect();
      return { present: !el.classList.contains('hidden'), width: box.width, height: box.height, marks };
    })()`);
    check("the stripe is drawn beside the diff", stripe.present === true && stripe.width > 0 && stripe.height > 0,
      `${stripe.width}x${stripe.height}`);
    check("its marks have a real size and a visible colour",
      stripe.marks.length > 0 && stripe.marks.every((mark) => mark.box > 0 && !/rgba\(0, 0, 0, 0\)/.test(mark.painted)),
      JSON.stringify(stripe.marks.slice(0, 3)));
    await page.shot("diff-stripe");

    // ---- the Git history: kinds and git-side filters -----------------------------------------------
    await page.key("9", "Digit9", 57, 4); // ⌘9
    await sleep(1200);
    const log = await page.evaluate(`(() => ({
      open: !document.getElementById('history-view').classList.contains('hidden'),
      rows: document.querySelectorAll('#history-list .hrow').length,
      subjects: Array.from(document.querySelectorAll('#history-list .hsubject')).map((el) => el.textContent),
    }))()`);
    check("⌘9 opens the history with the repository's commits", log.open === true && log.rows >= 2, JSON.stringify(log.subjects));

    await page.evaluate(`(() => { document.getElementById('history-filter-toggle').click(); return true; })()`);
    await page.evaluate(`(() => {
      const field = document.getElementById('history-filter-author');
      field.value = 'Grace';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    const filtered = await page.evaluate(`Array.from(document.querySelectorAll('#history-list .hsubject')).map((el) => el.textContent)`);
    check("the author filter is applied by git, not by hiding rows",
      filtered.length === 1 && /second/.test(filtered[0]), JSON.stringify(filtered));

    await page.evaluate(`(() => { document.getElementById('history-filter-clear').click(); return true; })()`);
    await sleep(600);
    await page.evaluate(`(() => { document.querySelector('.history-kind[data-history-kind="reflog"]').click(); return true; })()`);
    await sleep(900);
    const reflog = await page.evaluate(`(() => ({
      selectors: Array.from(document.querySelectorAll('#history-list .hselector')).map((el) => el.textContent).slice(0, 3),
      rows: document.querySelectorAll('#history-list .hrow').length,
    }))()`);
    check("the reflog kind lists real entries, named by selector",
      reflog.rows > 0 && reflog.selectors.every((selector) => /^HEAD@\{\d+\}$/.test(selector)), JSON.stringify(reflog));
    await page.shot("history-reflog");
  } finally {
    page?.close();
    child.kill("SIGTERM");
    await sleep(600);
    child.kill("SIGKILL");
    for (const pid of checkoutElectronPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    await sleep(400);
    api.server.close();
    rmSync(repo, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed in the real app\n`);
  return failed ? 1 : 0;
}

process.exit(await run());
