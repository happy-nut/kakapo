#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const CS = [
  "public class Runner {",
  "  void Run(int which) {",
  "    Register(handlers, options);",
  "  }",
  "  private static async Task<int> FetchAsync(string url) {",
  "    return 0;",
  "  }",
  "  public void Start() {",
  "    Run(1);",
  "  }",
  "}",
].join("\n");

const repo = makeRepo("return-type-methods");
repo.put("src/Runner.cs", CS + "\n");
repo.commit("initial");
repo.git("checkout", "-qb", "agent/work");
repo.put("src/Runner.cs", CS.replace("Run(1)", "Run(2)") + "\n");

const LABEL = process.env.KAKAPO_VERIFY_LABEL || "after";
const EXPECT_MISSING = process.env.KAKAPO_VERIFY_EXPECT === "missing";

await drive(`return-type-methods-${LABEL}`, repo, async (page, h) => {
  const file = "src/Runner.cs";
  await page.evaluate(`window.openSourceFile(${JSON.stringify(file)})`);
  await h.until(`document.querySelectorAll('#source-body .source-row').length > 4`);

  const ask = async (symbol, line, column) => JSON.parse(await page.evaluate(`
    window.kakapoAnalysis.query({ kind: 'definition', symbol: ${JSON.stringify(symbol)},
      path: ${JSON.stringify(file)}, line: ${line}, column: ${column} })
      .then(r => JSON.stringify({ engine: r && r.engine, at: ((r && r.locations) || []).map(l => l.lineIndex + 1) }))`));

  const run = await ask("Run", 8, 4);
  h.check(run.engine === "index",
    "a .cs file has no language server, so this is the index answering on its own", JSON.stringify(run));
  h.check(EXPECT_MISSING ? JSON.stringify(run.at) === "[]" : JSON.stringify(run.at) === "[2]",
    EXPECT_MISSING
      ? "the index never read `void Run(int which) {`, so it had nothing to offer"
      : "`void Run(int which) {` on line 2 is the declaration Run is called from",
    `lines offered: ${JSON.stringify(run.at)}`);

  const fetchAsync = await ask("FetchAsync", 4, 36);
  h.check(EXPECT_MISSING ? JSON.stringify(fetchAsync.at) === "[]" : JSON.stringify(fetchAsync.at) === "[5]",
    "a generic return type behind several modifiers is read the same way",
    `lines offered: ${JSON.stringify(fetchAsync.at)}`);

  const register = await ask("Register", 2, 4);
  h.check(JSON.stringify(register.at) === "[]",
    "Register is called on line 3 and declared nowhere, so no declaration is offered",
    `lines offered: ${JSON.stringify(register.at)}`);

  const renderer = JSON.parse(await page.evaluate(`JSON.stringify({
    run: window.findSymbolDefinition('Run'),
    fetchAsync: window.findSymbolDefinition('FetchAsync'),
    register: window.findSymbolDefinition('Register'),
  })`));
  h.check(EXPECT_MISSING ? renderer.run === null : (renderer.run && renderer.run.lineIndex === 1),
    "the renderer scans the file itself when the index declines, and holds the second copy of this table",
    `run=${JSON.stringify(renderer.run)} fetchAsync=${JSON.stringify(renderer.fetchAsync)}`);
  h.check(renderer.register === null,
    "and the renderer does not answer a call either, which would arrive as a silent jump",
    `register=${JSON.stringify(renderer.register)}`);

  await page.evaluate(`window.setSourceCursor(${JSON.stringify(file)}, 8, 4, true, -1)`);
  await page.key("b", "KeyB", 66, 4);
  await h.sleep(700);
  const where = JSON.parse(await page.evaluate(`(() => {
    const row = document.querySelector('#source-body .source-row.cursor-line');
    const at = row ? Number(row.getAttribute('data-line-index')) + 1 : 0;
    const hint = Array.from(document.querySelectorAll('.mc-caret-hint.show, .mc-toast'))
      .map(e => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ');
    return JSON.stringify({ line: String(at), hint });
  })()`));
  h.check(EXPECT_MISSING ? where.line !== "2" : where.line === "2",
    EXPECT_MISSING
      ? "⌘B on the call had nowhere to go"
      : "⌘B on the call moved the caret to the declaration on line 2",
    `caret on line ${where.line} hint=${where.hint}`);
  await h.shot(`cmd-b-to-a-return-type-method-${LABEL}`);
});
