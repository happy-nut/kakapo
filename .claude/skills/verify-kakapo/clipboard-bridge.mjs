import { execFileSync } from "node:child_process";
import { drive, makeRepo } from "./drive.mjs";
const repo = makeRepo("clipproof");
repo.put("src/a.ts", "export const a = 1;\n");
repo.commit("initial");
repo.put("src/a.ts", "export const a = 2;\n");
const SENTINEL = "kakapo-clipboard-sentinel-" + Date.now();
execFileSync("/bin/sh", ["-c", `printf %s ${JSON.stringify(SENTINEL)} | pbcopy`]);
await drive("clipproof", repo, async (page, h) => {
  const outside = execFileSync("pbpaste", { encoding: "utf8" });
  h.check(outside === SENTINEL, "the system clipboard holds a value this probe put there", JSON.stringify(outside));

  const read = await page.evaluate(`window.kakapoClipboard.read()`);
  h.check(read === SENTINEL,
    "kakapoClipboard.read() returns what the system clipboard holds",
    `got ${JSON.stringify(read)}, system holds ${JSON.stringify(SENTINEL)}`);

  const wrote = await page.evaluate(`(() => {
    try { window.kakapoClipboard.write('kakapo-written-by-the-bridge'); return 'returned'; }
    catch (e) { return 'threw: ' + e.message; }
  })()`);
  h.check(wrote === "returned", "kakapoClipboard.write() does not throw", wrote);
  const after = execFileSync("pbpaste", { encoding: "utf8" });
  h.check(after === "kakapo-written-by-the-bridge",
    "and the system clipboard now holds what it wrote", JSON.stringify(after));
});
