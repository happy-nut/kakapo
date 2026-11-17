#!/usr/bin/env node
// The worked example: copy this, change the fixture and the checks.
//
//   node .claude/skills/verify-kakapo/example.mjs
//
// It drives OPEN-1 and CMP-1/2/4/7 from the feature map — a review opens on the right work, each compare
// mode answers with a different set of files, and "since you last read" appears only once a hand-off has
// left a mark. Everything here is a key or a click a reviewer makes, never the function behind it.
import { drive, makeRepo } from "./drive.mjs";

// An agent's worktree, one working day in: a branch with work on it, and an uncommitted edit on top.
const repo = makeRepo("example");
repo.put("package.json", JSON.stringify({ name: "demo", private: true }));
repo.put("src/parser.ts", "export function parse(text: string): string[] {\n  return text.split(',');\n}\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/parser.ts", "export function parse(text: string): string[] {\n  return text.split(',').map((p) => p.trim());\n}\n");
const handedOff = repo.commit("parser: trim each field");
repo.put("src/report.ts", "export const report = (rows: string[]) => rows.join('\\n');\n"); // uncommitted

await drive("example", repo, async (page, h) => {
  const shown = () => page.evaluate(
    `Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).filter(Boolean).sort()`);
  const pill = () => page.evaluate(
    `document.querySelector('.compare-refs') ? document.querySelector('.compare-refs').textContent.replace(/\\s+/g,' ').trim() : ''`);

  // OPEN-1 — the automatic base refuses a dirty worktree (resolveAutomaticReviewBase returns undefined
  // the moment `git status` says anything), so a review opened with uncommitted work in the tree starts
  // on exactly that work. Not a narrower answer than it could give — it is the one you want when you
  // have edits of your own on top of what the agent committed.
  const opened = await shown();
  h.check(JSON.stringify(opened) === JSON.stringify(["src/report.ts"]),
    "a dirty worktree opens on the uncommitted work", JSON.stringify(opened));
  const listed = await page.evaluate(`document.querySelectorAll('#changes-panel .file-link').length`);
  h.check(listed === opened.length, "and the Changes list says the same thing as the diff", listed);
  await h.shot("open-review");

  // CMP-1 — ⌥A widens to everything on the branch: the agent's commit as well as the dirty file.
  await page.key("Dead", "KeyA", 65, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 2`);
  h.check(JSON.stringify(await shown()) === JSON.stringify(["src/parser.ts", "src/report.ts"]),
    "⌥A widens to everything the branch changed", JSON.stringify(await shown()));

  // CMP-2 — ⌥U narrows back to what is not committed yet.
  await page.key("Dead", "KeyU", 85, 1);
  await h.until(`document.querySelectorAll('.d2h-file-wrapper').length === 1`);
  h.check(JSON.stringify(await shown()) === JSON.stringify(["src/report.ts"]),
    "⌥U narrows to the uncommitted edit alone", JSON.stringify(await shown()));

  // CMP-4 — before a hand-off there is no read mark, so the row must not be offered and the key must
  // say so rather than silently doing nothing.
  await page.evaluate(`window.__kakapoCompareMenu.refresh()`);
  await page.evaluate(`window.__kakapoCompareMenu.open()`);
  await h.until(`!document.getElementById('compare-menu').classList.contains('hidden')`);
  h.check(await page.evaluate(
    `document.querySelector('#compare-menu .compare-menu-row[data-mode="since"]').classList.contains('hidden')`),
    "with nothing handed over, the \"since you last read\" row hides itself");
  await page.key("Escape", "Escape", 27, 0);

  // CMT-1 — a real comment, written the way a reviewer writes one: caret on a line (there is no keyboard
  // route to a CHOSEN line, so click it), `?`, type, ⌘Enter. A hand-off of an empty panel would still set
  // the read mark, so handing over nothing would prove the mark and not the review.
  await page.key("Dead", "KeyA", 65, 1);                        // back to the branch, so there is code to read
  // Wait on a code line that is actually DRAWN. Counting matches instead would be satisfied by the
  // previous mode's DOM, or by placeholder rows the diff has not painted yet.
  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  await h.click(".d2h-code-line-ctn", 0);
  await page.key("?", "Slash", 191, 8);                         // Shift is folded into the key for `?`
  // Wait for the textarea to actually HOLD the keyboard, not merely to exist. Electron restores focus to
  // <body> after the keydown, so 07-comments.js retries focus on a 25ms interval; typing before it wins
  // sends the characters nowhere, and the save then refuses a box that still holds only its prefill.
  const prefill = await h.until(`(() => {
    const el = document.activeElement;
    return (el && el.classList && el.classList.contains('mc-input')) ? (el.value || '(empty)') : false;
  })()`);
  h.check(/^@\S+#L\d+/.test(prefill), "the composer opens focused and prefilled with the line it is about", prefill);
  for (const ch of "why") await page.char(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0));
  await page.key("Enter", "Enter", 13, 4);                      // ⌘Enter saves
  await h.until(`document.querySelectorAll('.mc-comment-row').length === 1`);
  // The record is written through the main process, so it lands a beat after the comment is drawn. Poll
  // rather than read once — and poll the RECORD, because a comment that renders is not a comment that
  // was saved, and that is the half this check exists for.
  const stored = await h.until(`window.kakapoComments.read().then(r => r.records.length || false)`);
  h.check(stored === 1, "and the comment was written to the workspace record, not just drawn", stored);
  await h.shot("comment-on-a-line");

  // CMT-4/CMT-5 — hand it over: open the document, select all, copy. Copying IS the hand-off.
  await page.key("/", "Slash", 191, 12);                        // ⌘⇧/
  const cards = await h.until(`document.querySelectorAll('#mc-merged-panel .mc-merged-card').length || false`);
  h.check(cards === 1, "the hand-off document holds the comment", cards);
  await h.shot("hand-off-panel");
  await page.key("a", "KeyA", 65, 4);
  await page.key("c", "KeyC", 67, 4);
  // Asserted against a review that HAD something in it — an empty panel also reports "none left", and a
  // hand-off of nothing still records a read mark, so this check is vacuous without the card count above.
  const after = await h.until(`window.kakapoComments.read().then(r =>
    (r.records.length && r.records.every(c => c.archivedAt))
      ? ('archived:' + r.records.length) : false)`);
  h.check(after === "archived:1", "and handing it over moved it to the archive — still on disk, out of the review", after);

  // The agent works while the reviewer is away.
  repo.put("src/report.ts", "export const report = (rows: string[]) => rows.length ? rows.join('\\n') : '(empty)';\n");
  repo.commit("report: say so when there is nothing");
  repo.put("src/format.ts", "export const indent = (t: string) => `  ${t}`;\n");
  repo.commit("format: add indent");

  // CMP-7 — the row is offered now, and says how much arrived.
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

  // CMP-4 — ⌥N shows exactly those two commits' files, and the pill names the mark.
  await page.key("Dead", "KeyN", 78, 1);
  await h.until(`Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(e => e.dataset.path).sort().join() === 'src/format.ts,src/report.ts'`);
  h.check(true, "⌥N shows what arrived since — the handed-off parser work is gone");
  h.check((await pill()).includes(handedOff.slice(0, 7)), "and the pill names the commit it measures from", await pill());
  await h.shot("compare-since");
});
