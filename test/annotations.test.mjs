// Agent-written inline diff annotations (annotations.json -> note cards on the diff) and the ⌘⇧P prompt
// palette that sends the prompt producing them. Covers both ends: the main-process file watcher, and the
// renderer's store -> thread-row rendering (including the Mermaid fence lift-out).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { annotationsFilePath, refreshAnnotationsIfChanged } from "../dist/app-explain-ipc.js";

after(cleanupFixtures);

const NOTE_TEXT = [
  "Without this the window can close mid-load and the callback lands on state that is already gone.",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant Renderer",
  "  participant Main",
  "  Renderer->>Main: close",
  "```",
].join("\n");

function fakeWindowState(root) {
  const sent = [];
  return {
    sent,
    win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } },
    options: { root },
    explainSig: "",
    explainSpec: null,
    explainUpdatedAt: null,
    annotationsSig: "",
    annotationNotes: [],
  };
}

test("main pushes annotations.json to the renderer only when it actually changes", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-annotations-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const file = annotationsFilePath(root);
    assert.ok(file, "a git repository yields an annotations path");

    const state = fakeWindowState(root);
    refreshAnnotationsIfChanged(state);
    assert.equal(state.sent.length, 0, "no file yet -> nothing pushed");

    mkdirSync(join(root, ".git", "kakapo"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, notes: [{ path: "src/app.ts", line: 1, text: "why" }] }));
    refreshAnnotationsIfChanged(state);
    assert.equal(state.sent.length, 1, "a fresh file is pushed once");
    assert.equal(state.sent[0].channel, "kakapo:annotations-update");
    assert.equal(state.sent[0].payload.notes[0].text, "why");

    refreshAnnotationsIfChanged(state);
    assert.equal(state.sent.length, 1, "an unchanged file is not re-pushed");

    // A half-written file (the agent is mid-save) must not advance the signature, so the next tick retries.
    writeFileSync(file, '{"version": 1, "notes": [');
    refreshAnnotationsIfChanged(state);
    assert.equal(state.sent.length, 1, "unparseable content is skipped, not pushed");
    writeFileSync(file, JSON.stringify({ version: 1, notes: [{ path: "src/app.ts", line: 1, text: "later" }] }));
    refreshAnnotationsIfChanged(state);
    assert.equal(state.sent.length, 2, "the completed write is picked up on the following tick");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent notes render as cards on their diff line, with Mermaid lifted out of the markdown", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  v.window.setAnnotations([{ path: "src/app.ts", line: 1, title: "closing mid-load", text: NOTE_TEXT }]);
  await v.settle(30);

  const card = v.$(".mc-card.mc-ai");
  assert.ok(card, "the note renders as a card in the diff timeline");
  assert.match(card.textContent, /closing mid-load/, "the title is shown");
  assert.ok(card.querySelector("p"), "prose goes through the markdown pipeline");
  const diagram = card.querySelector(".explain-mermaid");
  assert.ok(diagram, "a ```mermaid fence becomes a diagram placeholder, not a code block");
  assert.equal(card.querySelector("code"), null, "the diagram source never reaches the syntax highlighter");

  // The agent is talking TO the reviewer: these must not leak into the reviewer's own comment channels.
  v.window.addComment("c", "src/app.ts", 1, "export const n = 2;", "please rename this");
  await v.settle(30);
  const merged = v.window.buildMergedText();
  assert.match(merged, /please rename this/);
  assert.doesNotMatch(merged, /closing mid-load/, "notes stay out of the merged agent prompt");
  assert.equal(v.storedComments().length, 1, "notes are not persisted into the review comment store");

  v.window.setAnnotations([]);
  await v.settle(30);
  assert.equal(v.$(".mc-card.mc-ai"), null, "a regenerated (empty) note list clears the cards");
  assert.ok(v.$(".mc-card.mc-c"), "the reviewer's own comment survives the swap");
  v.close();
});

test("the prompt palette lists the saved prompts and sends the selected one to the terminal", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(10);
  assert.ok(!v.$("#prompt-palette").classList.contains("hidden"), "⌘⇧P opens the palette");
  const items = v.$all(".prompt-palette-item");
  assert.equal(items.length, 5, "every editable prompt is listed");
  assert.match(items[0].textContent, /diff/i, "the inline-diff explanation prompt leads the list");

  v.key("Enter");
  await v.settle(10);
  assert.equal(sent.length, 1, "Enter hands the prompt to the terminal send composer");
  assert.match(sent[0], /12-year-old/, "the annotate prompt is what was sent");
  assert.doesNotMatch(sent[0], /\{\{NOTES_PATH\}\}/, "the notes-path placeholder is substituted before sending");
  assert.ok(v.$("#prompt-palette").classList.contains("hidden"), "sending closes the palette");
  v.close();
});
