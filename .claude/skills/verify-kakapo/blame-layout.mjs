import { drive, makeRepo } from "./drive.mjs";

// Turning the author column on must widen each pane's gutter and move nothing else. It is measured as
// geometry, because the defect it guards looked like "everything is centred" and no alignment property
// had changed: the left pane's row is [code, number], mirrored so the bare line numbers meet in the spine,
// and a 164px author column there put two walls of dates in the middle of the window with the code pushed
// to the outer edges. jsdom lays nothing out, so only the real app can answer this.
const repo = makeRepo("blamelayout");
repo.put("src/a.ts", "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n");
repo.commit("initial");
repo.put("src/a.ts", "export function alpha() {\n  return 11;\n}\nexport function beta() {\n  return 2;\n}\nexport function gamma() {\n  return 3;\n}\n");

const GEOMETRY = `(() => {
  const wrapper = document.querySelector('.d2h-file-wrapper');
  const sides = Array.from(wrapper.querySelectorAll('.d2h-file-side-diff'));
  const read = (side) => {
    const row = Array.from(side.querySelectorAll('tr')).find((r) => r.querySelector('.d2h-code-line-ctn'));
    const code = row.querySelector('.d2h-code-line-ctn');
    const layer = side.querySelector('.mc-diff-gutter-layer');
    const box = side.getBoundingClientRect();
    return {
      sideLeft: Math.round(box.left),
      sideRight: Math.round(box.right),
      codeLeft: Math.round(code.getBoundingClientRect().left),
      gutterLeft: layer ? Math.round(layer.getBoundingClientRect().left) : null,
      gutterRight: layer ? Math.round(layer.getBoundingClientRect().right) : null,
      align: getComputedStyle(code).textAlign,
    };
  };
  return JSON.stringify({ left: read(sides[0]), right: read(sides[sides.length - 1]) });
})()`;

await drive("blamelayout", repo, async (page, h) => {
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  const before = JSON.parse(await page.evaluate(GEOMETRY));
  await h.shot("before-author");

  const path = await page.evaluate(`(() => {
    const wrapper = document.querySelector('.d2h-file-wrapper');
    showDiffBlame(wrapper.dataset.path);
    return wrapper.dataset.path;
  })()`);
  const painted = await h.until(`(() => {
    const wrapper = document.querySelector('.d2h-file-wrapper');
    return wrapper && wrapper.classList.contains('mc-diff-blame-visible') ? 'painted' : null;
  })()`, 20000);
  h.check(painted === "painted", `the author column paints for ${path}`, String(painted));

  const after = JSON.parse(await page.evaluate(GEOMETRY));
  await h.shot("after-author");

  for (const side of ["left", "right"]) {
    h.check(after[side].align === before[side].align,
      `the ${side} pane's code keeps the alignment it had`,
      `${before[side].align} -> ${after[side].align}`);
    h.check(Math.abs(after[side].gutterLeft - after[side].sideLeft) <= 2,
      `the ${side} pane's gutter sits at its own left edge, not in the spine`,
      `gutter ${after[side].gutterLeft} vs pane ${after[side].sideLeft}`);
    h.check(after[side].codeLeft >= after[side].gutterRight - 2,
      `the ${side} pane's code starts after its gutter, not under it`,
      `code ${after[side].codeLeft} vs gutter ends ${after[side].gutterRight}`);
    h.check(after[side].codeLeft > before[side].codeLeft,
      `the ${side} pane's code moved right by the width the gutter gained`,
      `${before[side].codeLeft} -> ${after[side].codeLeft}`);
  }
});
