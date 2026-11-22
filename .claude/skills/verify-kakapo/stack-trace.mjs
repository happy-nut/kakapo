#!/usr/bin/env node
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("stack-trace");
repo.put("src/main/java/com/foo/Bar.java", [
  "package com.foo;",
  "",
  "class Bar {",
  "  void baz() {",
  "    throw new RuntimeException(\"boom\");",
  "  }",
  "}",
  "",
].join("\n"));
repo.put("src/main/java/com/qux/Bar.java", [
  "package com.qux;",
  "",
  "class Bar {",
  "  void ping() {}",
  "}",
  "",
].join("\n"));
repo.put("src/app/handler.ts", [
  "export function handle() {",
  "  return makeStore();",
  "}",
  "",
].join("\n"));
repo.put("src/main/java/com/foo/Untouched.java", [
  "package com.foo;",
  "",
  "class Untouched {",
  "  void sleep() { }",
  "}",
  "",
].join("\n"));
repo.put("README.md", "# stack-trace fixture\n");
repo.commit("initial");
repo.put("README.md", "# stack-trace fixture\n\nA review to read.\n");
repo.put("src/main/java/com/foo/Bar.java", [
  "package com.foo;",
  "",
  "class Bar {",
  "  void baz() {",
  "    throw new RuntimeException(\"boom\");",
  "  }",
  "",
  "  void park() {}",
  "}",
  "",
].join("\n"));
repo.put("src/main/java/com/qux/Bar.java", [
  "package com.qux;",
  "",
  "class Bar {",
  "  void ping() { }",
  "}",
  "",
].join("\n"));
repo.put("src/app/handler.ts", [
  "export function handle() {",
  "  return makeStore() + 1;",
  "}",
  "",
].join("\n"));

const TRACE = [
  "java.lang.RuntimeException: boom",
  "\tat com.foo.Bar.baz(Bar.java:5)",
  "\tat com.qux.Bar.ping(Bar.java:4)",
  "\tat com.foo.Untouched.sleep(Untouched.java:4)",
  "\tat com.foo.Bar.park(Native Method)",
  "\tat com.foo.Missing.gone(Missing.java:7)",
  "    at handle (/home/runner/work/repo/src/app/handler.ts:2:10)",
  "",
].join("\n");

const PANEL = `(() => {
  const box = document.getElementById('stack-trace');
  const rows = Array.from(document.querySelectorAll('#stack-trace-results .stack-item'));
  return {
    open: !!(box && !box.classList.contains('hidden')),
    pasted: (document.getElementById('stack-trace-input') || {}).value || '',
    linked: rows.map((row) => row.querySelector('.stack-loc').textContent),
    missing: Array.from(document.querySelectorAll('#stack-trace-results .stack-missing')).map((row) => row.textContent.trim()),
    prose: Array.from(document.querySelectorAll('#stack-trace-results .stack-prose')).map((row) => row.textContent.trim()),
    summary: (document.getElementById('stack-trace-summary') || {}).textContent || '',
  };
})()`;

// Where the caret was PAINTED, read off the DOM — not what the model holds.
const CARET = `(() => {
  const row = document.querySelector('#source-body .source-row.cursor-line');
  const cursor = document.querySelector('#source-body .code-cursor');
  return {
    path: sourceOpenPath(),
    line: row ? Number(row.dataset.lineIndex) + 1 : null,
    text: row ? (row.querySelector('.source-code') || {}).textContent : null,
    painted: !!cursor,
  };
})()`;

await drive("stack-trace", repo, async (page, h) => {
  const held = await page.evaluate(`(() => {
    const before = window.kakapoClipboard.read();
    window.kakapoClipboard.write(${JSON.stringify(TRACE)});
    return before;
  })()`);

  try {
    await page.key("S", "KeyS", 83, 12);
    await h.until(`!document.getElementById('stack-trace').classList.contains('hidden')`, 10000);
    await h.until(`document.querySelectorAll('#stack-trace-results .stack-item').length >= 4`, 15000);
    const panel = await page.evaluate(PANEL);

    h.check(panel.open, "⌘⇧S opens the stack-trace panel in the real app", JSON.stringify(panel.summary));
    h.check(panel.pasted === TRACE, "and it prefills itself from the clipboard, with no parse button to press",
      JSON.stringify(panel.pasted.slice(0, 40)));
    h.check(panel.linked.join(" | ") === "src/main/java/com/foo/Bar.java:5 | src/main/java/com/qux/Bar.java:4"
      + " | src/main/java/com/foo/Untouched.java:4 | src/app/handler.ts:2",
      "four frames resolve to real files, and the two Bar.java files are told apart by the package in the class name",
      JSON.stringify(panel.linked));
    h.check(panel.linked.some((loc) => loc.startsWith("src/main/java/com/foo/Untouched.java")),
      "one of them is a committed file this review never changed — a stack trace mostly names those, and the "
      + "review's own file list holds only the changed ones until the full project index has been asked for",
      JSON.stringify(panel.summary));
    h.check(panel.missing.length === 2 && panel.missing.some((note) => note.includes("Missing.java")),
      "the frame for a file that is not here says which file it looked for", JSON.stringify(panel.missing));
    h.check(panel.prose.length === 1 && panel.prose[0].includes("RuntimeException"),
      "and the exception message renders as prose rather than being dropped", JSON.stringify(panel.prose));
    await h.shot("panel-from-clipboard");

    await h.click("#stack-trace-results .stack-item", 0);
    await h.until(`sourceOpenPath() === 'src/main/java/com/foo/Bar.java'`, 10000);
    await h.until(`!!document.querySelector('#source-body .source-row.cursor-line')`, 10000);
    const caret = await page.evaluate(CARET);
    h.check(caret.path === "src/main/java/com/foo/Bar.java" && caret.line === 5 && caret.painted,
      "opening a frame paints the caret on the line the frame named", JSON.stringify(caret));
    h.check(String(caret.text || "").includes("throw new RuntimeException"),
      "which is the line that threw", JSON.stringify(caret.text));
    h.check(await page.evaluate(`document.getElementById('stack-trace').classList.contains('hidden')`),
      "and the panel closed behind the jump");
    await h.shot("caret-on-the-frames-line");

    await page.key("S", "KeyS", 83, 12);
    await h.until(`!document.getElementById('stack-trace').classList.contains('hidden')`, 10000);
    await page.evaluate(`(() => {
      const el = document.getElementById('stack-trace-input');
      el.focus();
      el.value = '';
      return true;
    })()`);
    await page.send("Input.insertText", { text: "\tat com.foo.Gone.gone(Gone.java:3)\n" });
    await page.evaluate(`(() => {
      const el = document.getElementById('stack-trace-input');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
    await h.until(`document.querySelectorAll('#stack-trace-results .stack-missing').length === 1`, 10000);
    const edited = await page.evaluate(PANEL);
    h.check(edited.linked.length === 0 && edited.missing.length === 1 && edited.missing[0].includes("Gone.java"),
      "editing the text re-reads it on its own, and a frame that resolves to nothing says so",
      JSON.stringify(edited.missing));
    await h.shot("unresolved-frame");

    await page.evaluate(`(() => {
      const el = document.getElementById('stack-trace-input');
      el.focus();
      el.value = ${JSON.stringify(TRACE)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await h.until(`document.querySelectorAll('#stack-trace-results .stack-item').length === 4`, 15000);
    await page.evaluate(`(() => { document.getElementById('stack-trace-input').focus(); return true; })()`);
    await page.key("Enter", "Enter", 13, 4);
    await h.until(`sourceOpenPath() === 'src/main/java/com/foo/Bar.java'`, 10000);
    const first = await page.evaluate(CARET);
    h.check(first.line === 5, "⌘Enter goes to the first frame that resolves — where it blew up", JSON.stringify(first));
  } finally {
    await page.evaluate(`(() => { window.kakapoClipboard.write(${JSON.stringify(String(held ?? ""))}); return true; })()`);
  }
});
