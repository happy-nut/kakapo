// Presses the navigation keys in the REAL app and reads what happened.
//
// The jsdom tests dispatch KeyboardEvents whose fields this repository chose, which cannot answer "does
// ⌘F12 actually reach the renderer on macOS", and they stub the language server, which cannot answer
// "is that the shape tsserver sends". CDP answers both: it injects at the browser's input layer, below
// the page (which is also why it works where osascript does not), and the app talks to the real server.
//
// Two bugs reached this check and nothing before it:
//   - the structure list had no nesting in TypeScript, because tsserver answers with the flat
//     SymbolInformation shape rather than the hierarchical one the unit tests were written against;
//   - a bookmark's gutter mark drew nothing (attr() on a pseudo-element reads the TD's attributes, and
//     the mark belongs to the ROW), and bookmarks leaked between repositories (a file:// page shares one
//     localStorage with every other review).
//
// Run it with `npm run nav:smoke`. It refuses while a Kakapo from this checkout is open, because a second
// launch is handed to that instance and this would drive the wrong window.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as write, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Overridable because 9333 is a popular debugger port — a Chrome started with --remote-debugging-port
// holds it on this machine, and the failure that produced was "the review page never became ready" with
// the real reason (bind() failed) buried in Electron's stderr. preflightPort below says it outright.
const PORT = Number(process.env.KAKAPO_SMOKE_PORT) || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkoutElectronPids() {
  try {
    return execFileSync("pgrep", ["-f", `${ROOT}/node_modules/electron`], { encoding: "utf8" })
      .split("\n").map((v) => v.trim()).filter(Boolean);
  } catch { return []; }
}

/** Whoever already has the debugger port, if anyone — so the run refuses for a reason it can name. */
function portHolder(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n").slice(1).filter(Boolean).map((line) => line.split(/\s+/).slice(0, 2).join(" ")).join(", ");
  } catch { return ""; }
}

function preflightPort(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "kakapo-nav-smoke-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    write(join(repo, path), content);
  };
  git(["init", "-qb", "main"]);
  git(["config", "user.email", "smoke@kakapo.test"]);
  git(["config", "user.name", "kakapo smoke"]);
  put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }));
  put("src/store.ts", [
    "export class Store {",        // 1
    "  private total = 0;",         // 2
    "",                            // 3
    "  run(): number {",            // 4
    "    return this.bump();",      // 5
    "  }",                         // 6
    "",                            // 7
    "  bump(): number {",           // 8
    "    this.total += 1;",         // 9
    "    return this.total;",       // 10
    "  }",                         // 11
    "}",                           // 12
    "",                            // 13
    "export function makeStore(): Store {", // 14
    "  return new Store();",        // 15
    "}",                           // 16
    "",
  ].join("\n"));
  put("src/store.test.ts", "import { Store } from './store';\n\nexport const subject = Store;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  // A change, so the app opens a review rather than the welcome screen.
  put("src/store.ts", [
    "export class Store {",
    "  private total = 1;",
    "",
    "  run(): number {",
    "    return this.bump();",
    "  }",
    "",
    "  bump(): number {",
    "    this.total += 1;",
    "    return this.total;",
    "  }",
    "}",
    "",
    "export function makeStore(): Store {",
    "  return new Store();",
    "}",
    "",
  ].join("\n"));
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
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

async function run() {
  const already = checkoutElectronPids();
  if (already.length) {
    process.stdout.write(`a Kakapo from this checkout is already running (pid ${already.join(", ")}); quit it first.\n`);
    return 2;
  }
  if (!await preflightPort(PORT)) {
    const holder = portHolder(PORT);
    process.stdout.write(`port ${PORT} is already taken${holder ? ` (${holder})` : ""}; `
      + `run with KAKAPO_SMOKE_PORT=<free port>.\n`);
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

  let page = null;
  try {
    page = await readyPage(60000);
    if (!page) {
      process.stdout.write(`the review page never became ready.\n${log.slice(-1500)}\n`);
      return 1;
    }
    // Open the file in the source view, which is where the navigation keys act.
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(900);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 0, 0, true, -1); return true; })()`);
    await sleep(200);

    // ---- ⌘F12: the file structure ----------------------------------------------------------------
    await page.key("F12", "F12", 123, 4);
    await sleep(1200); // a real language server answers this one
    const structure = await page.evaluate(`(() => {
      const open = !document.getElementById('quick-open').classList.contains('hidden');
      const rows = Array.from(document.querySelectorAll('#quick-open-results .structure-result'))
        .map((row) => ({ name: row.querySelector('.quick-open-name').textContent, depth: row.style.getPropertyValue('--structure-depth') }));
      return { open, rows, label: document.getElementById('quick-open-filter').textContent };
    })()`);
    await page.shot("structure");
    check("⌘F12 opens the structure popup in the real app", structure.open === true);
    check("the real server's symbols are listed, nested",
      structure.rows.length >= 4 && structure.rows[0].depth === "0" && structure.rows.some((r) => r.depth === "1"),
      JSON.stringify(structure.rows.map((r) => `${r.depth}:${r.name}`)));

    // Enter jumps to the selected symbol.
    await page.key("ArrowDown", "ArrowDown", 40, 0);
    await page.key("Enter", "Enter", 13, 0);
    await sleep(300);
    const afterJump = await page.evaluate(`caretLocation()`);
    check("Enter on a structure row jumps there", /store\.ts:\d+$/.test(afterJump), afterJump);

    // ---- ⌥↓ / ⌥↑: step by symbol ------------------------------------------------------------------
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 0, 0, true, -1); return true; })()`);
    await page.key("ArrowDown", "ArrowDown", 40, 1);
    const downOnce = await page.evaluate(`caretLocation()`);
    await page.key("ArrowDown", "ArrowDown", 40, 1);
    const downTwice = await page.evaluate(`caretLocation()`);
    await page.key("ArrowUp", "ArrowUp", 38, 1);
    const backUp = await page.evaluate(`caretLocation()`);
    check("⌥↓ steps to the next symbol, ⌥↑ back", downOnce !== downTwice && backUp === downOnce,
      `${downOnce} -> ${downTwice} -> ${backUp}`);

    // ---- ⇧⇧: search everywhere --------------------------------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.key("Shift", "ShiftLeft", 16, 8);
    const afterOneShift = await page.evaluate(`!document.getElementById('quick-open').classList.contains('hidden')`);
    await page.key("Shift", "ShiftLeft", 16, 8);
    const afterTwoShifts = await page.evaluate(`(() => {
      const el = document.getElementById('quick-open');
      return { open: !el.classList.contains('hidden'), rail: el.classList.contains('quick-launcher') };
    })()`);
    check("one Shift does nothing", afterOneShift === false);
    check("⇧⇧ opens the launcher with its rail", afterTwoShifts.open === true && afterTwoShifts.rail === true, JSON.stringify(afterTwoShifts));

    // ---- ⌘P with a line suffix --------------------------------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.key("p", "KeyP", 80, 4);
    await sleep(200);
    await page.evaluate(`(() => { document.getElementById('quick-open-input').focus(); return true; })()`);
    await page.type("store.ts:9");
    const rows = await page.evaluate(`document.querySelectorAll('#quick-open-results .quick-open-item').length`);
    await page.key("Enter", "Enter", 13, 0);
    await sleep(400);
    const afterSuffix = await page.evaluate(`caretLocation()`);
    check("⌘P finds the file and `:9` lands on the line", rows > 0 && afterSuffix.endsWith(":9"), `${rows} rows, caret ${afterSuffix}`);

    // ---- F3 / ⇧⌥3 / ⌥3: bookmarks ----------------------------------------------------------------
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 7, 2, true, -1); return true; })()`);
    await sleep(400);
    await page.key("F3", "F3", 114, 0);
    await sleep(300);
    const marked = await page.evaluate(`!!document.querySelector('#source-body tr.source-row[data-line-index="7"].bookmarked')`);
    check("F3 marks the caret's line in the real gutter", marked === true);
    // The mark has to be VISIBLE, not merely classed: a pseudo-element with empty content passes every
    // DOM assertion and draws nothing (which is exactly what happened the first time).
    const flagPainted = await page.evaluate(`(() => {
      const cell = document.querySelector('#source-body tr.source-row[data-line-index="7"].bookmarked td.num');
      return cell ? getComputedStyle(cell, '::after').content : '(no cell)';
    })()`);
    check("the flag actually paints", /\u2691|"\u2691"/.test(flagPainted), String(flagPainted));
    await page.key("3", "Digit3", 51, 1 + 8); // ⇧⌥3
    const numbered = await page.evaluate(`document.querySelector('#source-body tr.source-row[data-line-index="7"]').dataset.bookmarkMnemonic`);
    await page.shot("bookmark");
    check("⇧⌥3 numbers the line", numbered === "3", String(numbered));
    const numberPainted = await page.evaluate(`(() => {
      const cell = document.querySelector('#source-body tr.source-row[data-line-index="7"].bookmarked td.num');
      return cell ? getComputedStyle(cell, '::after').content : '(no cell)';
    })()`);
    check("the number actually paints in the gutter", numberPainted.includes("3"), String(numberPainted));
    await page.evaluate(`(() => { openSourceFile('src/store.test.ts'); return true; })()`);
    await sleep(500);
    await page.key("3", "Digit3", 51, 1); // ⌥3
    await sleep(400);
    const jumped = await page.evaluate(`caretLocation()`);
    check("⌥3 goes back to it from another file", jumped === "src/store.ts:8", jumped);

    // ---- ⌘⇧T: the counterpart file ---------------------------------------------------------------
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.key("t", "KeyT", 84, 4 + 8);
    await sleep(500);
    const counterpart = await page.evaluate(`document.getElementById('source-viewer').dataset.openPath`);
    check("⌘⇧T opens this file's test", counterpart === "src/store.test.ts", String(counterpart));

    // ---- ⌘⌥H: the call hierarchy, from the real server -------------------------------------------
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 7, 2, true, -1); return true; })()`); // on `bump`
    await page.key("h", "KeyH", 72, 4 + 1);
    await sleep(1500);
    const hierarchy = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#quick-open-results .structure-result'))
        .map((row) => row.querySelector('.quick-open-name').textContent);
      return { rows, label: document.getElementById('quick-open-filter').textContent, text: document.getElementById('quick-open-results').textContent.slice(0, 120) };
    })()`);
    await page.shot("hierarchy");
    check("⌘⌥H lists the real callers", hierarchy.rows.length > 0, `${hierarchy.label} | ${JSON.stringify(hierarchy.rows)}`);

    // ---- ⌥F7: the usage view, from the real server ----------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    // On `Store` in makeStore's return type — a position whose own line is filtered out, so what is left
    // is the `new`, the import in the test and the plain reference beside it.
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 13, 29, true, -1); return true; })()`);
    await page.key("F7", "F7", 118, 1);
    await sleep(1800); // the real server answers this one
    const usages = await page.evaluate(`(() => {
      const el = document.getElementById('quick-open');
      return {
        open: !el.classList.contains('hidden'),
        groups: Array.from(document.querySelectorAll('#quick-open-results .usage-group[data-usage-type]')).map((g) => g.dataset.usageType),
        types: Array.from(document.querySelectorAll('#quick-open-results .usage-result')).map((r) => r.dataset.usageType),
        label: document.getElementById('quick-open-filter').textContent,
      };
    })()`);
    await page.shot("usages");
    check("⌥F7 opens the usage view in the real app", usages.open === true, usages.label);
    // The point of the view is that the rows are not one undifferentiated list. Two distinct types from a
    // real tsserver answer is the thing jsdom's stub cannot establish.
    check("the real server's usages arrive classified, under more than one heading",
      usages.types.length >= 2 && new Set(usages.groups).size >= 2 && usages.groups.includes("new"),
      `${usages.label} | ${JSON.stringify(usages.groups)}`);
    // ⌥P: the toggle it borrows from Find in Files, pressed inside this mode.
    const beforeNoise = usages.types.length;
    await page.key("p", "KeyP", 80, 1);
    await sleep(300);
    const afterNoise = await page.evaluate(`(() => ({
      rows: document.querySelectorAll('#quick-open-results .usage-result').length,
      pressed: document.getElementById('quick-open-exclude-noise').getAttribute('aria-pressed'),
      visible: getComputedStyle(document.querySelector('.quick-open-search-options')).display,
    }))()`);
    check("⌥P takes the test file out, and the toggle it borrows is on screen saying so",
      afterNoise.rows < beforeNoise && afterNoise.pressed === "true" && afterNoise.visible !== "none",
      JSON.stringify(afterNoise));

    // ---- ⌘F7 and ⌘⌥↓: the in-file highlight ------------------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 8, 9, true, -1); return true; })()`); // on `total`
    await sleep(200);
    await page.key("F7", "F7", 118, 4);
    await sleep(400);
    const highlight = await page.evaluate(`(() => {
      const names = ['kakapo-usage-read', 'kakapo-usage-write'];
      const sizes = names.map((name) => (CSS.highlights.get(name) || { size: 0 }).size);
      // A registered highlight with no CSS rule to draw it is the one failure a DOM assertion cannot see:
      // the name is written in two files (17-find-usages.js and viewer.css) and nothing but this compares
      // them. Reads every sheet's text rather than one known index, because the lazy Mermaid sheet moves.
      let css = '';
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) css += rule.cssText; } catch (e) { /* cross-origin */ }
      }
      return {
        sizes,
        styled: names.filter((name) => css.includes('::highlight(' + name + ')')),
        rows: document.querySelectorAll('#source-body tr.source-row.usage-mark-row').length,
      };
    })()`);
    await page.shot("usage-highlight");
    check("⌘F7 registers real ranges for this file's occurrences",
      highlight.sizes[0] + highlight.sizes[1] >= 2 && highlight.rows >= 2, JSON.stringify(highlight));
    check("and both highlight names have a rule that paints them",
      highlight.styled.length === 2, JSON.stringify(highlight.styled));
    const beforeStep = await page.evaluate(`caretLocation()`);
    await page.key("ArrowDown", "ArrowDown", 40, 4 + 1);
    const afterStep = await page.evaluate(`caretLocation()`);
    await page.key("ArrowUp", "ArrowUp", 38, 4 + 1);
    const backStep = await page.evaluate(`caretLocation()`);
    check("⌘⌥↓ steps to the next occurrence, ⌘⌥↑ back",
      afterStep !== beforeStep && backStep === beforeStep, `${beforeStep} -> ${afterStep} -> ${backStep}`);
    // Stepping moves the caret, which repaints rows. A highlight whose ranges pointed at the rows that
    // were there before the jump would be gone by now, and nothing in jsdom could tell.
    const stillPainted = await page.evaluate(`(CSS.highlights.get('kakapo-usage-read') || { size: 0 }).size
      + (CSS.highlights.get('kakapo-usage-write') || { size: 0 }).size`);
    check("and the highlight survives the jump", stillPainted >= 2, String(stillPainted));
    await page.key("Escape", "Escape", 27, 0);
    await sleep(200);
    const cleared = await page.evaluate(`(CSS.highlights.get('kakapo-usage-read') || { size: 0 }).size
      + (CSS.highlights.get('kakapo-usage-write') || { size: 0 }).size`);
    check("Escape takes the highlight down", cleared === 0, String(cleared));

    // ---- F1 and ⌘⇧P: what the real server says this IS -------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 13, 29, true, -1); return true; })()`); // on `Store`
    await page.key("F1", "F1", 112, 0);
    await sleep(1500);
    const doc = await page.evaluate(`(() => {
      const panel = document.getElementById('quick-doc');
      const body = document.getElementById('quick-doc-body');
      return {
        open: panel && !panel.classList.contains('hidden'),
        title: (document.getElementById('quick-doc-title') || {}).textContent,
        meta: (document.getElementById('quick-doc-meta') || {}).textContent,
        code: body ? Array.from(body.querySelectorAll('pre code')).map((el) => el.textContent.trim()) : [],
        text: body ? body.textContent.trim().slice(0, 160) : '',
      };
    })()`);
    await page.shot("quick-doc");
    // A real tsserver answers hover with a fenced signature; jsdom's stub can only prove the page renders
    // whatever it is handed, which is the half that was never in doubt.
    check("F1 shows what the real server says about the symbol",
      doc.open === true && doc.title === "Store" && doc.code.some((entry) => /class\s+Store/.test(entry)),
      JSON.stringify(doc));
    await page.key("Escape", "Escape", 27, 0);
    await page.key("p", "KeyP", 80, 4 + 8);
    await sleep(1200);
    const typeHint = await page.evaluate(`(() => {
      const hint = document.querySelector('.mc-caret-hint, .mc-toast');
      return hint ? hint.textContent.trim() : '(none)';
    })()`);
    check("⌘⇧P puts the real signature on one line", /class\s+Store/.test(typeHint), typeHint);

    // ---- ⌘6: the Problems view over the whole review ----------------------------------------------
    await page.key("6", "Digit6", 54, 4);
    await sleep(2500); // every file in the review, through a real server
    const problems = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#quick-open-results .problem-result'));
      return {
        open: !document.getElementById('quick-open').classList.contains('hidden'),
        label: document.getElementById('quick-open-filter').textContent,
        asked: (window.__diagnosticsRequests || []).length,
        rows: rows.length,
        severities: rows.map((row) => row.dataset.severity),
        empty: document.querySelector('#quick-open-results .quick-open-empty') ? document.querySelector('#quick-open-results .quick-open-empty').textContent.trim() : '',
      };
    })()`);
    await page.shot("problems");
    // The fixture compiles, so the honest expectation is "the list ran and said something" — either rows
    // or the clean message. What matters is that it asked about more than the open file and that the
    // scanning line resolved rather than hanging.
    check("⌘6 opens the Problems view and finishes its scan",
      problems.open === true && !/\u2026$/.test(problems.label.trim()),
      JSON.stringify(problems));
    await page.key("Escape", "Escape", 27, 0);

    // ---- ⌘⇧E: recent locations -------------------------------------------------------------------
    await page.key("Escape", "Escape", 27, 0);
    await page.key("e", "KeyE", 69, 4 + 8);
    await sleep(300);
    const locations = await page.evaluate(`(() => ({
      open: !document.getElementById('quick-open').classList.contains('hidden'),
      rows: document.querySelectorAll('#quick-open-results .quick-open-item').length,
    }))()`);
    check("⌘⇧E lists where the caret has been", locations.open === true && locations.rows > 0, JSON.stringify(locations));
    await page.key("Escape", "Escape", 27, 0);
  } finally {
    page?.close();
    child.kill("SIGTERM");
    await sleep(600);
    child.kill("SIGKILL");
    // The launcher is a node process; the app is its Electron children, and they outlive it. Leaving them
    // running makes the NEXT run refuse (a second launch is handed to the instance already up).
    for (const pid of checkoutElectronPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    await sleep(400);
    rmSync(repo, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed in the real app\n`);
  return failed.length ? 1 : 0;
}

process.exit(await run());
