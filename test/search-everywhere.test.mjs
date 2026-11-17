import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { loadViewer } from "./helpers/dom.mjs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const doubleShift = async (v) => {
  v.key("Shift", { location: 1 });
  v.key("Shift", { location: 1 });
  await v.settle(20);
};
const rows = (v) => v.$all("#quick-open-results .quick-open-item");
const names = (v) => rows(v).map((r) => r.querySelector(".quick-open-name")?.textContent || "");
const activeTab = (v) => v.$("#quick-open-side .quick-open-side-item.active")?.dataset.section;

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/alpha.ts", before: "export const alpha = 1;\n", after: "export const alpha = 2;\n" },
    { path: "src/alphabet.ts", before: "export const abc = 1;\n", after: "export const abc = 1;\n" },
  ]));
});

test("the All tab opens on recent files, newest first", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/alphabet.ts");
  await v.openSourceFile("src/alpha.ts");
  await doubleShift(v);
  assert.ok(v.quickOpenVisible(), "⇧⇧ opens it");
  assert.equal(activeTab(v), "everywhere", "on the All tab");
  assert.deepEqual(names(v), ["alpha.ts", "alphabet.ts"], "what was open lately, most recent first");
  v.close();
});

test("the All tab merges files, symbols and actions into one weight-sorted list", async () => {
  const v = await loadViewer(html, {
    analysisBridge: (request) => (request.kind === "workspaceSymbol"
      ? {
        ok: true,
        engine: "lsp",
        server: "tsserver",
        locations: [{ path: "src/alpha.ts", name: "alphaHelper", kind: 12, lineIndex: 0, column: 6, text: "export const alpha = 2;" }],
      }
      : null),
  });
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "alpha");
  await v.settle(200);

  const kinds = rows(v).map((r) => (r.classList.contains("symbol-result") ? "symbol"
    : r.classList.contains("action-result") ? "action" : "file"));
  assert.ok(kinds.includes("file"), `a file row: ${JSON.stringify(names(v))}`);
  assert.ok(kinds.includes("symbol"), `a symbol row: ${JSON.stringify(names(v))}`);
  assert.equal(names(v)[0], "alpha.ts", "the better match leads, whichever kind of thing it is");
  assert.match(v.$("#quick-open-filter").textContent, /tsserver/, "the chip names the symbol engine");
  v.close();
});

test("a recent file that is also a project file is listed once", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/alpha.ts");
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "alpha.ts");
  await v.settle(200);
  const alphas = names(v).filter((n) => n === "alpha.ts");
  assert.equal(alphas.length, 1, `one row, not one per producer: ${JSON.stringify(names(v))}`);
  v.close();
});

test("each group is capped at 15, and the trailing more row raises the cap", async () => {
  const many = [];
  for (let i = 0; i < 24; i += 1) {
    const n = String(i).padStart(2, "0");
    many.push({ path: `src/widget${n}.ts`, before: `export const w = ${i};\n`, after: `export const w = ${i + 1};\n` });
  }
  const { html: wide } = await makeReviewHtml(many);
  const v = await loadViewer(wide);
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "widget");
  await v.settle(200);

  const more = () => rows(v).filter((r) => r.classList.contains("se-more"));
  assert.equal(rows(v).length - more().length, 15, "fifteen of the twenty-four");
  assert.equal(more().length, 1, "…and one row saying there are more");

  more()[0].dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
  await v.settle(200);
  assert.equal(rows(v).length - more().length, 24, "the more row fetches another fifteen");
  assert.equal(more().length, 0, "…and goes away once everything is shown");
  v.close();
});

test("double-Shift again widens the scope past the change", async () => {
  const v = await loadViewer(html);
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "alphabet");
  await v.settle(200);
  assert.ok(names(v).includes("alphabet.ts"), `auto-widened: ${JSON.stringify(names(v))}`);
  assert.match(v.$("#quick-open-filter").textContent, /everywhere|전체/, "the chip says which scope answered");

  await doubleShift(v);
  assert.ok(v.quickOpenVisible(), "⇧⇧ again does not close the All tab");
  assert.match(v.$("#quick-open-filter").textContent, /changed|변경/, "it narrows back to the change");
  assert.equal(names(v).includes("alphabet.ts"), false, "…and the unchanged file is gone with it");
  v.close();
});

test("Tab steps the tab strip and keeps what was typed", async () => {
  const v = await loadViewer(html);
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "alpha");
  await v.settle(200);
  assert.equal(activeTab(v), "everywhere");

  v.key("Tab", { code: "Tab" });
  await v.settle(50);
  assert.equal(activeTab(v), "classes", "Tab moves to the next tab");
  assert.equal(v.$("#quick-open-input").value, "alpha", "…carrying the query across");

  v.key("Tab", { code: "Tab", shiftKey: true });
  await v.settle(50);
  assert.equal(activeTab(v), "everywhere", "⇧Tab steps back");
  assert.equal(v.$("#quick-open-input").value, "alpha", "…still carrying it");

  v.key("Tab", { code: "Tab", shiftKey: true });
  await v.settle(50);
  assert.equal(activeTab(v), "content", "the cycle wraps round the six tabs, not out of the dialog");
  v.close();
});

test("a line written after a name is read with IntelliJ's own separators", async () => {
  const v = await loadViewer(html);
  const parse = (text) => {
    const r = v.window.quickLineAndColumn(text);
    return [r.name, r.lineIndex, r.column];
  };
  assert.deepEqual(parse("App.tsx:42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx:42:7"), ["App.tsx", 41, 6]);
  assert.deepEqual(parse("App.tsx 42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx@42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx#L42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx?l=42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx on line 42"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("App.tsx(42,7)"), ["App.tsx", 41, 6]);
  assert.deepEqual(parse("App.tsx[42]"), ["App.tsx", 41, -1]);
  assert.deepEqual(parse("foo bar"), ["foo bar", -1, -1]);
  assert.deepEqual(parse("src/app.ts"), ["src/app.ts", -1, -1]);
  assert.deepEqual(parse("plain"), ["plain", -1, -1]);
  v.close();
});

test("the late symbol answer repaints without re-asking, capitals and line numbers included", async () => {
  const asked = [];
  const v = await loadViewer(html, {
    analysisBridge: (request) => {
      if (request.kind !== "workspaceSymbol") return null;
      asked.push(request.query ?? request.payload?.query);
      return { ok: true, engine: "lsp", server: "tsserver", locations: [] };
    },
  });
  await doubleShift(v);
  v.typeInto(v.$("#quick-open-input"), "Alpha");
  await v.settle(300);
  assert.equal(asked.length, 1, `one query per keystroke, not two: ${JSON.stringify(asked)}`);

  v.typeInto(v.$("#quick-open-input"), "alpha.ts:42");
  await v.settle(300);
  assert.equal(asked.length, 2, `still one per keystroke: ${JSON.stringify(asked)}`);
  assert.equal(v.$("#quick-open-input").value, "alpha.ts:42", "the line number stays in the box");
  const first = v.$("#quick-open-results .quick-open-item");
  assert.ok(first, "the file is still listed under its name, not searched for as 'alpha.ts:42'");
  v.close();
});

test("two Shifts further apart than IntelliJ's window are not a double tap", async () => {
  const v = await loadViewer(html);
  assert.equal(v.window.SHORTCUT_DOUBLE_TAP_MS, 300, "IntelliJ's own window");
  v.key("Shift", { location: 1 });
  await v.settle(360);
  v.key("Shift", { location: 1 });
  await v.settle(20);
  assert.equal(v.quickOpenVisible(), false, "a slow pair is two presses, not a gesture");
  v.close();
});
