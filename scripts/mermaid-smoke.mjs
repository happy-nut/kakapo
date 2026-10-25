#!/usr/bin/env node
// Does a Mermaid diagram actually render? Nothing else can answer this.
//
// test/mermaid.test.mjs covers everything about Mermaid that works without layout: the copied asset
// registers `window.mermaid`, the library accepts the exact config 20-mermaid.js passes, it parses the
// fences an agent writes and rejects a malformed one, and a `#kakapo:path:line` node becomes a code jump.
// What it cannot cover is render(). Mermaid measures text through SVGGraphicsElement.getBBox, which jsdom
// does not implement; shimming that cascades into getComputedTextLength and the rest until the test is
// measuring the shims rather than Mermaid, and a green light meaning "my stubs agree with each other" is
// worse than no test. So layout is checked here, in the real app, over the real asset protocol.
//
// This needs a GUI and about twenty seconds, so it is not part of `npm test`. Run it when Mermaid's version
// moves — the 11 -> 12 bump is what showed the gap.
//
// Three things cost real time while this was written, and all three are guarded rather than remembered:
//
//   1. TARGET SELECTION. `/json/list` returns the DevTools window first when one is open. Connecting to
//      index 0 lands in the DevTools UI, where the review page's functions do not exist.
//   2. THE WEBSOCKET OPEN. With no timeout on it, a connection to a target that never answers waits for
//      ever — past every timeout placed on the evaluate that follows it. That was the 17-minute hang.
//   3. THE RACE. A page target appears before its inline client has run, so the review page is listed
//      while `mermaidPlaceholderHtml` is still undefined. Waiting for a page to EXIST therefore fails
//      intermittently and reads exactly like a broken renderer.
//   4. THE HANDOFF. Electron's single-instance lock is per app, not per workspace: launching while a
//      Kakapo from this checkout is running hands the argv over and the launcher exits, so killing the
//      launcher leaves the app behind and the next run attaches to THAT one — reading a page belonging
//      to a workspace this run never created. So the run refuses to start when one is already up, and
//      kills what it started on the way out.
//
// So the page is not chosen by index, url or title: every candidate is asked whether it has the Mermaid
// entry points yet, and the first that says yes is the one. That answers all three at once.
//
// `selftest` runs the verdict function against fabricated results, including the ones a broken render
// produces, so a pass here means the oracle can still fail.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.KAKAPO_SMOKE_PORT ?? 9229);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the verdict
//
// Separated from the plumbing so selftest can drive it. `result` is what the page returns.

/** @returns {{ok: boolean, reasons: string[]}} */
export function verdict(result) {
  const reasons = [];
  const need = (cond, why) => { if (!cond) reasons.push(why); };

  need(result && typeof result === "object", "the page returned nothing to judge");
  if (!result || typeof result !== "object") return { ok: false, reasons };
  need(!result.err, `the page could not run the check: ${result.err}`);
  // The asset protocol: loadMermaid() resolves on window.mermaid and rejects with "mermaid did not
  // register" otherwise, so this is kakapo-asset://app/mermaid.js having been served and run.
  need(result.mermaid === "object", `window.mermaid is ${result.mermaid}, so the asset never registered`);
  need(result.svg === true, "render() produced no <svg>");
  // getBBox is the whole point: it is the real content box Mermaid laid out, and the API jsdom lacks.
  need(result.bbW > 0 && result.bbH > 0, `the SVG has no geometry (getBBox ${result.bbW}x${result.bbH})`);
  need(result.nodes >= 2, `expected both nodes of A-->B, saw ${result.nodes}`);
  // Labels prove TEXT was laid out, not merely that an <svg> element appeared.
  need(
    Array.isArray(result.labels) && result.labels.includes("Alpha") && result.labels.includes("Beta"),
    `node labels did not render: ${JSON.stringify(result.labels)}`,
  );
  // The negative control, run in the same page: a malformed fence must land on the invalid message and
  // produce no SVG. Without it, an implementation that drew something for any input would pass the above.
  need(result.badSvg === false, "a malformed fence still produced an <svg>");
  need(result.badHandled === true, `a malformed fence did not report itself: ${JSON.stringify(result.badText)}`);

  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- the page-side check

const PAGE_CHECK = `(async function () {
  if (typeof mermaidPlaceholderHtml !== 'function' || typeof renderMermaidDiagrams !== 'function') {
    return JSON.stringify({ err: 'the viewer did not expose the Mermaid entry points' });
  }
  async function render(src) {
    var host = document.createElement('div');
    // A width, because Mermaid sizes its root against the container; getBBox below does not need it, but
    // without one the SVG's client rect is 0 and a reader of this code would think layout had failed.
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
    host.innerHTML = mermaidPlaceholderHtml(src);
    document.body.appendChild(host);
    renderMermaidDiagrams(host);
    // Settled means the placeholder's own status span is gone: success replaces the node's children with
    // the SVG, failure replaces them with a message. Both paths clear it, so one condition covers the
    // good fence and the malformed one.
    //
    // NOT dataset.mermaidDone — renderMermaidDiagrams sets that BEFORE awaiting mermaid.render(), so it is
    // a "started" flag. Reading it as "finished" exits on the first tick and reports every diagram as
    // having produced nothing, which is indistinguishable from a broken renderer.
    for (var i = 0; i < 150; i++) {
      if (!host.querySelector('.explain-mermaid-status')) break;
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    return host;
  }

  var good = await render('graph TD\\n  A[Alpha]-->B[Beta]');
  var svg = good.querySelector('svg');
  var bb = null;
  try { bb = svg.getBBox(); } catch (e) { bb = null; }
  var labels = svg ? Array.prototype.map.call(svg.querySelectorAll('.node'), function (n) {
    return (n.textContent || '').trim();
  }) : [];

  var bad = await render('graph TD\\n  A-->');
  var badSvg = !!bad.querySelector('svg');
  var badText = (bad.textContent || '').trim().slice(0, 60);

  var out = {
    mermaid: typeof window.mermaid,
    svg: !!svg,
    bbW: bb ? Math.round(bb.width) : 0,
    bbH: bb ? Math.round(bb.height) : 0,
    nodes: svg ? svg.querySelectorAll('.node').length : 0,
    labels: labels,
    badSvg: badSvg,
    badHandled: !badSvg && badText.length > 0,
    badText: badText
  };
  good.remove();
  bad.remove();
  return JSON.stringify(out);
})()`;

// ---------------------------------------------------------------- plumbing

/**
 * Electron processes belonging to THIS checkout — the app and its helpers, not the user's installed
 * Kakapo and not another Electron app. The launcher is a short-lived `node bin/kakapo.js`, so killing the
 * spawned child is not enough to stop the app.
 */
function checkoutElectronPids() {
  try {
    const needle = join(ROOT, "node_modules", "electron");
    return execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m) => m && m[2].includes(needle))
      .map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "kakapo-mermaid-smoke-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-qb", "main"]);
  git(["config", "user.email", "smoke@kakapo.test"]);
  git(["config", "user.name", "kakapo smoke"]);
  writeFileSync(join(repo, "NOTES.md"), "# notes\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  // A diff, so the app opens a review rather than an empty window.
  writeFileSync(join(repo, "NOTES.md"), "# notes\n\nchanged\n");
  return repo;
}

const HAS_ENTRY_POINTS =
  `typeof mermaidPlaceholderHtml === 'function' && typeof renderMermaidDiagrams === 'function'`;

/**
 * The page that can actually answer, asked rather than guessed.
 *
 * Every page target is probed for the Mermaid entry points: that rejects the DevTools window (which has
 * none) and waits out the boot race (the review page is listed before its inline client has run) with one
 * mechanism instead of a url heuristic plus a sleep.
 */
async function readyPage(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let list = [];
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch { /* not listening yet */ }
    for (const target of list) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      if (String(target.url).startsWith("devtools://")) continue;
      try {
        if (await evaluateInPage(target, HAS_ENTRY_POINTS, 5000) === true) return target;
      } catch { /* this page cannot answer; try the next, then try again */ }
    }
    await sleep(500);
  }
  return null;
}

async function evaluateInPage(target, expression, timeoutMs) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  });
  try {
    const opened = await Promise.race([
      new Promise((r) => ws.addEventListener("open", () => r(true))),
      sleep(10000).then(() => false),
    ]);
    if (!opened) throw new Error("the debugger socket never opened");
    await send("Runtime.enable", {});
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ timeout: true })),
    ]);
    if (r.timeout) throw new Error("the page check timed out");
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  } finally {
    try { ws.close(); } catch { /* already gone */ }
  }
}

async function run() {
  // Refuse rather than hand off: see (4) above. Exit 2, because a precondition this run cannot satisfy is
  // not the renderer failing.
  const already = checkoutElectronPids();
  if (already.length) {
    process.stdout.write(`a Kakapo from this checkout is already running (pid ${already.join(", ")}).\n`);
    process.stdout.write("quit it first — a second launch is handed to it, and this check would read its page.\n");
    return 2;
  }

  const repo = fixtureRepo();
  const child = spawn("node", [join(ROOT, "bin/kakapo.js"), repo, "--foreground"], {
    cwd: ROOT,
    env: { ...process.env, KAKAPO_REMOTE_DEBUG: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  try {
    const target = await readyPage(60000);
    if (!target) {
      process.stdout.write(`no page on port ${PORT} exposed the Mermaid entry points within 60s.\n`);
      process.stdout.write("an already-running Kakapo can take the launch over, leaving no debugger on this port.\n");
      if (log.trim()) process.stdout.write(`--- app output ---\n${log.slice(-1200)}\n`);
      return 1;
    }
    process.stdout.write(`page: ${String(target.title).slice(0, 48)}\n`);
    const result = JSON.parse(await evaluateInPage(target, PAGE_CHECK, 60000) ?? "null");
    const { ok, reasons } = verdict(result);
    process.stdout.write(
      `mermaid=${result?.mermaid} svg=${result?.svg} getBBox=${result?.bbW}x${result?.bbH} ` +
      `nodes=${result?.nodes} labels=${JSON.stringify(result?.labels)}\n`,
    );
    process.stdout.write(`malformed fence: svg=${result?.badSvg} reported=${result?.badHandled}\n`);
    for (const r of reasons) process.stdout.write(`  FAIL: ${r}\n`);
    process.stdout.write(ok ? "MERMAID_RENDER_OK\n" : "MERMAID_RENDER_FAILED\n");
    return ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`FAIL: ${error.message}\n`);
    if (log.trim()) process.stdout.write(`--- app output ---\n${log.slice(-1200)}\n`);
    return 1;
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    // The launcher exits on its own, so the app has to be stopped by pid. Nothing from this checkout was
    // running before (the refusal above guarantees it), so everything found here is ours to stop.
    for (const pid of checkoutElectronPids()) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    await sleep(1200);
    for (const pid of checkoutElectronPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(repo, { recursive: true, force: true });
  }
}

function selftest() {
  const good = {
    mermaid: "object", svg: true, bbW: 152, bbH: 136, nodes: 2,
    labels: ["Alpha", "Beta"], badSvg: false, badHandled: true, badText: "Invalid diagram",
  };
  const cases = [
    ["a real render passes", good, true],
    ["asset never served", { ...good, mermaid: "undefined" }, false],
    ["no svg at all", { ...good, svg: false }, false],
    // The one that matters: an <svg> with no geometry is what a layout-less environment produces, and it
    // is exactly what an assertion on the element alone would wave through.
    ["svg with zero geometry", { ...good, bbW: 0, bbH: 0 }, false],
    ["only one node", { ...good, nodes: 1 }, false],
    ["labels did not lay out", { ...good, labels: ["", ""] }, false],
    ["malformed fence drew anyway", { ...good, badSvg: true }, false],
    ["malformed fence silently empty", { ...good, badHandled: false, badText: "" }, false],
    ["page could not run", { err: "the viewer did not expose the Mermaid entry points" }, false],
    ["nothing returned", null, false],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    const got = verdict(input).ok;
    const ok = got === want;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  got=${got} want=${want}`}\n`);
  }
  if (bad) { process.stdout.write(`${bad} selftest case(s) failed\n`); return 1; }
  process.stdout.write(`${cases.length} cases passed\nSELFTEST_OK\n`);
  return 0;
}

const cmd = process.argv[2] ?? "run";
if (cmd === "selftest") process.exit(selftest());
else if (cmd === "run") process.exit(await run());
else {
  process.stdout.write("usage: mermaid-smoke.mjs [run|selftest]\n");
  process.exit(2);
}
