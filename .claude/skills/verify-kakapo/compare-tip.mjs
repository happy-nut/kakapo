#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("comparetip");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/a.ts", "export const a = 1;\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/a.ts", "export const a = 2;\n");
repo.put("src/b.ts", "export const b = 1;\n");
repo.commit("agent: two files");

await drive("comparetip", repo, async (page, h) => {
  const ticked = async () => {
    await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
    return page.evaluate(`window.kakapoGit.compareMenu().then(d => d ? d.mode : '(none)')`);
  };
  const pill = () => page.evaluate(
    `document.querySelector('.compare-refs') ? document.querySelector('.compare-refs').textContent.replace(/\\s+/g,' ').trim() : ''`);
  const files = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join(',')`);

  await page.key("Dead", "KeyA", 65, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 2`);
  h.control((await ticked()) === "all", "⌥A: the menu says all", await pill());

  await page.key("Dead", "KeyT", 84, 1);
  await h.sleep(900);
  h.check((await ticked()) === "tip", "⌥T: the menu says tip", await pill());

  await page.evaluate(`window.kakapoGit.setReviewBase('auto')`);
  await h.sleep(1200);
  const after = await ticked();
  h.check(after === "all",
    "and going back to the bar's \"All\" leaves the menu saying all, not tip", `${after} — ${await pill()}`);
  h.check((await files()) === "src/a.ts,src/b.ts", "with the branch's two files on screen", await files());
  await h.shot("compare-tip-after-all");

  await page.key("Dead", "KeyT", 84, 1);
  await h.sleep(900);
  h.check((await ticked()) === "tip", "back in tip mode");
  await page.evaluate(`window.kakapoGit.setReviewTarget('worktree')`);
  await h.sleep(1200);
  const kept = await ticked();
  h.check(kept === "tip",
    "and a target change, which does not touch the base, leaves tip mode in force", kept);
  await h.shot("compare-tip-kept");
});
