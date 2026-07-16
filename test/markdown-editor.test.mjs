import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

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

test("the inline editor applies Notion-style todo, toggle, quote, strike, and underline shortcuts", () => {
  const dom = new JSDOM("<!doctype html><div id='host'></div>", {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  try {
    Object.defineProperty(dom.window.navigator, "platform", { value: "MacIntel", configurable: true });
    dom.window.eval(readFileSync("dist/monaco/markdown-editor.js", "utf8"));
    const host = dom.window.document.querySelector("#host");
    const editor = dom.window.MonacoriMarkdownEditor.create({ element: host, markdown: "" });
    const surface = host.querySelector(".mc-inline-editor");

    editor.typeText("[] ");
    const task = surface.querySelector('ul[data-type="taskList"] > li[data-type="taskItem"][data-checked="false"]');
    assert.ok(task?.querySelector('input[type="checkbox"]'), "[] creates a todo checkbox with the live task-item layout hook");
    assert.match(editor.getMarkdown(), /^- \[ \]/, "the todo remains portable Markdown");
    editor.typeText("write the next step");
    assert.equal(task.querySelector(":scope > div > p")?.textContent, "write the next step", "typing continues in the checkbox row instead of a new block");
    assert.match(editor.getMarkdown(), /^- \[ \] write the next step/, "continued task text stays on the same Markdown line");

    editor.setMarkdown("");
    editor.typeText("> ");
    assert.ok(surface.querySelector('div[data-type="details"]'), "> creates a collapsible toggle block");
    assert.ok(surface.querySelector(".mc-details-toggle"), "the toggle has an interactive disclosure button");

    editor.setMarkdown("");
    editor.typeText('" ');
    assert.ok(surface.querySelector("blockquote"), '" creates a blockquote');

    editor.setMarkdown("");
    editor.typeText("~done~");
    assert.equal(surface.querySelector("s")?.textContent, "done", "single tildes apply strikethrough inline");
    assert.equal(editor.getMarkdown(), "~~done~~", "strike serializes as standard GFM Markdown");

    editor.setMarkdown("");
    surface.focus();
    surface.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "u", code: "KeyU", metaKey: true, bubbles: true, cancelable: true }));
    editor.typeText("underlined");
    assert.equal(surface.querySelector("u")?.textContent, "underlined", "Cmd+U toggles underline for typed text");
    assert.equal(editor.getMarkdown(), "++underlined++", "underline round-trips through the Markdown document");

    editor.setMarkdown("# Edited intro\n\n### @one#L1\n\nremove me\n\n### @two#L2\n\nkeep me");
    const commentHeadings = [...surface.querySelectorAll("h3")];
    assert.equal(editor.deleteBlockRange(commentHeadings[0], commentHeadings[1]), true, "a comment section can be deleted in-place");
    assert.match(editor.getMarkdown(), /Edited intro/, "deleting a comment preserves hand-edited prompt content");
    assert.doesNotMatch(editor.getMarkdown(), /remove me|@one/, "only the selected comment section is removed");
    assert.match(editor.getMarkdown(), /@two#L2[\s\S]*keep me/, "the following comment remains");
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

test("real Chromium keeps an empty todo editable on its checkbox row after keyboard and mouse input", {
  skip: process.platform !== "darwin" ? "real Electron editor regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-markdown-editor.cjs", import.meta.url));
  const editorBundle = fileURLToPath(new URL("../dist/monaco/markdown-editor.js", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, editorBundle, css], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("MONACORI_MARKDOWN_EDITOR="));
  assert.ok(marker, `editor result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const state = JSON.parse(marker.slice("MONACORI_MARKDOWN_EDITOR=".length));
  assert.equal(state.taskDisplay, "flex", "the live task-item NodeView uses the horizontal task layout");
  assert.ok(state.editableWidth > 100, `the empty task paragraph only exposed a ${state.editableWidth}px click target`);
  assert.ok(Math.abs(state.taskTop - state.editableTop) <= 1, "the editable paragraph starts on the checkbox row");
  assert.equal(state.markdown, "- [ ] typed after click\n\n", "clicking after the checkbox accepts text on that same task line");
});
