// An agent's Explain notes and the ⌘⇧P prompt palette that produces them. A note is a comment whose author
// is the agent, so it arrives on the same channel as everything else in the thread (comments-file.ts, covered
// in comments-file.test.mjs) and renders in the same thread row — the difference is who wrote it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

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



test("agent notes render as cards on their diff line, with Mermaid lifted out of the markdown", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, title: "closing mid-load", text: NOTE_TEXT });
  await v.settle(30);

  const card = v.$(".mc-card.mc-ai");
  assert.ok(card, "the note renders as a card in the diff timeline");
  assert.match(card.textContent, /closing mid-load/, "the title is shown");
  assert.ok(card.querySelector("p"), "prose goes through the markdown pipeline");
  const diagram = card.querySelector(".explain-mermaid");
  assert.ok(diagram, "a ```mermaid fence becomes a diagram placeholder, not a code block");
  assert.equal(card.querySelector("code"), null, "the diagram source never reaches the syntax highlighter");

  // The agent is talking TO the reviewer: a note is never a request going back to it.
  v.window.addComment("c", "src/app.ts", 1, "export const n = 2;", "please rename this");
  await v.settle(30);
  const merged = v.window.buildMergedText();
  assert.match(merged, /please rename this/);
  assert.doesNotMatch(merged, /closing mid-load/, "notes stay out of the merged agent prompt");
  assert.equal(v.storedComments().filter((c) => c.by === "agent").length, 1, "but it IS in the one store, as the agent's");

  v.$(".mc-card.mc-ai .mc-del").click();
  await v.settle(30);
  assert.equal(v.$(".mc-card.mc-ai"), null, "and it is dismissed like any other card");
  assert.ok(v.$(".mc-card.mc-c"), "the reviewer's own comment is untouched");
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
  assert.equal(items.length, 2, "the section lists the send-on-purpose prompts");
  assert.match(items[0].textContent, /diff/i, "the inline-diff explanation prompt is first");
  assert.match(items[1].textContent, /codebase/i, "then the codebase map");

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
  v.agentSays({ kind: "note", path: "src/app.ts", line: 3, text: "why c changed" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, text: "why b changed" });
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
  const noteId = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, title: "why it is spawned this way", text: "a spawned child is its own process." });
  await v.settle(30);

  const note = v.$(".mc-card.mc-ai");
  assert.ok(note, "the note renders");
  const reply = note.querySelector(".mc-reply");
  assert.ok(reply, "with a reply affordance");
  assert.equal(Number(reply.dataset.seq), noteId, "pointing at the note itself");

  v.click(reply);
  await v.settle(40);
  const composer = v.$(".mc-composer .mc-input");
  assert.ok(composer, "clicking it opens a composer");
  // threadHtml renders notes first, then that line's comments, then the composer — so a composer existing
  // after the click means the reply is anchored to the note's line, in its thread.
  assert.ok(v.$(".mc-composer .mc-input"), "the composer is open on that line");
  v.close();
});

// The agent writes the next turn of a thread from the checklist alone, so every earlier turn has to travel
// with it — including the note that STARTED the thread. A reply opened from an explain card has no parent
// comment to inherit, so it used to reach the agent as a bare "then why not…?" with the "why" nowhere in it.
test("a reply to a note hands the note itself to the agent as the turn before it", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const noteId = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "a spawned child is its own process." });
  await v.settle(30);

  v.click(v.$(".mc-card.mc-ai .mc-reply"));
  await v.settle(40);
  await v.writeAndSave("then why not fork it instead?");
  await v.settle(60);

  const followUp = v.storedComments().find((c) => c.replyTo === noteId);
  assert.ok(followUp, "the follow-up hangs off the note itself");
  const thread = v.window.commentThreadContext(followUp);
  assert.equal(thread.length, 1, "so it carries exactly one earlier turn");
  assert.equal(thread[0].by, "agent", "…the agent's");
  assert.equal(thread[0].text, "a spawned child is its own process.", "…and it is the note's own text");
  const merged = v.window.buildMergedText();
  assert.match(merged, /> \S+: a spawned child is its own process\./, "the hand-off quotes it, marked as the agent's own words");
  assert.match(merged, /then why not fork it instead\?/, "…ahead of the follow-up itself");
  v.close();
});

// Clicking a diagram opens it full-size in an <img>, which parses its source as standalone XML — and
// .outerHTML is an HTML serialization: no xmlns, and label markup inside <foreignObject> left as HTML, where
// a single unclosed <br> is fatal. The lightbox showed a broken-image icon.
test("a zoomed diagram serializes to XML an <img> can actually parse", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const host = v.document.createElement("div");
  host.innerHTML = '<svg viewBox="0 0 10 10"><foreignObject><div>a<br>b</div></foreignObject></svg>';
  v.document.body.appendChild(host);

  const url = v.window.mermaidSvgDataUrl(host.querySelector("svg"));
  assert.ok(url.startsWith("data:image/svg+xml"), "still a data URL the lightbox can use as an src");
  const xml = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  assert.match(xml, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "carries the namespace it can no longer inherit");
  const parsed = new v.window.DOMParser().parseFromString(xml, "image/svg+xml");
  assert.equal(parsed.querySelector("parsererror"), null, "and parses as XML — the <br> is closed, not dangling");
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
  v.agentSays({ kind: "note", path: "src/app.ts", line: 3, title: "why", text: "because." });
  await v.settle(30);

  v.key("F8");
  await v.settle(80);
  assert.equal(line(), 2, "F8 lands on the note's line, with no comments in the file at all");
  v.close();
});


// The codebase prompt writes the SAME notes file the diff prompt does — its map and its per-component notes
// are ordinary notes on the code, navigable with F8 and answerable like any other card. What differs is what
// the agent is asked to look at. Its diagram nodes carry `#kakapo:path:line` links, which the viewer turns
// into navigation rather than handing to mermaid's script callback (securityLevel is strict for a reason:
// the diagram source is agent-written).
test("the codebase prompt is a second editable prompt writing the same notes contract", async () => {
  const { MESSAGES } = await import("../dist/i18n.js");
  for (const locale of ["en", "ko"]) {
    const prompt = MESSAGES[locale]["codebase.prompt.default"];
    assert.ok(prompt, `${locale} has the prompt`);
    assert.ok(prompt.includes("{{NOTES_PATH}}"), "it writes to this workspace's notes file");
    assert.ok(prompt.includes("#kakapo:"), "its diagram nodes link into the code");
    assert.match(prompt, /3-5|3~5/, "it asks for a handful of components, not every directory");
  }

  const palette = readFileSync(new URL("../src/viewer/24-prompt-palette.js", import.meta.url), "utf8");
  assert.match(palette, /id: 'codebase'[\s\S]{0,120}currentCodebasePromptText/, "the launcher offers it");
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(render, /settings-prompt-codebase/, "and settings can edit it");

  const mermaid = readFileSync(new URL("../src/viewer/20-mermaid.js", import.meta.url), "utf8");
  assert.match(mermaid, /#kakapo:[\s\S]{0,400}navigateToLine/, "a node link navigates to the component");
  assert.match(mermaid, /openLightbox/, "and any diagram opens full-size on click");
  assert.match(mermaid, /securityLevel: 'strict'/, "without loosening mermaid's script policy");
});

// A diagram that never finishes loading is worse than one that fails: "loading…" reads as "wait a moment"
// forever. The source is carried IN the placeholder as well as in the module registry, because a card
// re-rendered from cached HTML — or the same note after a reload — arrives with an id the registry no longer
// knows, and the renderer used to return silently and leave the placeholder as it was.
test("a diagram carries its own source, and a stuck load becomes a visible failure", () => {
  const mermaid = readFileSync(new URL("../src/viewer/20-mermaid.js", import.meta.url), "utf8");
  assert.match(mermaid, /explain-mermaid-src[\s\S]{0,200}escapeHtml\(String\(src\)\)/,
    "the placeholder carries its own source");
  assert.match(mermaid, /mermaidSources\[node\.id\] \|\| \(carried \? carried\.textContent : ''\)/,
    "and the renderer falls back to it");
  assert.match(mermaid, /if \(!src\)[\s\S]{0,120}diagramInvalid/, "no source is a failure, not a forever-loading state");
  assert.match(mermaid, /setTimeout\([\s\S]{0,80}load timed out/, "and a load that never settles times out");
  assert.match(mermaid, /closest\('\.explain-mermaid'\)/, "the zoom/link handler matches the class actually used");
});

// The controls on a note have to be visible: hover-only meant the answer to "how do I comment on this?" was
// "you cannot". Deleting one is the ordinary comment delete now that a note is a comment; what it must NOT
// offer is editing — the agent's own words are not the reviewer's to rewrite.
test("a note can be answered and dismissed without hunting for the controls", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const at = css.indexOf(".mc-card.mc-ai .mc-reply,");
  assert.ok(at >= 0, "the note's controls are styled");
  assert.match(css.slice(at, css.indexOf("}", at)), /opacity: \.55/, "they are visible before you hover");

  const sourceView = readFileSync(new URL("../src/viewer/10-source-view.js", import.meta.url), "utf8");
  assert.match(sourceView, /if \(isFinite\(seq\)\) removeComments\(\[seq\]\)/,
    "Backspace on a selected card removes exactly that one");
  assert.match(sourceView, /classList\.contains\('mc-ai'\)\) return;/,
    "and `e` refuses to rewrite the agent's own words");
});
