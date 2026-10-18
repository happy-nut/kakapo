// What a failed jump SAYS. Following code is only easy if a dead end tells you which dead end it is: a
// symbol that genuinely has no definition is a different situation from a language server that has not
// finished reading the project, and the second one is worth waiting a second and pressing the key again.
//
// The analysis response already carries that distinction (`engine`, `fallbackReason`); the message the
// reviewer gets at the caret — where they are actually looking — used to throw it away and say
// "Definition not found" either way. A cold server is not hypothetical: it took a release down.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
const FILE = "src/app.ts";

before(async () => {
  const base = "export function helper() { return 1; }\nexport const used = helper();\n";
  ({ html } = await makeReviewHtml([{ path: FILE, before: base, after: base + "const extra = used;\n" }]));
});

after(cleanupFixtures);

// Stands in for main's analysis bridge with whatever answer the test is about.
function installAnalysis(v, response) {
  v.window.kakapoAnalysis = {
    query: () => Promise.resolve(Object.assign({ ok: true, generation: 0, locations: [] }, response)),
    diagnostics: () => Promise.resolve({ ok: true, generation: 0, diagnostics: [] }),
    status: () => Promise.resolve({ phase: "ready", generation: 0 }),
    onStatus: () => {},
  };
}

const hintText = (v) => {
  const hint = v.$(".mc-caret-hint") || v.$("[class*='caret-hint']");
  return hint ? (hint.textContent || "").trim() : "";
};

async function jump(v) {
  await v.openSourceFile(FILE);
  await v.clickSourceLine(1);
  v.key("ArrowDown", { metaKey: true, code: "ArrowDown" });
  await v.settle(60);
}

test("a server that has not finished reading the project does not report a missing definition", async () => {
  const v = await loadViewer(html);
  try {
    // The shape of a cold server: the query succeeded, nothing came back, and the engine says it answered
    // from the regex index because the language server could not.
    installAnalysis(v, { engine: "index", confidence: "heuristic", locations: [], fallbackReason: "typescript-language-server timed out during textDocument/definition" });
    await jump(v);

    const message = hintText(v);
    assert.ok(message, "something is said at the caret");
    assert.doesNotMatch(
      message,
      /찾지 못했|not found/i,
      `a cold server must not read as "no such definition" (got: ${message})`,
    );
  } finally {
    v.close();
  }
});

test("a symbol that really has no definition still says so", async () => {
  const v = await loadViewer(html);
  try {
    // A ready language server, asked, and there is genuinely nothing to go to.
    installAnalysis(v, { engine: "lsp", confidence: "semantic", locations: [], server: "typescript-language-server" });
    await jump(v);
    assert.match(
      hintText(v),
      /찾지 못했|not found/i,
      "a real dead end is still named as one",
    );
  } finally {
    v.close();
  }
});
