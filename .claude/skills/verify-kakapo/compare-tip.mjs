#!/usr/bin/env node
// CMP-3/CMP-7: the compare menu ticks the row the diff was actually built from.
//
//   node .claude/skills/verify-kakapo/compare-tip.mjs
//
// Walks the counterexample .claude/skills/formal-compare-mode found — ⌥A, ⌥T, then the patch-set bar's
// "All" option — and asks the menu what it thinks after each step. The model proves this over every
// sequence; this proves the model is about THIS app.
import { drive, makeRepo } from "./drive.mjs";

// A clean worktree with commits ahead: the only shape where this failed, and the shape this product is
// for — the agent committed its work and stopped.
const repo = makeRepo("comparetip");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/a.ts", "export const a = 1;\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/a.ts", "export const a = 2;\n");
repo.put("src/b.ts", "export const b = 1;\n");
repo.commit("agent: two files");

await drive("comparetip", repo, async (page, h) => {
  // Which row the menu ticks, asked of the menu itself.
  const ticked = async () => {
    await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
    return page.evaluate(`window.kakapoGit.compareMenu().then(d => d ? d.mode : '(none)')`);
  };
  const pill = () => page.evaluate(
    `document.querySelector('.compare-refs') ? document.querySelector('.compare-refs').textContent.replace(/\\s+/g,' ').trim() : ''`);
  const files = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join(',')`);

  await page.key("Dead", "KeyA", 65, 1);                       // ⌥A — all changes
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 2`);
  h.check((await ticked()) === "all", "⌥A: the menu says all", await pill());

  await page.key("Dead", "KeyT", 84, 1);                       // ⌥T — the ref's tip
  await h.sleep(900);
  h.check((await ticked()) === "tip", "⌥T: the menu says tip", await pill());

  // The patch-set bar's "All" option — kakapo:set-review-base with "auto". This is step 4 of the
  // counterexample: it puts the base back on the automatic resolution.
  await page.evaluate(`window.kakapoGit.setReviewBase('auto')`);
  await h.sleep(1200);
  const after = await ticked();
  h.check(after === "all",
    "and going back to the bar's \"All\" leaves the menu saying all, not tip", `${after} — ${await pill()}`);
  h.check((await files()) === "src/a.ts,src/b.ts", "with the branch's two files on screen", await files());
  await h.shot("compare-tip-after-all");

  // The half the model refuted: set-review-target does NOT move the base, so tip mode survives it.
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
