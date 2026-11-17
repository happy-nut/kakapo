import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "AGENTS.md", before: "# kakapo\n", after: "# kakapo\n\nnotes\n" },
  ]));
});
after(() => cleanupFixtures());

function withMermaid(fn) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "dangerously", pretendToBeVisual: true });
  try {
    const script = dom.window.document.createElement("script");
    script.textContent = readFileSync(new URL("../dist/monaco/mermaid.js", import.meta.url), "utf8");
    dom.window.document.head.appendChild(script);
    return fn(dom.window);
  } finally {
    dom.window.close();
  }
}

test("the copied Mermaid asset registers the global the lazy loader waits for", () => {
  withMermaid((w) => {
    assert.equal(typeof w.mermaid, "object", "window.mermaid exists after the asset runs");
    assert.equal(typeof w.mermaid.parse, "function");
    assert.equal(typeof w.mermaid.render, "function");
    assert.equal(typeof w.mermaid.initialize, "function");
  });
});

test("Mermaid accepts the exact configuration the viewer passes it", () => {
  withMermaid((w) => {
    w.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        background: "#171b21", primaryColor: "#1d232c", primaryTextColor: "#d8e0eb",
        primaryBorderColor: "#58a6ff", lineColor: "#94a0af", textColor: "#d8e0eb",
        actorBkg: "#1d232c", noteBkgColor: "#1d232c", labelTextColor: "#d8e0eb",
      },
    });
  });
});

test("the bundled Mermaid parses the diagram kinds an agent writes — and rejects what it should", async () => {
  await withMermaid(async (w) => {
    assert.equal((await w.mermaid.parse("graph TD\n  A-->B\n")).diagramType, "flowchart-v2",
      "a flowchart is what the codebase-map prompt asks for");
    assert.equal((await w.mermaid.parse("sequenceDiagram\n  A->>B: hi\n")).diagramType, "sequence");
    assert.equal((await w.mermaid.parse("stateDiagram-v2\n  s1 --> s2\n")).diagramType, "stateDiagram");

    await assert.rejects(() => w.mermaid.parse("graph TD\n  A-->"),
      "a malformed fence is refused rather than silently accepted");
  });
});

test("a diagram node that links into the code navigates there instead of following the href", async () => {
  const v = await loadViewer(html);
  try {
    const calls = [];
    v.window.navigateToLine = (path, line) => { calls.push(`${path}:${line}`); };

    const host = v.document.createElement("div");
    host.className = "explain-mermaid";
    host.innerHTML = '<svg><a href="#kakapo:src/app-main.ts:42">main</a></svg>';
    v.document.body.appendChild(host);
    v.click(host.querySelector("a"));

    assert.deepEqual(calls, ["src/app-main.ts:42"], "the click became a jump to that file and line");
  } finally {
    v.close();
  }
});

test("a path with a colon or a space survives the round trip through the href", async () => {
  const v = await loadViewer(html);
  try {
    const calls = [];
    v.window.navigateToLine = (path, line) => { calls.push(`${path}:${line}`); };

    const host = v.document.createElement("div");
    host.className = "explain-mermaid";
    host.innerHTML = '<svg><a href="#kakapo:src/a%20b%3Ac.ts:7">x</a></svg>';
    v.document.body.appendChild(host);
    v.click(host.querySelector("a"));

    assert.deepEqual(calls, ["src/a b:c.ts:7"]);
  } finally {
    v.close();
  }
});

test("an ordinary link inside a diagram keeps its own meaning", async () => {
  const v = await loadViewer(html);
  try {
    const calls = [];
    v.window.navigateToLine = (path, line) => { calls.push(`${path}:${line}`); };

    const host = v.document.createElement("div");
    host.className = "explain-mermaid";
    host.innerHTML = '<svg><a href="https://example.com/docs">docs</a></svg>';
    v.document.body.appendChild(host);
    v.click(host.querySelector("a"));

    assert.deepEqual(calls, [], "a non-kakapo href is not hijacked into a code jump");
  } finally {
    v.close();
  }
});

test("a diagram placeholder carries its own source, so a re-render is not stuck on 'loading…'", async () => {
  const v = await loadViewer(html);
  try {
    const placeholder = v.window.mermaidPlaceholderHtml("graph TD\n  A-->B");
    assert.match(placeholder, /class="explain-mermaid"/);
    assert.match(placeholder, /<pre class="explain-mermaid-src" hidden>/);
    assert.match(placeholder, /A--&gt;B/, "the fence source is escaped into the placeholder, not dropped");
  } finally {
    v.close();
  }
});
