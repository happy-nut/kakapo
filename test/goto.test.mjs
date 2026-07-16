// Cmd+L (go to line) / Cmd+K (copy file:line) and the sidebar Opt+Enter row-action menu.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n", after: "export const x = 1;\nexport const y = 2;\nexport const z = 9;\n" },
    { path: "README.md", before: "# Hi\n", after: "# Hello\n" },
  ]));
});
after(cleanupFixtures);

test("caretLocation reports path:line and gotoLineJump moves the source caret", async () => {
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  v.window.setSourceCursor("src/app.ts", 0, 0, false, -1); // line 1
  assert.equal(v.window.caretLocation(), "src/app.ts:1", "Cmd+K would copy line 1");
  v.window.gotoLineJump(3); // Cmd+L → line 3
  await v.settle(20);
  assert.equal(v.window.caretLocation(), "src/app.ts:3", "gotoLineJump moved the caret to line 3");
  v.window.gotoLineJump(999); // clamp to the last line (3 lines + a trailing empty line = 4)
  await v.settle(20);
  assert.equal(v.window.caretLocation(), "src/app.ts:4", "out-of-range line clamps to the last line");
  v.close();
});

test("file rows have no hover path bubble and Opt+Enter menu exposes grounded path actions", async () => {
  const v = await loadViewer(html);
  const row = v.$(".file-link[data-source-file]"); // a source-tree file row
  assert.ok(row, "the source tree has a file row");
  const path = row.dataset.sourceFile;

  row.dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(10);
  assert.equal(row.hasAttribute("title"), false, "the file row does not expose a native path tooltip");
  assert.ok(v.$("#mc-button-hint").classList.contains("hidden"), "the generic button hover bubble excludes file rows");

  const copied = [];
  const calls = [];
  v.window.monacoriClipboard = { write: (text) => copied.push(text) };
  v.window.monacoriApp = {
    absolutePath: async (path) => ({ ok: true, path: `/repo/${path}` }),
    revealInFinder: (path) => calls.push(["finder", path]),
    openTerminal: (path) => calls.push(["terminal", path]),
  };
  v.window.openTreeRowMenu(row);
  await v.settle(10);
  let dd = v.$("#mc-dropdown");
  assert.ok(dd, "the row-action dropdown opened");
  assert.match(dd.textContent, /Copy relative path/, "it offers the repo-relative path");
  assert.match(dd.textContent, /Copy absolute path/, "it offers the resolved absolute path");
  assert.match(dd.textContent, /Reveal in Finder/, "it offers Finder reveal");
  assert.match(dd.textContent, /Open Terminal here/, "it offers a terminal at the file directory");

  dd.querySelector("button").click();
  assert.deepEqual(copied, [path], "mouse activation copies the relative path");

  v.window.openTreeRowMenu(row);
  dd = v.$("#mc-dropdown");
  dd.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  dd.dispatchEvent(new v.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await v.settle(10);
  assert.deepEqual(copied, [path, `/repo/${path}`], "arrow + Enter copies the absolute path");

  v.window.openTreeRowMenu(row);
  Array.from(v.$("#mc-dropdown").querySelectorAll("button")).find((button) => /Finder/.test(button.textContent)).click();
  v.window.openTreeRowMenu(row);
  Array.from(v.$("#mc-dropdown").querySelectorAll("button")).find((button) => /Terminal/.test(button.textContent)).click();
  assert.deepEqual(calls, [["finder", path], ["terminal", path]]);
  v.close();
});
