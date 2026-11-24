#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const CS = [
  "public class Demo {",
  "  int seed;",
  "  public Demo(int value) {",
  "    Register(handlers, () => { Run(1); });",
  "    Register(handlers, () => { Run(2); });",
  "  }",
  "}",
].join("\n");

const repo = makeRepo("heuristic-definitions");
repo.put("src/Demo.cs", CS + "\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/Demo.cs", CS.replace("Run(2)", "Run(3)") + "\n");

const LABEL = process.env.KAKAPO_VERIFY_LABEL || "after";
const EXPECT_CALLS = process.env.KAKAPO_VERIFY_EXPECT === "calls";

await drive(`heuristic-definitions-${LABEL}`, repo, async (page, h) => {
  const file = "src/Demo.cs";
  await page.evaluate(`window.openSourceFile(${JSON.stringify(file)})`);
  await h.until(`document.querySelectorAll('#source-body .source-row').length > 4`);

  const ask = async (symbol, line, column) => JSON.parse(await page.evaluate(`
    window.kakapoAnalysis.query({ kind: 'definition', symbol: ${JSON.stringify(symbol)},
      path: ${JSON.stringify(file)}, line: ${line}, column: ${column} })
      .then(r => JSON.stringify({ engine: r && r.engine, at: ((r && r.locations) || []).map(l => l.lineIndex + 1) }))`));

  const register = await ask("Register", 0, 2);
  h.control(register.engine === "index",
    "a .cs file has no language server, so this is the index answering on its own", JSON.stringify(register));
  const registerAt = JSON.stringify(register.at);
  h.check(EXPECT_CALLS ? registerAt === "[4,5]" : registerAt === "[]",
    EXPECT_CALLS
      ? "Register is only ever called, and the old index offered both call sites as declarations"
      : "Register is called on lines 4 and 5 and declared nowhere, so no declaration is offered",
    `lines offered: ${registerAt}`);

  const demo = await ask("Demo", 3, 9);
  h.check(JSON.stringify([...demo.at].sort((a, b) => a - b)) === "[1,3]",
    "the class and its constructor are both real declarations and both still found",
    `${JSON.stringify(demo.at)} — nearest the caret first, which is the order the fallback sorts by`);

  await page.evaluate(`window.setSourceCursor(${JSON.stringify(file)}, 3, 4, true, -1)`);
  await page.key("b", "KeyB", 66, 4);
  await h.sleep(250);
  const earlyHint = await page.evaluate(`Array.from(document.querySelectorAll('.mc-caret-hint'))
    .map(e => e.className + ':' + e.textContent.replace(/[\\s]+/g, ' ').trim()).join(' | ')`);
  h.check(true, "what ⌘B says right after the press", earlyHint || "(nothing)");
  await h.sleep(450);

  const seen = JSON.parse(await page.evaluate(`(() => {
    const panel = document.getElementById('semantic-peek');
    const open = Boolean(panel) && !panel.classList.contains('hidden');
    const rows = Array.from(document.querySelectorAll('#semantic-peek-results .semantic-peek-item'))
      .map(e => e.getAttribute('title'));
    const meta = (document.getElementById('semantic-peek-meta') || { textContent: '' }).textContent.trim();
    const title = (document.getElementById('semantic-peek-title') || { textContent: '' }).textContent.replace(/\\s+/g, ' ').trim();
    const hint = Array.from(document.querySelectorAll('.mc-caret-hint.show, .mc-toast'))
      .map(e => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ');
    return JSON.stringify({ open, rows, meta, title, hint });
  })()`));
  h.check(EXPECT_CALLS ? seen.rows.length === 2 : seen.rows.length === 0,
    EXPECT_CALLS
      ? "⌘B listed the two call sites as if they were declarations"
      : "⌘B offers no list of call sites, and says instead that there is nothing to go to",
    `open=${seen.open} title=${seen.title} rows=${JSON.stringify(seen.rows)} meta=${seen.meta} hint=${seen.hint}`);
  await h.shot(`cmd-b-on-a-call-${LABEL}`);
});
