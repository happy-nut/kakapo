import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("Tiptap's Markdown input rule turns '# ' into a heading block immediately", async () => {
  const dom = new JSDOM("<!doctype html><div id='host'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const [{ Editor }, { default: StarterKit }, { Markdown }] = await Promise.all([
    import("@tiptap/core"),
    import("@tiptap/starter-kit"),
    import("@tiptap/markdown"),
  ]);
  const editor = new Editor({
    element: dom.window.document.querySelector("#host"),
    extensions: [StarterKit, Markdown],
    content: "",
    contentType: "markdown",
  });
  try {
    const { from, to } = editor.state.selection;
    let handled = false;
    editor.view.someProp("handleTextInput", (handler) => {
      if (!handled) handled = !!handler(editor.view, from, to, "# ");
    });
    assert.equal(handled, true, "the Markdown shortcut was consumed by an input rule");
    assert.ok(dom.window.document.querySelector(".ProseMirror h1"), "the same editable surface is now an h1 block");
  } finally {
    editor.destroy();
    dom.window.close();
  }
});

test("the lazy inline editor round-trips Markdown as rich editable blocks", () => {
  const dom = new JSDOM("<!doctype html><div id='host'></div>", {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  try {
    dom.window.eval(readFileSync("dist/monaco/markdown-editor.js", "utf8"));
    const host = dom.window.document.querySelector("#host");
    const editor = dom.window.MonacoriMarkdownEditor.create({
      element: host,
      markdown: "# Plan\n\nA **trusted** memo.",
    });

    const surface = host.querySelector(".mc-inline-editor[contenteditable='true']");
    assert.ok(surface, "the memo is one contenteditable surface, not a textarea + preview");
    assert.equal(surface.querySelector("h1")?.textContent, "Plan");
    assert.equal(surface.querySelector("strong")?.textContent, "trusted");
    assert.equal(editor.getMarkdown(), "# Plan\n\nA **trusted** memo.");

    editor.setMarkdown("## Updated\n\n- one\n- two");
    assert.equal(surface.querySelector("h2")?.textContent, "Updated");
    assert.deepEqual([...surface.querySelectorAll("li")].map((item) => item.textContent), ["one", "two"]);
    assert.match(editor.getMarkdown(), /^## Updated/m);
    editor.setMarkdown("<script>window.__unsafe = true</script>\n\n# Safe");
    assert.equal(surface.querySelector("script"), null, "unsupported raw script HTML is discarded by the editor schema");
    assert.equal(dom.window.__unsafe, undefined);
    editor.destroy();
  } finally {
    dom.window.close();
  }
});

test("the rich editor stays out of the startup viewer bundle", () => {
  const startup = readFileSync("dist/viewer.client.js", "utf8");
  const lazyEditor = readFileSync("dist/monaco/markdown-editor.js", "utf8");
  assert.doesNotMatch(startup, /MonacoriMarkdownEditor=\{/);
  assert.match(lazyEditor, /MonacoriMarkdownEditor=\{/);
  assert.ok(lazyEditor.length > 100_000, "the real editor bundle was produced, not a placeholder");
});
