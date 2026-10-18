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
  const hint = v.$(".mc-caret-hint");
  return hint ? (hint.textContent || "").trim() : "";
};
const hintShown = (v) => {
  const hint = v.$(".mc-caret-hint");
  return Boolean(hint && hint.classList.contains("show"));
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

// A cold language server has eight seconds to answer (REQUEST_TIMEOUT_MS). The "looking for X…" hint faded
// after two of them, so the reviewer got six seconds of a screen that looked like the key was never
// pressed — on the first jump after opening a project, which is exactly when the server is cold.
test("the searching hint stays up for as long as the answer takes", async () => {
  const v = await loadViewer(html);
  try {
    let answer;
    v.window.kakapoAnalysis = {
      query: () => new Promise((resolve) => { answer = resolve; }), // never resolves on its own
      diagnostics: () => Promise.resolve({ ok: true, generation: 0, diagnostics: [] }),
      status: () => Promise.resolve({ phase: "starting", generation: 0 }),
      onStatus: () => {},
    };
    await v.openSourceFile(FILE);
    await v.clickSourceLine(1);
    v.key("ArrowDown", { metaKey: true, code: "ArrowDown" });

    await v.settle(400); // past the 250ms delay that puts the hint up
    assert.ok(hintShown(v), "the hint appears while the answer is outstanding");
    assert.match(hintText(v), /찾는 중|Looking for/i, "and it says what is being looked for");

    await v.settle(2600); // past the 2s fade that used to take it away mid-request
    assert.ok(hintShown(v), `the hint is still up while the request is still out (got: ${hintText(v)})`);

    // …and it comes down when the answer finally arrives, rather than sitting over the destination.
    answer({ ok: true, generation: 0, engine: "lsp", confidence: "semantic", locations: [] });
    await v.settle(80);
    assert.match(hintText(v), /찾지 못했|not found/i, "the outcome replaces the wait");
  } finally {
    v.close();
  }
});

// The indexing window, named. Opening a project starts a language server that answers `initialize` in
// milliseconds and then spends real time building its model; until it has one, the regex index answers
// instead. Three things follow from that, and all three used to be silent.
test("an answer from the regex index during indexing is marked as partial", async () => {
  const v = await loadViewer(html);
  try {
    // The status chip is what says a server is still coming up.
    const chip = v.document.createElement("span");
    chip.id = "analysis-status";
    chip.dataset.phase = "indexing";
    v.document.body.appendChild(chip);

    installAnalysis(v, {
      engine: "index",
      confidence: "heuristic",
      fallbackReason: "typescript-language-server is still indexing",
      locations: [{ path: FILE, lineIndex: 0, column: 16 }],
    });
    await jump(v);

    assert.match(
      hintText(v),
      /부분적인 결과|partial answer/i,
      `a heuristic answer during indexing says it is partial (got: ${hintText(v)})`,
    );
  } finally {
    v.close();
  }
});

test("a semantic answer is not labelled partial", async () => {
  const v = await loadViewer(html);
  try {
    const chip = v.document.createElement("span");
    chip.id = "analysis-status";
    chip.dataset.phase = "ready";
    v.document.body.appendChild(chip);

    installAnalysis(v, {
      engine: "lsp",
      confidence: "semantic",
      server: "typescript-language-server",
      locations: [{ path: FILE, lineIndex: 0, column: 16 }],
    });
    await jump(v);
    assert.doesNotMatch(hintText(v), /부분적인 결과|partial answer/i, "the real thing is not hedged");
  } finally {
    v.close();
  }
});

test("finishing the indexing is announced, and only on the transition", async () => {
  const v = await loadViewer(html);
  try {
    const chip = v.document.createElement("span");
    chip.id = "analysis-status";
    chip.dataset.phase = "indexing";
    v.document.body.appendChild(chip);
    const toasts = () => v.$all("#mc-toasts .mc-toast").map((el) => (el.textContent || "").trim());

    v.window.renderAnalysisStatus({ phase: "ready", generation: 0, updatedAt: new Date().toISOString() });
    await v.settle(40);
    assert.ok(
      toasts().some((text) => /준비됐습니다|is ready/i.test(text)),
      `becoming ready is said out loud (got: ${JSON.stringify(toasts())})`,
    );

    // A second ready push is not news — the reviewer was already told.
    const before = toasts().length;
    v.window.renderAnalysisStatus({ phase: "ready", generation: 0, updatedAt: new Date().toISOString() });
    await v.settle(40);
    assert.equal(toasts().length, before, "a project that was already ready says nothing");
  } finally {
    v.close();
  }
});
