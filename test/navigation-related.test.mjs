// The rest of IntelliJ's Navigate menu: Go to Class (⌥O), Go to Related Symbol (⌥G), Go to Custom Region
// (⌘⌥.), Jump to Last Change (⌘⇧⌫) and the method hierarchy (⌘⇧M).
//
// Each is small, and each is small for the same reason: the answer already existed somewhere in this app
// and what was missing was a way to ask for it. So what these guard is mostly the asking — that ⌥O asks
// for types only, that ⌘⇧M asks for the overrides and flips to the supertypes, that ⌥G finds the two
// relations a reader with no framework knowledge can find.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const FILE = "src/Button.tsx";
const SOURCE = [
  "// region Rendering",      // 0
  "export function Button() {", // 1
  "  return null;",            // 2
  "}",                         // 3
  "// endregion",              // 4
  "",                          // 5
  "// #region Hooks",          // 6
  "export function useButton() {", // 7
  "  return 1;",               // 8
  "}",                         // 9
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: FILE, before: "export function Button() {}\n", after: SOURCE + "\n" },
    { path: "src/Button.css", before: ".a{}\n", after: ".b{}\n" },
    { path: "src/Button.test.tsx", before: "", after: "import { Button } from './Button';\n" },
    { path: "src/other.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

async function openSource(options = {}) {
  const asked = [];
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      asked.push(request);
      if (request.kind === "workspaceSymbol") {
        return { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: options.symbols ?? [] };
      }
      if (request.kind === "implementation" || request.kind === "supertypes") {
        return { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: options.hierarchy ?? [] };
      }
      return { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] };
    },
    analysisStatus: { generation: 0, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  v.window.openSourceFile(FILE);
  await v.settle(40);
  return { v, asked };
}

const press = (host, init) => {
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return host.v.settle(60);
};
const peekRows = (host) => host.v.$all("#semantic-peek .semantic-peek-item")
  .map((row) => row.querySelector(".semantic-peek-item-path").textContent);
const openPath = (host) => host.v.$("#source-viewer").dataset.openPath;

test("⌥O asks for types only; ⌘⌥O asks for everything", async () => {
  const host = await openSource();
  await press(host, { code: "KeyO", key: "o", altKey: true });
  await host.v.settle(140);
  const typed = host.asked.filter((request) => request.kind === "workspaceSymbol");
  assert.equal(typed.length >= 1, true);
  assert.equal(typed[typed.length - 1].types, true, "Go to Class is Go to Symbol with the filter on");
  assert.match(host.v.$("#quick-open-mode").textContent, /class/i);

  await press(host, { code: "Escape", key: "Escape" });
  await press(host, { code: "KeyO", key: "o", metaKey: true, altKey: true });
  await host.v.settle(140);
  const all = host.asked.filter((request) => request.kind === "workspaceSymbol");
  assert.equal(all[all.length - 1].types, false);
  host.v.close();
});

test("⌥G finds the file's test and its same-name siblings", async () => {
  const host = await openSource();
  await press(host, { code: "KeyG", key: "g", altKey: true });
  const rows = peekRows(host);
  assert.ok(rows.some((row) => row.includes("Button.test.tsx")), `the test: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((row) => row.includes("Button.css")), `the stylesheet beside it: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some((row) => row.includes("other.ts")), "and nothing that merely lives in the same folder");
  host.v.close();
});

test("⌥G on a file with no relations says so instead of opening a list", async () => {
  const host = await openSource();
  host.v.window.openSourceFile("src/other.ts");
  await host.v.settle(40);
  await press(host, { code: "KeyG", key: "g", altKey: true });
  assert.equal(host.v.$all("#semantic-peek .semantic-peek-item").length, 0);
  assert.match(host.v.$all(".mc-toast").map((el) => el.textContent).join(" "), /Nothing related/);
  host.v.close();
});

test("⌘⌥. lists the file's regions, in both of the spellings that are written", async () => {
  const host = await openSource();
  await press(host, { code: "Period", key: ".", metaKey: true, altKey: true });
  const names = host.v.$all("#semantic-peek .semantic-peek-item .semantic-peek-item-code")
    .map((row) => row.textContent.trim());
  assert.deepEqual(names, ["// region Rendering", "// #region Hooks"],
    "`//region` and `// #region` are the same marker written two ways");
  host.v.close();
});

test("⌘⇧⌫ goes to the last line this review changed in the open file", async () => {
  const host = await openSource();
  host.v.window.setSourceCursor(FILE, 0, 0, true, -1);
  await press(host, { code: "Backspace", key: "Backspace", metaKey: true, shiftKey: true });
  const caret = host.v.window.caretLocation();
  assert.match(caret, new RegExp(`^${FILE}:`), caret);
  const line = Number(caret.split(":")[1]);
  assert.ok(line > 1, `the last change is below the first line, not the caret it started on: ${caret}`);
  host.v.close();
});

test("⌘⇧M opens the method hierarchy, and pressing it again flips the direction", async () => {
  const host = await openSource({
    hierarchy: [{ path: "src/other.ts", lineIndex: 0, column: 7, name: "x", text: "export const x = 2;" }],
  });
  host.v.window.setSourceCursor(FILE, 1, 16, true, -1); // on `Button`
  await press(host, { code: "KeyM", key: "m", metaKey: true, shiftKey: true });
  await host.v.settle(120);
  const kinds = host.asked.map((request) => request.kind);
  assert.equal(kinds[kinds.length - 1], "implementation", "down first: who overrides this");

  await press(host, { code: "KeyM", key: "m", metaKey: true, shiftKey: true });
  await host.v.settle(120);
  const after = host.asked.map((request) => request.kind);
  assert.equal(after[after.length - 1], "supertypes", "and the same chord flips to what it overrides");
  host.v.close();
});

// ---- ⌘⇧A and ⌥Space ------------------------------------------------------------------------------

const actionRows = (host) => host.v.$all("#quick-open-results .action-result")
  .map((row) => row.dataset.action);

test("⌘⇧A lists the actions this page can run, with their chords", async () => {
  const host = await openSource();
  await press(host, { code: "KeyA", key: "a", metaKey: true, shiftKey: true });
  const rows = actionRows(host);
  assert.ok(rows.includes("fileStructure"), `the structure popup is an action: ${rows.length} rows`);
  assert.ok(rows.includes("problemsView"));
  // A menu accelerator belongs to the OS menu and cannot be fired from the page, so it is not offered.
  assert.ok(!rows.includes("openFolder"), "⌘O opens a folder through the menu, not through here");
  const chord = host.v.$('#quick-open-results .action-result[data-action="fileStructure"] .action-chord');
  assert.equal(chord.textContent, "⌘F12", "the chord is on the row — half of why the list is opened");
  host.v.close();
});

test("⌘⇧A filters by chord as well as by name", async () => {
  const host = await openSource();
  await press(host, { code: "KeyA", key: "a", metaKey: true, shiftKey: true });
  host.v.typeInto(host.v.$("#quick-open-input"), "⌘F12");
  await host.v.settle(40);
  assert.deepEqual(actionRows(host), ["fileStructure"], "\"what was that chord again\" is the other half");
  host.v.close();
});

test("Enter on an action closes the list and runs it", async () => {
  const host = await openSource();
  await press(host, { code: "KeyA", key: "a", metaKey: true, shiftKey: true });
  host.v.typeInto(host.v.$("#quick-open-input"), "⌘6");
  await host.v.settle(40);
  assert.deepEqual(actionRows(host), ["problemsView"]);
  await press(host, { code: "Enter", key: "Enter" });
  await host.v.settle(120);
  // It ran: the launcher is showing the Problems list now rather than the actions it was showing.
  assert.equal(host.v.$("#quick-open-mode").textContent, "Problems");
  host.v.close();
});

test("⌥Space shows the definition's own lines without going there", async () => {
  const host = await openSource({});
  host.v.window.kakapoAnalysis.query = (request) => Promise.resolve(
    request.kind === "definition"
      ? { ok: true, engine: "lsp", server: "tsserver", confidence: "semantic", locations: [{ path: FILE, lineIndex: 7, column: 16, endLineIndex: 9, name: "useButton" }] }
      : { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] },
  );
  host.v.window.setSourceCursor(FILE, 1, 16, true, -1);
  const before = host.v.window.caretLocation();
  await press(host, { code: "Space", key: " ", altKey: true });
  await host.v.settle(80);

  const lines = host.v.$all("#quick-doc .quick-def-line .quick-def-num").map((el) => el.textContent);
  assert.deepEqual(lines, ["8", "9", "10"], "the declaration's own lines, numbered as the file numbers them");
  assert.match(host.v.$("#quick-doc-body").textContent, /useButton/);
  assert.equal(host.v.window.caretLocation(), before, "and the caret has not moved — that is ⌘↓'s job");
  host.v.close();
});

test("⌥Space says so when the definition is outside the review", async () => {
  const host = await openSource({});
  host.v.window.kakapoAnalysis.query = (request) => Promise.resolve(
    request.kind === "definition"
      ? { ok: true, engine: "lsp", confidence: "semantic", locations: [{ path: "jrt:/java.base/java/lang/String.class", lineIndex: 0, column: 0, external: true }] }
      : { ok: true, engine: "lsp", confidence: "semantic", locations: [], symbols: [] },
  );
  host.v.window.setSourceCursor(FILE, 1, 16, true, -1);
  await press(host, { code: "Space", key: " ", altKey: true });
  await host.v.settle(80);
  assert.match(host.v.$("#quick-doc-body").textContent, /outside this review/);
  host.v.close();
});
