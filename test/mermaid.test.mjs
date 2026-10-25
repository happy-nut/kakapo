// Mermaid is not decoration here, and it had no test at all.
//
// An agent answering in a review thread can embed a ```mermaid fence (23-agent-cards.js splits on it,
// 07-comments.js renders the pass). The point is not the picture: a node can be a LINK into the code —
// the codebase-map prompt asks for `click A "#kakapo:path:line"`, and 20-mermaid.js intercepts that
// anchor and calls navigateToLine. A diagram is a map you click into, which is why the library is worth
// 5.2 MB of lazily-loaded asset.
//
// The only test that touched any of this replaced the renderer with a stub ("the real one needs the
// lazy-loaded lib") and asserted a placeholder div appeared. So nothing verified that the bundled library
// still works, and a major version bump could not fail any test — which is exactly what came up when
// mermaid went 11 -> 12.
//
// What is deliberately NOT tested here is render(). It measures text through SVGGraphicsElement.getBBox,
// which jsdom does not implement; shimming that cascades into getComputedTextLength and friends until the
// test is measuring the shims instead of Mermaid, and a green light that means "my stubs agree with each
// other" is worse than no test. Layout belongs to the packaged Electron pass. Grammar, API shape and the
// config we actually pass are what a version bump breaks, and those need no layout — so they are here.
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

// Loads the ACTUAL file the build copies into dist/monaco — the same bytes the app serves over
// kakapo-asset://. Nothing is stubbed, so this is the library itself answering.
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
    // loadMermaid() resolves on `window.mermaid` and rejects with "mermaid did not register" otherwise,
    // so this is the contract between the build's copy step and the viewer's loader.
    assert.equal(typeof w.mermaid, "object", "window.mermaid exists after the asset runs");
    assert.equal(typeof w.mermaid.parse, "function");
    assert.equal(typeof w.mermaid.render, "function");
    assert.equal(typeof w.mermaid.initialize, "function");
  });
});

test("Mermaid accepts the exact configuration the viewer passes it", () => {
  withMermaid((w) => {
    // 20-mermaid.js re-initializes on every render pass with this shape (themeVariables comes from
    // mermaidThemeVariables, which reads kakapo's live CSS custom properties). A major bump that renamed
    // or rejected any of it would theme every diagram wrong — silently, since render() swallows nothing.
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

    // The control. A parse that cannot fail would satisfy every assertion above while proving nothing,
    // so the guard is only worth having once it is shown to reject a broken fence.
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
    // What mermaid renders for `click A "#kakapo:src/app-main.ts:42"` is an ordinary anchor; the handler
    // parses it as data rather than letting mermaid's own `call` callback run agent-written script.
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
    // The handler splits on ":" and pops the line, then decodes what is left — so an encoded path with
    // its own colon has to come back whole. This is why the line is popped instead of the path being
    // read as parts[0].
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
    // mermaidSources is a module variable: a card re-rendered from cached HTML, or the same note after a
    // reload, arrives with an id whose registry entry is gone. The source rides along in the placeholder
    // for exactly that case — without it the renderer returned silently and left "loading…" on screen.
    const placeholder = v.window.mermaidPlaceholderHtml("graph TD\n  A-->B");
    assert.match(placeholder, /class="explain-mermaid"/);
    assert.match(placeholder, /<pre class="explain-mermaid-src" hidden>/);
    assert.match(placeholder, /A--&gt;B/, "the fence source is escaped into the placeholder, not dropped");
  } finally {
    v.close();
  }
});
