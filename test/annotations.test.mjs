// Agent-written inline diff annotations (annotations.json -> note cards on the diff) and the ⌘⇧P prompt
// palette that sends the prompt producing them. Covers both ends: the main-process file watcher, and the
// renderer's store -> thread-row rendering (including the Mermaid fence lift-out).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { annotationsFilePath, refreshAnnotationsIfChanged, registerAnnotationsIpc } from "../dist/app-annotations-ipc.js";

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
  // ⌘⇧P has no dialog of its own: it opens the ⌘E launcher on its Prompts section.
  assert.equal(v.$("#quick-open").classList.contains("hidden"), false, "⌘⇧P opens the launcher");
  assert.ok(v.$("#quick-open").classList.contains("quick-launcher"), "with its section rail");
  assert.ok(v.$('#quick-open-side .quick-open-side-item[data-section="prompts"]').classList.contains("active"), "on the Prompts section");
  const items = v.$all("#quick-open-results .quick-open-item");
  // Only the prompts a human sends deliberately — the merge prompts ride along with the merged hand-off.
  assert.equal(items.length, 1, "the section lists the one send-on-purpose prompt");
  assert.match(items[0].textContent, /diff/i, "it is the inline-diff explanation prompt");

  v.key("Enter");
  await v.settle(10);
  assert.equal(sent.length, 1, "Enter hands the prompt to the terminal send composer");
  assert.match(sent[0], /12-year-old/, "the annotate prompt is what was sent");
  assert.doesNotMatch(sent[0], /\{\{NOTES_PATH\}\}/, "the notes-path placeholder is substituted before sending");
  assert.ok(v.$("#quick-open").classList.contains("hidden"), "sending closes the launcher");
  v.close();
});

// Explain is the annotations, not a panel: ⌘7 asks for them and F8 walks them with everything else. Guards the regression where
// ⌘7 opened a second reading surface the reviewer had to hold beside the diff.
test("⌘7 runs Explain in place and opens no view of its own", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  v.key("7", { metaKey: true, code: "Digit7" });
  await v.settle(10);
  assert.equal(sent.length, 1, "⌘7 stages the annotate prompt in the terminal composer");
  assert.match(sent[0], /12-year-old/, "it is the inline-notes prompt, not a content-spec prompt");
  assert.equal(v.$("#explain-view"), null, "no Explain overlay exists to open");
  v.close();
});

test("F8 and Shift+F8 walk the agent's notes", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\n", after: "const a = 9;\nconst b = 8;\nconst c = 7;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  v.key("F8");
  await v.settle(30);
  const cursorLine = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1);

  // Written out of order on purpose: stepping follows the diff, not the order the agent emitted them.
  v.window.setAnnotations([
    { path: "src/app.ts", line: 3, text: "why c changed" },
    { path: "src/app.ts", line: 2, text: "why b changed" },
  ]);
  await v.settle(30);

  // The caret starts on line 1, so "next" is the first note below it.
  v.key("F8");
  await v.settle(80);
  assert.equal(cursorLine(), 1, "F8 steps to the nearest note below the caret");

  v.key("F8");
  await v.settle(80);
  assert.equal(cursorLine(), 2, "a second F8 steps to the next note");

  v.key("F8", { shiftKey: true });
  await v.settle(80);
  assert.equal(cursorLine(), 1, "Shift+F8 steps back");
  v.close();
});

// An explanation is as often the start of a conversation as the end of one — "why this way?", "then what
// about X?". Reply on a note opens the composer anchored to the note's own line, so the answer lands
// directly under it in the same thread instead of becoming an unrelated comment somewhere else.
test("an agent note can be replied to, and the reply lands in its thread", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  v.window.setAnnotations([{ path: "src/app.ts", line: 1, title: "why it is spawned this way", text: "a spawned child is its own process." }]);
  await v.settle(30);

  const note = v.$(".mc-card.mc-ai");
  assert.ok(note, "the note renders");
  const reply = note.querySelector(".mc-ai-reply");
  assert.ok(reply, "with a reply affordance");
  assert.equal(reply.dataset.path, "src/app.ts", "carrying its own anchor");
  assert.equal(reply.dataset.line, "1");

  v.click(reply);
  await v.settle(40);
  const composer = v.$(".mc-composer .mc-input");
  assert.ok(composer, "clicking it opens a composer");
  // threadHtml renders notes first, then that line's comments, then the composer — so a composer existing
  // after the click means the reply is anchored to the note's line, in its thread.
  assert.ok(v.$(".mc-composer .mc-input"), "the composer is open on that line");
  v.close();
});

// F8 walks the review timeline, and an agent's note is part of it: the two used to be on separate keys, so
// stepping with F8 through a file the agent had explained reported "no comments" and moved nothing.
test("F8 steps to an agent note, not only to the reviewer's own comments", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\n", after: "const a = 9;\nconst b = 8;\nconst c = 7;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");
  const line = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1);
  // Establish the caret the same way the F8 walk test does, then hand the note to the store.
  v.key("F8");
  await v.settle(30);
  v.window.setAnnotations([{ path: "src/app.ts", line: 3, title: "why", text: "because." }]);
  await v.settle(30);

  v.key("F8");
  await v.settle(80);
  assert.equal(line(), 2, "F8 lands on the note's line, with no comments in the file at all");
  v.close();
});

// A note in the timeline is deletable like anything else in it — and the delete has to reach the FILE. The
// list is re-read from annotations.json on every poll tick, so a renderer-only delete reappears a second
// later; rewriting the file is also what makes it survive a restart.
test("dismissing a note rewrites annotations.json, so it does not come back on the next tick", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-annot-del-"));
  execFileSync("git", ["init", "-q", root]);
  const file = annotationsFilePath(root);
  const keep = { path: "src/a.ts", line: 7, text: "keep me" };
  const drop = { path: "src/a.ts", line: 3, text: "drop me" };
  mkdirSync(join(root, ".git", "kakapo"), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, notes: [keep, drop] }));

  const state = fakeWindowState(root);
  const handlers = new Map();
  registerAnnotationsIpc({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, () => state);

  refreshAnnotationsIfChanged(state); // seed: both notes are known
  assert.equal(state.annotationNotes.length, 2);

  const result = handlers.get("kakapo:annotations-delete")({}, drop);
  assert.equal(result.ok, true, "the note was found and removed");

  const onDisk = JSON.parse(readFileSync(file, "utf8")).notes;
  assert.deepEqual(onDisk, [keep], "the file no longer carries it");
  assert.deepEqual(state.annotationNotes, [keep], "and the renderer was pushed the new list immediately");

  // The poller must agree: nothing changed since the write, and the note stays gone.
  refreshAnnotationsIfChanged(state);
  assert.deepEqual(state.annotationNotes, [keep], "a later tick does not resurrect it");

  assert.equal(handlers.get("kakapo:annotations-delete")({}, { path: "src/a.ts", line: 99, text: "nope" }).ok, false,
    "a note that is not there is not a write");
  rmSync(root, { recursive: true, force: true });
});
