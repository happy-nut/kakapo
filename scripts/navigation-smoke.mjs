import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as write } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PORT, checkoutElectronPids, launchApp, portHolder, preflightPort, readyPage, sleep, stopApp }
  from "./lib/app-harness.mjs";

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
  put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src", "packages"] }));
  put("package.json", JSON.stringify({ name: "@smoke/root", private: true }));
  put("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  put("packages/ui/package.json", JSON.stringify({ name: "@smoke/ui", private: true }));
  put("packages/ui/src/button.ts", "import { Store } from '../../../src/store';\n\nexport const button = new Store();\n");
  put("src/store.ts", [
    "export class Store {",
    "  private total = 0;",
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
  put("src/store.test.ts", "import { Store } from './store';\n\nexport const subject = Store;\n");
  put("test/helper.ts", "export const helper = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
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
  const { child, log } = launchApp(repo);

  let page = null;
  try {
    page = await readyPage(60000);
    if (!page) {
      process.stdout.write(`the review page never became ready.\n${log().slice(-1500)}\n`);
      return 1;
    }
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(900);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 0, 0, true, -1); return true; })()`);
    await sleep(200);

    await page.key("F12", "F12", 123, 4);
    await sleep(1200);
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

    await page.key("ArrowDown", "ArrowDown", 40, 0);
    await page.key("Enter", "Enter", 13, 0);
    await sleep(300);
    const afterJump = await page.evaluate(`caretLocation()`);
    check("Enter on a structure row jumps there", /store\.ts:\d+$/.test(afterJump), afterJump);

    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 0, 0, true, -1); return true; })()`);
    await page.key("}", "BracketRight", 221, 4 + 1);
    const downOnce = await page.evaluate(`caretLocation()`);
    await page.key("}", "BracketRight", 221, 4 + 1);
    const downTwice = await page.evaluate(`caretLocation()`);
    await page.key("{", "BracketLeft", 219, 4 + 1);
    const backUp = await page.evaluate(`caretLocation()`);
    check("⌘⌥] steps to the next symbol, ⌘⌥[ back", downOnce !== downTwice && backUp === downOnce,
      `${downOnce} -> ${downTwice} -> ${backUp}`);

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

    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 7, 2, true, -1); return true; })()`);
    await sleep(400);
    await page.key("F3", "F3", 114, 0);
    await sleep(300);
    const marked = await page.evaluate(`!!document.querySelector('#source-body tr.source-row[data-line-index="7"].bookmarked')`);
    check("F3 marks the caret's line in the real gutter", marked === true);
    const flagPainted = await page.evaluate(`(() => {
      const cell = document.querySelector('#source-body tr.source-row[data-line-index="7"].bookmarked td.num');
      return cell ? getComputedStyle(cell, '::after').content : '(no cell)';
    })()`);
    check("the flag actually paints", /\u2691|"\u2691"/.test(flagPainted), String(flagPainted));
    await page.key("3", "Digit3", 51, 1 + 8);
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
    await page.key("3", "Digit3", 51, 1);
    await sleep(400);
    const jumped = await page.evaluate(`caretLocation()`);
    check("⌥3 goes back to it from another file", jumped === "src/store.ts:8", jumped);

    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.key("t", "KeyT", 84, 4 + 8);
    await sleep(500);
    const counterpart = await page.evaluate(`document.getElementById('source-viewer').dataset.openPath`);
    check("⌘⇧T opens this file's test", counterpart === "src/store.test.ts", String(counterpart));

    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 7, 2, true, -1); return true; })()`);
    await page.key("y", "KeyY", 89, 4 + 8);
    await sleep(1500);
    const hierarchy = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#quick-open-results .structure-result'))
        .map((row) => row.querySelector('.quick-open-name').textContent);
      return { rows, label: document.getElementById('quick-open-filter').textContent, text: document.getElementById('quick-open-results').textContent.slice(0, 120) };
    })()`);
    await page.shot("hierarchy");
    check("⌘⇧Y lists the real callers", hierarchy.rows.length > 0, `${hierarchy.label} | ${JSON.stringify(hierarchy.rows)}`);

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 13, 29, true, -1); return true; })()`);
    await page.key("b", "KeyB", 66, 4);
    await sleep(1500);
    const declarationJump = await page.evaluate(`caretLocation()`);
    check("⌘B on a reference goes to the declaration", declarationJump === "src/store.ts:1", declarationJump);

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 0, 13, true, -1); return true; })()`);
    await page.key("b", "KeyB", 66, 4);
    await sleep(1800);
    const onDeclaration = await page.evaluate(`(() => {
      const panel = document.getElementById('semantic-peek');
      return {
        open: Boolean(panel) && getComputedStyle(panel).display !== 'none' && !panel.classList.contains('hidden'),
        rows: Array.from(document.querySelectorAll('#semantic-peek-results .semantic-peek-item')).filter((r) => r.getBoundingClientRect().height > 0).length,
        title: String((document.getElementById('semantic-peek-title') || {}).textContent || ''),
        caret: caretLocation(),
      };
    })()`);
    await page.shot("declaration-or-usages");
    check("⌘B on the declaration shows its usages instead",
      onDeclaration.open === true && onDeclaration.rows > 0 && onDeclaration.caret === "src/store.ts:1",
      JSON.stringify(onDeclaration));

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 13, 29, true, -1); return true; })()`);
    await page.key("F7", "F7", 118, 1);
    await sleep(1800);
    const usages = await page.evaluate(`(() => {
      const el = document.getElementById('quick-open');
      return {
        open: !el.classList.contains('hidden'),
        groups: Array.from(document.querySelectorAll('#quick-open-results .usage-group[data-usage-group="type"]')).map((g) => g.dataset.usageKey),
        modules: Array.from(document.querySelectorAll('#quick-open-results .usage-group[data-usage-group="module"]')).map((g) => g.dataset.usageKey),
        // What jsdom cannot answer: does the nesting PAINT. A module header inside a usage type is one
        // step further in than the type above it, and the step is a computed padding.
        indents: Array.from(document.querySelectorAll('#quick-open-results .usage-group')).map((g) => parseFloat(getComputedStyle(g).paddingLeft)),
        // The ROWS are indented under their node too, which takes a compound selector to beat the
        // padding shorthand on .quick-open-item. Flush-left rows under a four-deep header is what it
        // looked like before, and no jsdom assertion could see it. (No backticks in here: this whole
        // block is a template literal.)
        rowIndents: Array.from(document.querySelectorAll('#quick-open-results .usage-result')).map((r) => parseFloat(getComputedStyle(r).paddingLeft)),
        chips: Array.from(document.querySelectorAll('.quick-open-usage-chip')).filter((c) => getComputedStyle(c).display !== 'none').length,
        types: Array.from(document.querySelectorAll('#quick-open-results .usage-result')).map((r) => r.dataset.usageType),
        label: document.getElementById('quick-open-filter').textContent,
      };
    })()`);
    await page.shot("usages");
    check("⌥F7 opens the usage view in the real app", usages.open === true, usages.label);
    check("the real server's usages arrive classified, under more than one heading",
      usages.types.length >= 2 && new Set(usages.groups).size >= 2 && usages.groups.includes("new"),
      `${usages.label} | ${JSON.stringify(usages.groups)}`);
    check("the usages are divided by module, with the workspace's own module names",
      usages.modules.includes("@smoke/ui") && usages.modules.includes("@smoke/root"),
      JSON.stringify(usages.modules));
    check("and the nesting is drawn, not merely ordered — headers and the rows under them",
      usages.chips >= 9 && new Set(usages.indents).size >= 2 && Math.max(...usages.indents) > Math.min(...usages.indents)
      && Math.max(...usages.rowIndents) >= Math.max(...usages.indents),
      `${usages.chips} chips, indents ${JSON.stringify(usages.indents)}, rows ${JSON.stringify(usages.rowIndents)}`);

    await page.key("s", "KeyS", 83, 4 + 1);
    await sleep(300);
    const scoped = await page.evaluate(`(() => ({
      scopes: Array.from(document.querySelectorAll('#quick-open-results .usage-group[data-usage-group="scope"]')).map((g) => g.dataset.usageKey),
      pressed: document.querySelector('.quick-open-usage-chip[data-usage-toggle="scope"]').getAttribute('aria-pressed'),
      tags: document.querySelectorAll('#quick-open-results .usage-result-tag').length,
    }))()`);
    await page.shot("usages-scoped");
    check("⌘⌥S divides the real answer into production and test code",
      scoped.pressed === "true" && scoped.scopes.includes("production") && scoped.scopes.includes("test") && scoped.tags === 0,
      JSON.stringify(scoped));
    await page.key("s", "KeyS", 83, 4 + 1);
    await sleep(200);

    const tree = await page.evaluate(`(() => {
      const node = document.querySelector('#quick-open-results .usage-group[data-usage-group="type"]');
      const before = document.querySelectorAll('#quick-open-results .usage-result').length;
      const hit = document.querySelector('#quick-open-results .usage-hit');
      const weight = hit ? getComputedStyle(hit).fontWeight : '';
      node.click();
      return new Promise((resolve) => setTimeout(() => {
        const after = document.querySelector('#quick-open-results .usage-group[data-usage-group="type"]');
        resolve({
          before,
          afterRows: document.querySelectorAll('#quick-open-results .usage-result').length,
          twisty: after ? after.querySelector('.usage-twisty').textContent : '',
          count: after ? after.querySelector('.usage-group-count').textContent : '',
          hit: hit ? hit.textContent : '',
          weight,
          icon: Boolean(document.querySelector('#quick-open-results .usage-group .usage-group-icon')),
        });
      }, 120));
    })()`);
    await page.shot("usages-tree");
    check("a usage node folds, keeps its count, and the occurrence is marked in bold",
      tree.afterRows < tree.before && tree.twisty === "▸" && /^\(\d+/.test(tree.count)
      && tree.hit === "Store" && Number(tree.weight) >= 600 && tree.icon,
      JSON.stringify(tree));
    await page.evaluate(`(() => { document.querySelector('[data-usage-tree="expand"]').click(); return true; })()`);
    await sleep(200);

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

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 8, 9, true, -1); return true; })()`);
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
    const stillPainted = await page.evaluate(`(CSS.highlights.get('kakapo-usage-read') || { size: 0 }).size
      + (CSS.highlights.get('kakapo-usage-write') || { size: 0 }).size`);
    check("and the highlight survives the jump", stillPainted >= 2, String(stillPainted));
    await page.key("Escape", "Escape", 27, 0);
    await sleep(200);
    const cleared = await page.evaluate(`(CSS.highlights.get('kakapo-usage-read') || { size: 0 }).size
      + (CSS.highlights.get('kakapo-usage-write') || { size: 0 }).size`);
    check("Escape takes the highlight down", cleared === 0, String(cleared));

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    await page.evaluate(`(() => { setSourceCursor('src/store.ts', 13, 29, true, -1); return true; })()`);
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

    await page.key("6", "Digit6", 54, 4);
    await sleep(2500);
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
    check("⌘6 opens the Problems view and finishes its scan",
      problems.open === true && !/\u2026$/.test(problems.label.trim()),
      JSON.stringify(problems));
    await page.key("Escape", "Escape", 27, 0);

    await page.key("Escape", "Escape", 27, 0);
    await page.key("e", "KeyE", 69, 4 + 8);
    await sleep(300);
    const locations = await page.evaluate(`(() => ({
      open: !document.getElementById('quick-open').classList.contains('hidden'),
      rows: document.querySelectorAll('#quick-open-results .quick-open-item').length,
    }))()`);
    check("⌘⇧E lists where the caret has been", locations.open === true && locations.rows > 0, JSON.stringify(locations));
    await page.key("Escape", "Escape", 27, 0);

    await page.key("Escape", "Escape", 27, 0);
    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(400);
    const geometry = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#source-body .source-row'));
      const code = (row) => row.querySelector('.source-code').getBoundingClientRect();
      const first = code(rows[1]);
      const last = code(rows[rows.length - 1]);
      const body = document.getElementById('source-body').getBoundingClientRect();
      getSelection().removeAllRanges();
      return {
        rows: rows.length,
        startX: first.left + 30, startY: first.top + first.height / 2,
        belowY: Math.min(last.bottom + 160, body.bottom - 8),
        room: body.bottom - last.bottom,
      };
    })()`);
    await page.drag(geometry.startX, geometry.startY, geometry.startX + 40, geometry.belowY);
    const dragged = await page.evaluate(`(() => {
      const selection = getSelection();
      const lineOf = (node) => {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const row = el && el.closest ? el.closest('.source-row') : null;
        return row ? Number(row.dataset.lineIndex) + 1 : null;
      };
      const rows = selectedSourceRows(selection).map((row) => Number(row.dataset.lineIndex) + 1);
      return { anchor: lineOf(selection.anchorNode), focus: lineOf(selection.focusNode), first: rows[0], last: rows[rows.length - 1], count: rows.length };
    })()`);
    await page.shot("drag-past-end");
    check("dragging below the last line selects to the END of the file, not back to the top",
      geometry.room > 40 && dragged.anchor === 2 && dragged.first === 2 && dragged.last === geometry.rows
      && dragged.focus === geometry.rows,
      `${geometry.room}px of room | ${JSON.stringify(dragged)}`);
    await page.evaluate(`(() => { getSelection().removeAllRanges(); return true; })()`);

    await page.evaluate(`(() => { openVirtualSourceDirectory('packages/ui'); return true; })()`);
    await sleep(300);
    const layoutMarks = await page.evaluate(`(() => {
      const test = document.querySelector('.source-link[data-source-file="src/store.test.ts"]');
      // NOT store.ts: that row is the open file, so it is selected, and its name is the selected colour
      // rather than the ordinary one — comparing against it would call any two rows "tinted".
      const plain = document.querySelector('.source-link[data-source-file="tsconfig.json"]');
      const row = document.querySelector('.tree-dir[data-dir="packages/ui"]');
      const badge = row && row.querySelector('.tree-module');
      const name = row && row.querySelector('summary .path');
      const mark = document.querySelector('.tree-dir.is-test-root .folder-mark');
      const moduleMark = row && row.querySelector('.folder-mark');
      const box = (el) => el ? el.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        test: Boolean(test && test.classList.contains('is-test-file')),
        // IntelliJ's File Colors, by value: FileColorManagerImpl's Green is #effae7 light / #49544a dark,
        // and TestsScope asks for Green. A class with no paint behind it is what jsdom cannot catch.
        tint: test ? getComputedStyle(test).backgroundColor : '',
        plainTint: plain ? getComputedStyle(plain).backgroundColor : '',
        // The folder marks lifted out of testSourceFolder.svg and Module.svg, drawn ON the folder icon.
        testMark: box(mark).width > 0 && box(mark).height > 0,
        moduleMark: box(moduleMark).width > 0,
        badge: badge ? badge.textContent : '',
        badgeShown: badge ? getComputedStyle(badge).display !== 'none' : false,
        // On the same line as the folder name, not wrapped under it: the summary is a grid and a third
        // child without a third track drops to the next row.
        inline: Boolean(badge && name) && Math.abs(badge.getBoundingClientRect().top - name.getBoundingClientRect().top) < 4
          && badge.getBoundingClientRect().left > name.getBoundingClientRect().left,
      };
    })()`);
    await page.shot("tree-modules");
    const tinted = (value) => Boolean(value) && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(value);
    check("the tree paints a test File Color an ordinary file does not have, and IntelliJ's folder marks",
      layoutMarks.test && tinted(layoutMarks.tint) && !tinted(layoutMarks.plainTint)
      && layoutMarks.tint !== layoutMarks.plainTint
      && layoutMarks.testMark && layoutMarks.moduleMark,
      JSON.stringify(layoutMarks));

    await page.key("f", "KeyF", 70, 4 + 8);
    await sleep(400);
    await page.key("s", "KeyS", 83, 1);
    await sleep(250);
    const scope = await page.evaluate(`(() => {
      const select = document.getElementById('quick-open-scope');
      return {
        value: select.value,
        options: Array.from(select.options).map((o) => o.value),
        shown: getComputedStyle(select).display !== 'none',
        label: Array.from(select.options).map((o) => o.textContent).join(' | '),
      };
    })()`);
    await page.shot("search-scope");
    check("⌥S cycles the Find in Files scope, and the module scope is named",
      scope.shown && scope.value === "production" && scope.options.includes("module") && /@smoke\/root/.test(scope.label),
      JSON.stringify(scope));
    await page.key("Escape", "Escape", 27, 0);
    await sleep(250);

    await page.evaluate(`(() => { openSourceFile('src/store.ts'); return true; })()`);
    await sleep(700);
    await page.key("f", "KeyF", 70, 4);
    await sleep(350);
    for (const [ch, code, vk] of [["b", "KeyB", 66], ["u", "KeyU", 85], ["m", "KeyM", 77], ["p", "KeyP", 80], ["(", "Digit9", 57]]) {
      await page.char(ch, code, vk);
    }
    await sleep(400);
    const typing = await page.evaluate(`(() => {
      const field = document.getElementById('file-find-input');
      return {
        value: field.value,
        focused: document.activeElement === field,
        open: !document.getElementById('file-find').classList.contains('hidden'),
        count: document.getElementById('file-find-count').textContent,
        matches: window.__kakapoFileFind.results().length,
      };
    })()`);
    await page.shot("file-find-typing");
    check("every character typed into the find bar arrives, and the bar keeps the keyboard",
      typing.open && typing.focused && typing.value === "bump(" && typing.matches > 0,
      JSON.stringify(typing));

    await page.key("m", "KeyM", 77, 1);
    await sleep(300);
    await page.key("x", "KeyX", 88, 1);
    await sleep(300);
    const toggles = await page.evaluate(`(() => {
      const options = window.__kakapoFileFind.options();
      return {
        matchCase: options.matchCase,
        regex: options.regex,
        patternError: Boolean(options.patternError),
        count: document.getElementById('file-find-count').textContent,
        pressed: document.getElementById('file-find-match-case').getAttribute('aria-pressed'),
      };
    })()`);
    await page.shot("file-find-toggles");
    check("⌥M and ⌥X reach the find bar, and an unclosed group is named a bad pattern",
      toggles.matchCase && toggles.regex && toggles.patternError && toggles.pressed === "true",
      JSON.stringify(toggles));
    await page.key("Escape", "Escape", 27, 0);
  } finally {
    page?.close();
    await stopApp(child);
    rmSync(repo, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed in the real app\n`);
  return failed.length ? 1 : 0;
}

process.exit(await run());
