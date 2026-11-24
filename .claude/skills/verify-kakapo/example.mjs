#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("example");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/parser.ts", "export function parse(text: string): string[] {\n  return text.split(',');\n}\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/parser.ts", "export function parse(text: string): string[] {\n  return text.split(',').map((p) => p.trim());\n}\n");
const handedOff = repo.commit("parser: trim each field");
repo.put("src/report.ts", "export const report = (rows: string[]) => rows.join('\\n');\n");

await drive("example", repo, async (page, h) => {
  const shown = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).filter(Boolean).sort()`);
  const pill = () => page.evaluate(
    `document.querySelector('.compare-refs') ? document.querySelector('.compare-refs').textContent.replace(/\\s+/g,' ').trim() : ''`);

  const opened = await shown();
  h.control(JSON.stringify(opened) === JSON.stringify(["src/report.ts"]),
    "a dirty worktree opens on the uncommitted work", JSON.stringify(opened));
  const listed = await page.evaluate(`document.querySelectorAll('#changes-panel .file-link').length`);
  h.check(listed === opened.length, "and the Changes list says the same thing as the diff", listed);
  await h.shot("open-review");

  await page.key("Dead", "KeyA", 65, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 2`);
  h.check(JSON.stringify(await shown()) === JSON.stringify(["src/parser.ts", "src/report.ts"]),
    "⌥A widens to everything the branch changed", JSON.stringify(await shown()));

  await page.key("Dead", "KeyU", 85, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 1`);
  h.check(JSON.stringify(await shown()) === JSON.stringify(["src/report.ts"]),
    "⌥U narrows to the uncommitted edit alone", JSON.stringify(await shown()));

  await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
  await page.evaluate(`window.__kakapoCompareMenu.open()`);
  await h.until(`!document.getElementById('compare-menu').classList.contains('hidden')`);
  h.check(await page.evaluate(
    `document.querySelector('#compare-menu .compare-menu-row[data-mode="since"]').classList.contains('hidden')`),
    "with nothing handed over, the \"since you last read\" row hides itself");
  await page.key("Escape", "Escape", 27, 0);

  await page.key("Dead", "KeyA", 65, 1);
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  await h.click(".d2h-code-line-ctn", 0);
  await page.key("?", "Slash", 191, 8);
  const prefill = await h.until(`(() => {
    const el = document.activeElement;
    return (el && el.classList && el.classList.contains('mc-input')) ? (el.value || '(empty)') : false;
  })()`);
  h.check(/^@\S+#L\d+/.test(prefill), "the composer opens focused and prefilled with the line it is about", prefill);
  for (const ch of "why") await page.char(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0));
  await page.key("Enter", "Enter", 13, 4);
  await h.until(`document.querySelectorAll('.mc-comment-row').length === 1`);
  const stored = await h.until(`window.kakapoComments.read().then(r => r.records.length || false)`);
  h.check(stored === 1, "and the comment was written to the workspace record, not just drawn", stored);
  await h.shot("comment-on-a-line");

  await page.key("/", "Slash", 191, 12);
  const cards = await h.until(`document.querySelectorAll('#mc-merged-panel .mc-merged-card').length || false`);
  h.check(cards === 1, "the hand-off document holds the comment", cards);
  await h.shot("hand-off-panel");
  await page.key("a", "KeyA", 65, 4);
  await page.key("c", "KeyC", 67, 4);
  const after = await h.until(`window.kakapoComments.read().then(r =>
    (r.records.length && r.records.every(c => c.archivedAt))
      ? ('archived:' + r.records.length) : false)`);
  h.check(after === "archived:1", "and handing it over moved it to the archive — still on disk, out of the review", after);

  repo.put("src/report.ts", "export const report = (rows: string[]) => rows.length ? rows.join('\\n') : '(empty)';\n");
  repo.commit("report: say so when there is nothing");
  repo.put("src/format.ts", "export const indent = (t: string) => `  ${t}`;\n");
  repo.commit("format: add indent");

  await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
  await page.evaluate(`window.__kakapoCompareMenu.open()`);
  await h.until(`!document.getElementById('compare-menu').classList.contains('hidden')`);
  const row = await page.evaluate(`(() => {
    const el = document.querySelector('#compare-menu .compare-menu-row[data-mode="since"]');
    return { hidden: el.classList.contains('hidden'), label: el.textContent.replace(/\\s+/g,' ').trim() };
  })()`);
  h.check(row.hidden === false, "after the hand-off the row offers itself", row.label);
  h.check(/2/.test(row.label), "and counts the two commits that arrived", row.label);
  await h.shot("compare-menu");
  await page.key("Escape", "Escape", 27, 0);

  await page.key("Dead", "KeyN", 78, 1);
  await h.until(`Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join() === 'src/format.ts,src/report.ts'`);
  h.check(true, "⌥N shows what arrived since — the handed-off parser work is gone");
  h.check((await pill()).includes(handedOff.slice(0, 7)), "and the pill names the commit it measures from", await pill());
  await h.shot("compare-since");
});
