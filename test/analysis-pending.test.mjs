// What the app says while the language server is still coming up.
//
// During that window the regex index answers instead, and the answer is a guess at what the server would
// have said. ⌘B said so; ⌥F7, ⌘⌥B, ⌥O and ⌘6 did not — they showed the index's answer, or "no usages",
// with nothing to say it was provisional. The notice is said once now, in the one funnel every surface
// asks its question through (queryProjectAnalysis), so the next surface added cannot forget it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/store.ts";
const SOURCE = ["export class Store {", "  load() {", "    return Store;", "  }", "", "  gone() {", "    return nowhereAtAll;", "  }", "}"].join("\n");

let html;
before(async () => {
  // `app: true`: the analysis status chip is an Electron-only element — a standalone HTML review has no
  // language server to be waiting for, so there is nothing for it to say.
  ({ html } = await makeReviewHtml([{ path: FILE, before: "export class Store {}\n", after: SOURCE + "\n" }], { app: true }));
});
after(cleanupFixtures);

/** A viewer whose analyzer is in `phase` and answers from the index rather than a server. */
async function openSource(phase, locations = []) {
  const v = await loadViewer(html, {
    analysisBridge: () => ({
      ok: true,
      engine: "index",
      confidence: "heuristic",
      fallbackReason: "Language server returned no semantic locations",
      locations,
    }),
    analysisStatus: { generation: 0, phase, updatedAt: new Date(0).toISOString() },
  });
  // The status chip is what every "is the analysis ready" question reads, and the harness's
  // analysisStatus option only answers the bridge call — it does not paint the chip. This is the hook the
  // status slice exports for exactly that.
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase, updatedAt: new Date(0).toISOString() });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 2, 11, true, -1); // on `Store`
  return v;
}

const press = (v, init) => {
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return v.settle(80);
};
// Only what is on screen: hideCaretHint() takes the `show` class off and leaves the text in the DOM, so
// reading textContent alone reports a message the reviewer can no longer see.
const said = (v) => v.$all(".mc-caret-hint.show, .mc-toast").map((el) => el.textContent).join(" | ");
const at = (path, lineIndex, text) => ({ path, lineIndex, column: text.indexOf("Store"), text, name: "Store" });

test("⌥F7 says the answer is partial while the analysis is still starting", async () => {
  const v = await openSource("starting", [at(FILE, 2, "    return Store;")]);
  await press(v, { code: "F7", key: "F7", altKey: true });
  await v.settle(120);
  assert.match(said(v), /Still indexing/,
    "the usage view used to show the index's rows with nothing to say the server had not answered");
  v.close();
});

test("and ⌘⌥B, which never said it at all", async () => {
  const v = await openSource("starting", [at(FILE, 0, "export class Store {")]);
  await press(v, { code: "KeyB", key: "b", metaKey: true, altKey: true });
  await v.settle(120);
  assert.match(said(v), /Still indexing/);
  v.close();
});

test("once, not once per question — ⌘6 asks about every file in the review", async () => {
  const v = await openSource("indexing", [at(FILE, 2, "    return Store;")]);
  await press(v, { code: "F7", key: "F7", altKey: true });
  await v.settle(120);
  await press(v, { code: "Escape", key: "Escape" });
  await press(v, { code: "KeyB", key: "b", metaKey: true, altKey: true });
  await v.settle(120);
  const notices = v.$all(".mc-caret-hint, .mc-toast")
    .filter((el) => /Still indexing/.test(el.textContent));
  assert.ok(notices.length <= 1, `one notice, not one per question: ${notices.length}`);
  v.close();
});

test("a ready analysis says nothing — the answer is the answer", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => ({ ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: [at(FILE, 2, "    return Store;")] }),
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  v.window.setSourceCursor(FILE, 2, 11, true, -1);
  await press(v, { code: "F7", key: "F7", altKey: true });
  await v.settle(120);
  assert.doesNotMatch(said(v), /Still indexing/);
  v.close();
});

test("nothing found while a server is still coming up is \"not yet\", not \"not there\"", async () => {
  const v = await openSource("starting", []);
  // ⌘⌥B rather than ⌘B: with no answer from the analyzer, ⌘B falls back to the page's own scan over the
  // embedded files and often still lands somewhere, which is a different outcome from a dead end. Go to
  // Implementation has no such fallback, so the message is what the reviewer gets.
  await press(v, { code: "KeyB", key: "b", metaKey: true, altKey: true });
  await v.settle(140);
  assert.match(said(v), /Still reading the project/,
    "\"no definition found\" for a server that has not answered is a wrong answer");
  assert.doesNotMatch(said(v), /not found/i);
  v.close();
});

test("the usage view's empty state is translated, not the analyzer's internal English", async () => {
  const v = await openSource("starting", []);
  await press(v, { code: "F7", key: "F7", altKey: true });
  await v.settle(140);
  const results = v.$("#quick-open-results").textContent;
  assert.doesNotMatch(results, /Language server returned no semantic locations/,
    "that sentence is an internal reason, and it was being printed verbatim under a translated heading");
  assert.match(results, /Still reading the project/);
  v.close();
});

test("the ⌘B popup's own heading and empty state are translated too", async () => {
  const v = await openSource("ready", []);
  // Two locations so the popup opens rather than jumping, and the analyzer declines so the page's own
  // scan is what fills it — that is the surface whose strings were built in English in code.
  v.window.openUsages("Store", { path: FILE, lineIndex: -1 }, { ok: true, engine: "index", locations: [] });
  await v.settle(40);
  const title = v.$("#usages-title").textContent;
  assert.doesNotMatch(title, /usages of/, "\"3 usages of Store\" was assembled in code, in English");
  assert.match(title, /Store/);
  v.close();
});

test("the status chip says how long it has been starting, once that is worth knowing", async () => {
  const v = await openSource("starting", []);
  // The whole chip: the counter is a span of its own beside the label (which carries data-i18n).
  const label = () => v.$("#analysis-status").textContent;
  assert.doesNotMatch(label(), /\d+s/, "a project whose server is up in a second shows no counter");

  // Four seconds in, reported again as the analyzer does: the counter appears, and the clock is the
  // PHASE's, not the report's — a re-report of the same phase must not restart it.
  const started = Date.now() - 4000;
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "starting", updatedAt: new Date(1).toISOString() });
  assert.doesNotMatch(label(), /\d+s/, "still the same phase, still only a moment old");

  v.window.eval?.("analysisPhaseStartedAt = " + started);
  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "starting", updatedAt: new Date(2).toISOString() });
  assert.match(label(), /4s/, label());

  v.window.__kakapoAnalysisStatus.render({ generation: 0, phase: "ready", updatedAt: new Date(3).toISOString() });
  assert.doesNotMatch(label(), /\d+s/, "and it stops when there is nothing left to wait for");
  v.close();
});
