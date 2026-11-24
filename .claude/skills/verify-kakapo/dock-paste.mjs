import { execFileSync } from "node:child_process";
import { drive, makeRepo } from "./drive.mjs";

// Reported: ⌘F opens the find box and ⌘V pastes nothing into it. The find box is innocent — the hand-off
// dock asks for the application menu's accelerators to be held so its ⌘A selects cards instead of page
// text, and that hold is the whole window's. ⌘V is an Edit-menu accelerator the page implements nowhere,
// so while the dock was open, pasting was dead in every field in the window. The hold now lets go for
// exactly as long as someone is typing in a field, so this drives both halves on one dock with a card in it.
const repo = makeRepo("dockpaste");
repo.put("src/a.ts", "export const alpha = 1;\nexport const beta = 2;\n");
repo.commit("initial");
repo.put("src/a.ts", "export const alpha = 3;\nexport const beta = 2;\n");

const SENTINEL = "beta";
execFileSync("/bin/sh", ["-c", `printf %s ${JSON.stringify(SENTINEL)} | pbcopy`]);

await drive("dockpaste", repo, async (page, h) => {
  h.check(await page.evaluate(`menuChordsHeld`) === false, "nothing holds the menu keys at rest");

  await h.until(`Array.from(document.querySelectorAll('.d2h-code-line-ctn'))
    .filter(e => e.getBoundingClientRect().height > 0).length > 0`);
  await h.click(".d2h-code-line-ctn", 0);
  await page.key("?", "Slash", 191, 8);
  await h.until(`(() => {
    const el = document.activeElement;
    return (el && el.classList && el.classList.contains('mc-input')) ? 'composer' : false;
  })()`);
  for (const ch of "why") await page.char(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0));
  await page.key("Enter", "Enter", 13, 4);
  await h.until(`document.querySelectorAll('.mc-comment-row').length === 1`);

  await page.key("/", "Slash", 191, 12);
  const cards = await h.until(`document.querySelectorAll('#mc-merged-panel .mc-merged-card').length || false`);
  h.check(cards === 1, "the hand-off dock is up with a card in it", String(cards));

  const held = await h.until(`(() => (menuChordsHeld ? 'held' : null))()`, 3000).catch(() => null);
  h.check(held !== null, "with nobody typing, the dock owns ⌘A", String(held));

  // A click anywhere outside the dock lands on its backdrop and closes it, so the focus has to move
  // without one — which is exactly what a reader does by pressing ⌘F while the dock is up.
  await page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  await page.key("f", "KeyF", 70, 4);
  const findOpen = await h.until(`(() => {
    const panel = document.getElementById('file-find');
    return panel && !panel.classList.contains('hidden') ? 'open' : null;
  })()`, 5000);
  h.check(findOpen === "open", "⌘F still opens the find box with the dock up", String(findOpen));

  const released = await h.until(`(() => (!menuChordsHeld ? 'released' : null))()`, 3000).catch(() => null);
  const whileReleased = await page.evaluate(`JSON.stringify({
    dock: !!document.getElementById('mc-merged-panel'),
    active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    holds: menuChordsHeld,
  })`);
  h.check(released === "released" && JSON.parse(whileReleased).dock === true,
    "and with the dock still up, the menu keys are handed back, so ⌘V reaches Paste",
    whileReleased);

  // The Edit menu owns ⌘V, so what a reader's ⌘V runs is the paste command against the focused element.
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86, commands: ["paste"],
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
  });
  const value = await h.until(`(() => {
    const input = document.getElementById('file-find-input');
    return input && input.value ? input.value : null;
  })()`, 4000).catch(() => null);
  h.check(value === SENTINEL, "the clipboard lands in the find box", JSON.stringify(value));

  const counted = await h.until(`(() => {
    const count = document.getElementById('file-find-count');
    return count && /\\d+\\/\\d+/.test(count.textContent) ? count.textContent : null;
  })()`, 4000).catch(() => null);
  h.check(Boolean(counted) && !/^0\//.test(String(counted)), "and is searched for", String(counted));
  await h.shot("dock-open-paste-into-find");

  // Moving the caret back into the code is not typing, so the dock takes its chord back. Escape would have
  // closed the dock as well, which is why the round trip is driven by a click.
  await page.evaluate(`(() => { const i = document.getElementById('file-find-input'); if (i) i.blur(); return true; })()`);
  const backToDock = await h.until(`(() => (menuChordsHeld ? 'held' : null))()`, 3000).catch(() => null);
  h.check(backToDock === "held", "leaving the field gives ⌘A back to the dock",
    await page.evaluate(`JSON.stringify({ dock: !!document.getElementById('mc-merged-panel'), holds: menuChordsHeld })`));
});
