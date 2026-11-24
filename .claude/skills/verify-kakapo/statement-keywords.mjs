import { drive, makeRepo } from "./drive.mjs";

const GATE = "src/Gate.cs";
const MUTEX = "src/Mutex.ts";

const repo = makeRepo("statement-keywords");
repo.put(GATE, [
  "class Gate {",
  "  void Hold() {",
  "    lock (gate) { Work(); }",
  "    foreach (var x in items) { Use(x); }",
  "  }",
  "}",
].join("\n") + "\n");
repo.put(MUTEX, ["export class Mutex {", "  lock(resource) {", "    return resource;", "  }", "}"].join("\n") + "\n");
repo.commit("initial");
repo.put(MUTEX, ["export class Mutex {", "  lock(resource) {", "    return resource;", "  }", "  release() { }", "}"].join("\n") + "\n");
repo.put(GATE, [
  "class Gate {",
  "  void Hold() {",
  "    lock (gate) { Work(); Audit(); }",
  "    foreach (var x in items) { Use(x); }",
  "  }",
  "}",
].join("\n") + "\n");

await drive("statement-keywords", repo, async (page, h) => {
  await h.until(`(typeof window.kakapoAnalysis !== 'undefined') ? true : null`, 30000);

  const ask = (symbol) => page.evaluate(`(async () => {
    const answer = await window.kakapoAnalysis.query({ kind: 'definition', path: ${JSON.stringify(GATE)}, symbol: ${JSON.stringify(symbol)} });
    return { ok: Boolean(answer && answer.ok), engine: answer && answer.engine, locations: ((answer && answer.locations) || []).map((t) => t.path + ':' + (t.lineIndex + 1)) };
  })()`);

  const control = await ask("Hold");
  h.control(control.locations.some((at) => at === `${GATE}:2`),
    "the window answers a definition question from the index at all, so an empty answer below means something",
    JSON.stringify(control));

  for (const keyword of ["lock", "foreach"]) {
    const answer = await ask(keyword);
    h.check(!answer.locations.some((at) => at.startsWith(GATE)),
      `${keyword} heads a statement in the C# file, so the window offers no declaration of it there`,
      JSON.stringify(answer));
  }

  await page.evaluate(`(async () => { await window.openSourceFile(${JSON.stringify(MUTEX)}); })()`);
  await h.until(`(window.sourceOpenPath && window.sourceOpenPath() === ${JSON.stringify(MUTEX)}) ? true : null`, 20000);

  const renderer = await page.evaluate(`(() => {
    const found = window.findSymbolDefinition('lock');
    return found ? { path: found.path, line: found.lineIndex + 1 } : null;
  })()`);
  h.check(renderer && renderer.path === MUTEX && renderer.line === 2,
    "the renderer still finds the TypeScript method named lock, so the guard is scoped to the language",
    JSON.stringify(renderer));

  await page.evaluate(`(async () => { await window.openSourceFile(${JSON.stringify(GATE)}); })()`);
  await h.until(`(window.sourceOpenPath && window.sourceOpenPath() === ${JSON.stringify(GATE)}) ? true : null`, 20000);

  const onGate = await page.evaluate(`(() => {
    const answer = {};
    for (const name of ['lock', 'foreach', 'Hold']) {
      const found = window.findSymbolDefinition(name);
      answer[name] = found ? found.path + ':' + (found.lineIndex + 1) : null;
    }
    return answer;
  })()`);
  h.check(onGate.Hold === `${GATE}:2`,
    "with the C# file open the renderer scans it first, so an empty answer for a keyword means something",
    JSON.stringify(onGate));
  h.check(onGate.lock !== `${GATE}:3` && onGate.foreach === null,
    "and it refuses the statement keywords there, where the index is not the one answering",
    JSON.stringify(onGate));

  await h.shot("statement-keywords");
});
