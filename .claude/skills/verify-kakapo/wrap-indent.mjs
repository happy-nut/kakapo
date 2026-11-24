import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("wrapindent");
const long = "            .incrementer(RunIdIncrementer()).start(myKakaoOrganizationSynchronizationStep).next(helloMisEmployeeSynchronizationStep)";
repo.put("src/Config.kt", `class Config {\n    fun job(): Job {\n        return builder\n${long}\n            .build()\n    }\n}\n`);
repo.commit("initial");
repo.put("src/Config.kt", `class Config {\n    fun job(): Job {\n        return builder2\n${long}\n            .build()\n    }\n}\n`);

const ROW = `(() => {
  const pane = document.querySelectorAll('.d2h-file-wrapper .d2h-file-side-diff')[0];
  const rows = Array.from(pane.querySelectorAll('tr')).filter((r) => r.querySelector('.d2h-code-line-ctn'));
  const cell = rows.find((r) => /incrementer/.test(r.textContent)).querySelector('.d2h-code-line-ctn');
  const style = getComputedStyle(cell);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  return JSON.stringify({
    wrapped: Math.round(cell.getBoundingClientRect().height / lineHeight),
    paddingLeft: style.paddingLeft,
    textIndent: style.textIndent,
    leading: (cell.textContent.match(/^\\s*/) || [""])[0].length,
  });
})()`;

const VISUAL_LINES = `(() => {
  const pane = document.querySelectorAll('.d2h-file-wrapper .d2h-file-side-diff')[0];
  const rows = Array.from(pane.querySelectorAll('tr')).filter((r) => r.querySelector('.d2h-code-line-ctn'));
  const cell = rows.find((r) => /incrementer/.test(r.textContent)).querySelector('.d2h-code-line-ctn');
  const range = document.createRange();
  range.selectNodeContents(cell);
  const lines = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0) continue;
    const top = Math.round(rect.top);
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.top - top) > 3) lines.push({ top, left: Math.round(rect.left) });
    else last.left = Math.min(last.left, Math.round(rect.left));
  }
  return JSON.stringify(lines);
})()`;

await drive("wrapindent", repo, async (page, h) => {
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  const row = JSON.parse(await page.evaluate(ROW));
  h.control(row.leading === 12, "the long line carries its 12 spaces of indent", JSON.stringify(row));
  h.check(row.wrapped > 1, "and the diff wraps it, as it wraps by default", `${row.wrapped} visual lines`);

  const lines = JSON.parse(await page.evaluate(VISUAL_LINES));
  h.check(lines.length > 1, "the line is drawn on more than one row", JSON.stringify(lines));
  h.check(lines.length > 1 && lines[1].left > lines[0].left,
    "and a continuation keeps the line's indent instead of starting at the pane's edge",
    JSON.stringify(lines));
  await h.shot("wrapped-line");
});
