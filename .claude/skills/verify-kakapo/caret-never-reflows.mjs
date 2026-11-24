import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("clickwrap");
const lines = [];
for (let width = 56; width <= 104; width += 4) {
  lines.push("    " + ".x".repeat(Math.max(1, Math.floor((width - 4) / 2))) + " // w" + width);
}
repo.put("src/Fit.kt", `class Fit {\n${lines.join("\n")}\n}\n`);
repo.commit("initial");
repo.put("src/Fit.kt", `class Fit2 {\n${lines.join("\n")}\n}\n`);

const HEIGHTS = `(() => {
  const pane = document.querySelectorAll('.d2h-file-wrapper .d2h-file-side-diff')[0];
  const rows = Array.from(pane.querySelectorAll('tr')).filter((r) => r.querySelector('.d2h-code-line-ctn'));
  return JSON.stringify(rows.map((r) => {
    const cell = r.querySelector('.d2h-code-line-ctn');
    const lh = parseFloat(getComputedStyle(cell).lineHeight) || 20;
    return { text: (cell.textContent || '').slice(-5), lines: Math.round(cell.getBoundingClientRect().height / lh) };
  }));
})()`;

await drive("clickwrap", repo, async (page, h) => {
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  const before = JSON.parse(await page.evaluate(HEIGHTS));
  h.control(before.length > 5, "the base pane drew the ladder of line lengths", `${before.length} rows`);
  const single = before.filter((row) => row.lines === 1).length;
  h.control(single > 0, "and some of them fit on one visual line", JSON.stringify(before));

  for (let index = 0; index < Math.min(before.length, 14); index += 1) {
    await h.click(".d2h-file-side-diff .d2h-code-line-ctn", index);
  }
  const after = JSON.parse(await page.evaluate(HEIGHTS));
  const changed = before
    .map((row, index) => ({ text: row.text, from: row.lines, to: after[index] ? after[index].lines : null }))
    .filter((row) => row.from !== row.to);
  h.check(changed.length === 0, "clicking a line never changes how many rows it takes", JSON.stringify(changed));
  await h.shot("after-clicks");
});
