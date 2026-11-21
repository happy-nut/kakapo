import { mkdtempSync, rmSync, writeFileSync as write, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PORT, checkoutElectronPids, launchApp, portHolder, preflightPort, readyPage, sleep, stopApp }
  from "./lib/app-harness.mjs";

const WIDTHS = [1440, 900];
const LOCALES = ["en", "ko"];

const SURFACES = [
  {
    name: "find in files",
    open: "openQuickOpen('content'); var i = document.getElementById('quick-open-input'); i.value = 'test'; renderQuickOpenResults();",
    shown: "!document.getElementById('quick-open').classList.contains('hidden')",
  },
  {
    name: "search everywhere",
    open: "switchQuickLauncherSection('everywhere');",
    shown: "!document.getElementById('quick-open').classList.contains('hidden')",
  },
  {
    name: "settings",
    open: "document.getElementById('app-info-btn').click();",
    shown: "!document.getElementById('settings-modal').classList.contains('hidden')",
  },
  {
    name: "settings \u00b7 shortcuts",
    open: "var m = document.getElementById('settings-modal'); if (m.classList.contains('hidden')) document.getElementById('app-info-btn').click(); var c = document.querySelector('.settings-cat[data-cat=\"shortcuts\"]'); if (c) c.click();",
    shown: "!document.getElementById('settings-modal').classList.contains('hidden') && document.querySelector('.settings-section[data-cat=\"shortcuts\"]:not(.hidden)')",
  },
];

const TEXT_THE_USERS_REPOSITORY_WROTE = ['#source-body', '.d2h-code-line', '.d2h-code-side-line',
  '.hljs', '#diff-output', 'pre', 'code', '.quick-open-path', '.usage-line', '.semantic-peek-text'];

const AUDIT = `(() => {
  const theirs = ${JSON.stringify(TEXT_THE_USERS_REPOSITORY_WROTE)};
  const isTheirs = (el) => theirs.some((s) => el.closest(s));
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;
    const el = node.parentElement;
    if (!el || isTheirs(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (style.whiteSpace === 'pre' || style.whiteSpace === 'pre-wrap') continue;
    const describe = () => ({
      text: text.trim().slice(0, 60),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: String(el.className && el.className.baseVal === undefined ? el.className : '').slice(0, 50),
    });
    const words = /\\S+/g;
    let match;
    while ((match = words.exec(text))) {
      if (match[0].length < 2) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
      const linesItRendersOn = new Set(rects.map((r) => Math.round(r.top)));
      if (linesItRendersOn.size > 1) {
        const key = 'split:' + match[0] + ':' + Math.round(box.width);
        if (!seen.has(key)) { seen.add(key); out.push({ kind: 'split', word: match[0], ...describe() }); }
      }
    }
    const isLeaf = el.children.length === 0;
    const scrolls = style.overflow === 'auto' || style.overflowX === 'auto' || style.overflowX === 'scroll';
    const givesWayOnPurpose = Number(style.flexShrink) > 1;
    const clipsOnPurpose = style.textOverflow === 'ellipsis' || givesWayOnPurpose;
    if (isLeaf && !scrolls && !clipsOnPurpose && el.scrollWidth > el.clientWidth + 1) {
      const key = 'overflow:' + text.trim().slice(0, 30) + ':' + Math.round(box.width);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: 'overflow', word: '', wants: el.scrollWidth, has: el.clientWidth, ...describe() });
      }
    }
  }
  return out;
})()`;

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-ui-text-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "audit@example.com");
  git("config", "user.name", "audit");
  const put = (p, body) => { mkdirSync(dirname(join(root, p)), { recursive: true }); write(join(root, p), body); };
  put("src/store.ts", "export function makeStore() {\n  return { count: 0 };\n}\n");
  put("src/use-store.ts", "import { makeStore } from './store';\nconst s = makeStore();\nexport const value = s.count;\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  put("src/use-store.ts", "import { makeStore } from './store';\nconst s = makeStore();\nexport const value = s.count + 1;\n");
  return root;
}

async function auditSurface(page, surface, width, locale) {
  await page.evaluate(`(() => { try { closeQuickOpen(); } catch (e) {} try { var m = document.getElementById('settings-modal'); if (m && !m.classList.contains('hidden')) document.getElementById('settings-close').click(); } catch (e) {} return true; })()`);
  await sleep(200);
  await page.evaluate(`(() => { try { ${surface.open} } catch (e) { return String(e); } return true; })()`);
  let shown = false;
  for (let i = 0; i < 20 && !shown; i += 1) {
    shown = await page.evaluate(`(() => { try { return Boolean(${surface.shown}); } catch (e) { return false; } })()`);
    if (!shown) await sleep(150);
  }
  if (!shown) return [{ surface: surface.name, width, locale, kind: "unreachable" }];
  await sleep(250);
  const rows = await page.evaluate(AUDIT);
  return (rows ?? []).map((r) => ({ surface: surface.name, width, locale, ...r }));
}

async function run() {
  const already = checkoutElectronPids();
  if (already.length) {
    process.stdout.write(`a Kakapo from this checkout is already running (pid ${already.join(", ")}); quit it first.\n`);
    return 2;
  }
  if (!await preflightPort(PORT)) {
    const holder = portHolder(PORT);
    process.stdout.write(`port ${PORT} is already taken${holder ? ` (${holder})` : ""}; run with KAKAPO_SMOKE_PORT=<free port>.\n`);
    return 2;
  }
  const repo = fixtureRepo();
  const { child, log } = launchApp(repo);
  const found = [];
  let page = null;
  try {
    page = await readyPage(60000);
    if (!page) {
      process.stdout.write(`the review page never became ready.\n${log().slice(-1500)}\n`);
      return 1;
    }
    await sleep(2500);
    for (const locale of LOCALES) {
      await page.evaluate(`(() => { locale = ${JSON.stringify(locale)}; applyI18n(); return locale; })()`);
      await sleep(300);
      for (const width of WIDTHS) {
        await page.evaluate(`(() => { window.resizeTo(${width}, 900); return true; })()`);
        await sleep(400);
        for (const surface of SURFACES) found.push(...await auditSurface(page, surface, width, locale));
      }
    }
  } finally {
    await stopApp(child);
    rmSync(repo, { recursive: true, force: true });
  }

  const unreachable = found.filter((f) => f.kind === "unreachable");
  const defects = found.filter((f) => f.kind !== "unreachable");
  process.stdout.write(`\n# UI text audit\n\n`);
  if (!found.length) {
    process.stdout.write(`No word wraps inside itself and no label overflows its box, at ${WIDTHS.join("px and ")}px, in ${LOCALES.join(" and ")}.\n`);
    return 0;
  }
  process.stdout.write(`| Surface | Locale | Width | What | Text | Element |\n|---|---|---|---|---|---|\n`);
  for (const f of found) {
    const what = f.kind === "split" ? `the word \`${f.word}\` wraps inside itself`
      : f.kind === "overflow" ? `${f.wants}px of text in a ${f.has}px box`
      : "the surface never opened";
    const where = f.kind === "unreachable" ? "—" : `${f.tag}${f.id ? "#" + f.id : ""}${f.cls ? "." + f.cls.split(/\s+/)[0] : ""}`;
    process.stdout.write(`| ${f.surface} | ${f.locale} | ${f.width} | ${what} | ${f.kind === "unreachable" ? "—" : "`" + f.text + "`"} | ${where} |\n`);
  }
  process.stdout.write(`\n${defects.length} text defect${defects.length === 1 ? "" : "s"}`);
  if (unreachable.length) {
    process.stdout.write(`, and ${unreachable.length} surface${unreachable.length === 1 ? "" : "s"} this script could not open — a surface it cannot reach is a surface it is not auditing`);
  }
  process.stdout.write(`.\n`);
  return 1;
}

run().then((code) => process.exit(code), (err) => {
  process.stderr.write(String(err && err.stack || err) + "\n");
  process.exit(1);
});
