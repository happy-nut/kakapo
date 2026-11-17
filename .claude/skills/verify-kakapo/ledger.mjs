#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("ledger");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/parser.ts", "export function parse(t: string): string[] {\n  return t.split(',');\n}\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");

repo.put("src/parser.ts", "export function parse(t: string): string[] {\n  return t.split(',').map((p) => p.trim());\n}\n");
const one = repo.commit("parser: trim each field");

repo.put("src/report.ts", "export const report = (rows: string[]) => rows.join('\\n');\n");
repo.put("src/format.ts", "export const indent = (t: string) => `  ${t}`;\n");
const two = repo.commit("report: add report and indent");

repo.put("src/parser.ts", "export function parse(t: string): string[] {\n  if (!t) return [];\n  return t.split(',').map((p) => p.trim());\n}\n");
const three = repo.commit("parser: empty input is an empty list");

await drive("ledger", repo, async (page, h) => {
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('#patchset-ledger .patchset-ledger-row'))
    .map(r => ({ ref: r.dataset.ref,
                 num: r.querySelector('.patchset-ledger-num').textContent.trim(),
                 subject: r.querySelector('.patchset-ledger-subject').textContent.trim(),
                 stat: r.querySelector('.patchset-ledger-stat').textContent.replace(/\\s+/g,' ').trim(),
                 read: r.classList.contains('is-read'),
                 unread: r.classList.contains('is-unread'),
                 active: r.classList.contains('active') }))`);

  h.check(await page.evaluate(`!document.getElementById('patchset-bar').classList.contains('hidden')`),
    "the patch-set bar is showing");
  h.check(await page.evaluate(`document.getElementById('patchset-ledger').classList.contains('hidden')`),
    "and the ledger starts closed");

  await h.click("#patchset-ledger-btn");
  await h.until(`!document.getElementById('patchset-ledger').classList.contains('hidden')
    && document.querySelectorAll('#patchset-ledger .patchset-ledger-row').length > 1`);
  const list = await rows();

  const sets = list.filter((r) => r.num);
  h.check(sets.length === 3, "the ledger lists one row per patch set", JSON.stringify(sets.map((r) => r.num)));
  h.check(sets[0].subject === "parser: trim each field" && sets[2].subject === "parser: empty input is an empty list",
    "oldest first, each named by its subject", sets.map((r) => r.subject).join(" | "));
  h.check(list.some((r) => r.ref === "auto"), "with the \"all changes\" exit above them");

  h.check(/1.*\+1.*1/.test(sets[0].stat), "patch set 1 says one file, one line each way", sets[0].stat);
  h.check(/2.*\+2.*0/.test(sets[1].stat), "patch set 2 says two files and no deletions", sets[1].stat);
  h.check(sets[0].stat !== sets[1].stat, "and two patch sets that did different things do not read the same");

  h.check(!sets.some((r) => r.read || r.unread), "before any hand-off no row claims to be read or unread");
  await h.shot("ledger-open");

  const before = (await page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join(',')`));
  await h.click(".patchset-ledger-row[data-ref='" + two + "']");
  await h.until(`document.getElementById('patchset-ledger').classList.contains('hidden')`);
  const shown = await h.until(`(() => {
    const files = Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join(',');
    return (files && files !== ${JSON.stringify(before)}) ? files : false;
  })()`);
  h.check(shown === "src/parser.ts", "picking a row sets the base — only what came after patch set 2 is left", shown);
  await h.shot("ledger-picked");

  await page.key("Dead", "KeyA", 65, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 3`);
  await page.key("/", "Slash", 191, 12);
  await h.until(`!!document.getElementById('mc-merged-panel')`);
  await page.key("a", "KeyA", 65, 4);
  await page.key("c", "KeyC", 67, 4);
  await h.until(`!document.getElementById('mc-merged-panel')
    || !document.querySelector('#mc-merged-panel .mc-merged-card')`);

  repo.put("src/report.ts", "export const report = (rows: string[]) => rows.length ? rows.join('\\n') : '(empty)';\n");
  const four = repo.commit("report: say so when there is nothing");
  void three;

  await h.click("#patchset-ledger-btn");
  await h.until(`Array.from(document.querySelectorAll('#patchset-ledger .patchset-ledger-row'))
    .some(r => r.classList.contains('is-unread'))`);
  const after = await rows();
  const afterSets = after.filter((r) => r.num);
  h.check(afterSets.length === 4, "the new commit is in the list", String(afterSets.length));
  h.check(afterSets.slice(0, 3).every((r) => r.read), "everything up to the hand-off is marked read",
    JSON.stringify(afterSets.map((r) => (r.read ? "read" : r.unread ? "unread" : "-"))));
  h.check(afterSets[3].unread && afterSets[3].ref === four, "and only what arrived after it is marked unread");
  await h.shot("ledger-unread");

  const focused = await h.until(`(() => {
    const el = document.activeElement;
    return (el && el.classList && el.classList.contains('patchset-ledger-row'))
      ? (el.className || 'row') : false;
  })()`);
  h.check(Boolean(focused), "a ledger row holds the keyboard while it is open", focused);
  await page.key("Escape", "Escape", 27, 0);
  h.check(await page.evaluate(`document.getElementById('patchset-ledger').classList.contains('hidden')`),
    "Esc closes the ledger");
  h.check(await page.evaluate(`document.activeElement && document.activeElement.id === 'patchset-ledger-btn'`),
    "and the focus goes back to the control that opened it");
});
