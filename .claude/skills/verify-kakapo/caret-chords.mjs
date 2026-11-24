#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const LINE = "export function recoverableTransfers(rows: string[], limit: number): string[] {";
const repo = makeRepo("caret");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/a.ts", "export const a = 1;\n");
repo.put("src/z.ts", "export const z = 1;\n");
repo.commit("initial");
repo.put("src/a.ts", `${LINE}\n  return rows.slice(0, limit);\n}\n`);
repo.put("src/z.ts", `${LINE}\n  return rows.slice(0, limit);\n}\n`);

await drive("caret", repo, async (page, h) => {
  const sel = () => page.evaluate(`(() => { const s = window.getSelection(); return s ? s.toString() : ''; })()`);
  const seat = async (whichFile) => {
    const idx = await page.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
      const w = all.find(e => e.dataset.path === ${JSON.stringify(whichFile)});
      if (!w) return -1;
      const rows = Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
        .filter(e => e.getBoundingClientRect().height > 0);
      const mine = Array.from(w.querySelectorAll('.d2h-code-line-ctn'))
        .filter(e => /recoverableTransfers/.test(e.textContent) && e.getBoundingClientRect().height > 0);
      return mine.length ? rows.indexOf(mine[0]) : -1;
    })()`);
    if (idx < 0) return false;
    await h.click(".d2h-code-line-ctn", idx);
    return true;
  };
  const filesShown = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).join(',')`);
  const scrollTop = () => page.evaluate(
    `(() => { const e = document.getElementById('diff2html-container'); return e ? Math.round(e.scrollTop) : -1; })()`);

  h.control((await filesShown()) === "src/a.ts,src/z.ts", "two files in the diff, a.ts first", await filesShown());
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0 && /recoverableTransfers/.test(e.textContent)).length > 0`);

  const chords = [
    ["⇧→   extendSelection (declared)", 8],
    ["⇧⌥→  selectByWord", 9],
    ["⌘⇧→  selectToLineEdge", 12],
    ["⌘→   line end          (declared as lineStartEnd)", 4],
    ["⌥→   word jump         (declared as wordJump)", 1],
  ];

  for (const [name, mods] of chords) {
    if (!(await seat("src/a.ts"))) { h.check(false, `${name}: could not seat the caret`); continue; }
    await page.key("ArrowRight", "ArrowRight", 39, mods);
    await h.sleep(300);
    const picked = await sel();
    h.check(true, `${name}  ->  ${picked ? JSON.stringify(picked) : "nothing selected (a move, not a selection)"}`);
  }

  await seat("src/a.ts");
  const activeFile = () => page.evaluate(`(() => {
    const w = document.querySelector('.d2h-file-wrapper.is-active') ||
              document.querySelector('.d2h-file-wrapper[data-active]');
    if (w) return w.dataset.path;
    // No explicit marker: fall back to whichever wrapper the viewport is showing the top of.
    const all = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
    const top = all.find(e => e.getBoundingClientRect().bottom > 80);
    return top ? top.dataset.path : '(none)';
  })()`);
  const wasOn = await activeFile();
  await page.key("ArrowRight", "ArrowRight", 39, 5);
  await h.sleep(700);
  const nowOn = await activeFile();
  h.check(nowOn !== wasOn, "Cmd+Alt+Right still steps to the next file in the diff", `${wasOn} -> ${nowOn}`);
  await h.shot("caret-chords");
});
