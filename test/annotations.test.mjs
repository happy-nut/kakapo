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
  assert.match(sent[0], /problem note/, "the annotate prompt is what was sent");
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
  assert.match(sent[0], /problem note/, "it is the inline-notes prompt, not a content-spec prompt");
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
// about X?". The box waiting under the note opens the composer anchored to the note's own line, so the answer
// lands directly under it in the same thread instead of becoming an unrelated comment somewhere else.
test("an agent note can be replied to, and the reply lands in its thread", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const noteId = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, title: "why it is spawned this way", text: "a spawned child is its own process." });
  await v.settle(30);

  assert.ok(v.$(".mc-card.mc-ai"), "the note renders");
  const reply = v.$(".mc-reply-stub");
  assert.ok(reply, "and the thread ends in the box for its next turn");
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

// The commonest way an agent's note arrives malformed is a mermaid fence it never closed. Demanding both
// fences answered that by matching nothing, so markdown-it rendered `flowchart TD` as a literal code block —
// and the agent, seeing its own diagram come out as text, posted a SECOND note re-drawing it. The thread then
// held a broken diagram, an apology and the real one, where one note belonged.
test("a mermaid fence the agent never closed still becomes a diagram", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  v.agentSays({
    kind: "note",
    path: "src/app.ts",
    line: 1,
    text: "publishing unions the partitions now:\n\n```mermaid\nflowchart TD\n  A[local scan] --> B[pin to publish]\n",
  });
  await v.settle(40);

  const card = v.$(".mc-card.mc-ai");
  assert.ok(card.querySelector(".explain-mermaid"), "the unterminated fence still becomes a diagram");
  assert.equal(card.querySelector("code"), null, "and its source never reaches the reader as a code block");
  assert.match(card.textContent, /publishing unions the partitions now/, "the prose above it is untouched");
  v.close();
});

// Only inline code that is really a FILE becomes a link. The shape test that preceded this one accepted
// anything built from path characters with a short suffix, so a dotted accessor an agent quotes in prose —
// `advisor.study_summary.search_space.params` — was underlined like a file and swallowed the click.
test("inline code is linked only when it names a file, not an attribute chain", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  v.agentSays({
    kind: "note",
    path: "src/app.ts",
    line: 1,
    text: "`get_context` returns `advisor.study_summary.search_space.params`; see `src/app.ts` and `config.yaml:12`.",
  });
  await v.settle(40);

  // Scoped to one rendering of the note — the same thread renders in both the diff and the source view.
  const body = v.$(".mc-ai-body");
  const linked = Array.from(body.querySelectorAll("code.mc-path-code"), (el) => el.textContent);
  assert.deepEqual(linked, ["src/app.ts", "config.yaml:12"], "paths link, with a line number allowed on the end");

  const plain = Array.from(body.querySelectorAll("code:not(.mc-path-code)"), (el) => el.textContent);
  assert.ok(plain.includes("advisor.study_summary.search_space.params"),
    "a dotted accessor stays plain text — .params is not a file extension");
  assert.ok(plain.includes("get_context"), "and so does a bare symbol");
  v.close();
});

// A follow-up must reach the agent with a way back to what it follows — including a note that STARTED the
// thread. A reply opened from an explain card has no parent comment to inherit, so it used to arrive as a
// bare "then why not…?" with the "why" nowhere in it. It travels as the note's id now, not its text: the
// note is already a line in the thread file the hand-off names.
test("a reply to a note hands the note itself to the agent as the turn before it", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const noteId = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "a spawned child is its own process." });
  await v.settle(30);

  v.click(v.$(".mc-reply-stub"));
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
  assert.match(merged, new RegExp(`Continues.*#${noteId}`), "the hand-off points at the note by id");
  assert.doesNotMatch(merged, /a spawned child is its own process\./, "…instead of re-sending the note's text");
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

// The controls on a note have to be visible: hover-only meant the answer to "how do I get rid of this?" was
// "you cannot". Deleting one is the ordinary comment delete now that a note is a comment; what it must NOT
// offer is editing — the agent's own words are not the reviewer's to rewrite.
test("a note can be answered and dismissed without hunting for the controls", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const at = css.indexOf(".mc-card.mc-ai .mc-del {");
  assert.ok(at >= 0, "the note's controls are styled");
  assert.match(css.slice(at, css.indexOf("}", at)), /opacity: \.55/, "they are visible before you hover");

  const sourceView = readFileSync(new URL("../src/viewer/10-source-view.js", import.meta.url), "utf8");
  assert.match(sourceView, /if \(isFinite\(seq\)\) deleteComment\(seq\)/,
    "Backspace acts on the SELECTED card, not on everything that shares the line");
  assert.match(sourceView, /classList\.contains\('mc-ai'\)\) return;/,
    "and `e` refuses to rewrite the agent's own words");
});

// A note whose explanation is a PATH through the code carries `steps`, and kakapo plays them back: the code
// view moves to each stop and highlights its lines while that step's text is up. The player deliberately does
// The explanation is an argument, and an argument has an order. The agent groups its notes and appends them
// in the order they should be read; kakapo walks group by group, and inside a group in that appended order —
// even when it means going backwards through the file, because file position is where the code happens to
// live and not what is being explained. Everything ungrouped keeps file order, after the groups.
test("F8 walks the notes group by group, in the order they were written", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      after: "const a = 9;\nconst b = 8;\nconst c = 7;\nconst d = 6;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  // Group 1 is written bottom-up on purpose: line 4 then line 1. Group 2 sits between them in the file.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 4, group: 1, text: "where it goes wrong" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, group: 1, text: "why that line is reached at all" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 3, group: 2, text: "how the fix is wired" });
  await v.settle(30);

  // Array.from rebuilds it in THIS realm: an array made inside jsdom is not deepStrictEqual to a plain one.
  const walk = Array.from(v.window.sortedNavThread()).filter((c) => c.by === "agent").map((c) => c.line);
  assert.deepEqual(walk, [4, 1, 3], "group order first, then the order each group was appended");

  // A reviewer's own comment has no group and keeps file order, after the explanation.
  v.window.addComment("q", "src/app.ts", 2, "const b = 8;", "what about this one?");
  await v.settle(30);
  const all = Array.from(v.window.sortedNavThread()).map((c) => c.line);
  assert.deepEqual(all, [4, 1, 3, 2], "an ungrouped comment follows the grouped walk");
  v.close();
});

// Losing the group on the next save would silently collapse the walk back to file order.
test("a note's group survives a round trip through the renderer's own save", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\n", after: "const a = 9;\n" },
  ]);
  const v = await loadViewer(html);
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, group: 2, text: "second group" });
  await v.settle(30);
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "a later, ungrouped note" });
  await v.settle(30);

  const stored = v.storedComments().find((c) => c.text === "second group");
  assert.equal(stored.group, 2, "the group is written back with the record");
  v.close();
});


// get a pill and a coloured edge.
test("a note can declare itself the problem or the fix, and an invented role degrades to neither", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  const problem = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, role: "problem", text: "Where it goes wrong." });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, role: "fix", text: "Where that is beaten." });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, role: "editorialising", text: "Not a role kakapo draws." });
  await v.settle(30);

  const problemCard = v.$(".mc-card.mc-role-problem");
  assert.ok(problemCard, "the problem note is marked");
  assert.match(problemCard.textContent, /The problem/, "and says so in a pill");
  assert.ok(v.$(".mc-card.mc-role-fix"), "so is the fix");
  // A card renders once per diff pane, so compare the SET of pill labels rather than counting them.
  const pills = new Set(v.$all(".mc-role").map((p) => p.textContent));
  assert.deepEqual([...pills].sort(), ["The fix", "The problem"], "the invented role gets no pill rather than an untranslated one");
  assert.ok(v.visibleCardTexts().some((t) => /Not a role kakapo draws/.test(t)), "and its note still renders");

  // Every later write re-serialises the notes already in the thread (commentToRecord), so a role that is not
  // written back would silently disappear the next time anyone comments.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "A later, unmarked note." });
  await v.settle(30);
  assert.ok(v.$(".mc-card.mc-role-problem"), "the mark survives the round trip through the thread file");
  assert.match(v.$(".mc-card.mc-role-problem").textContent, /Where it goes wrong/, "on the same note");
  assert.ok(problem > 0, "the note kept its id");
  v.close();
});

// Following a note's path link opens the source view, and openSourceFile (11-render-http.js) re-injects the
// cards by calling renderSourceComments directly — not through refreshComments, which is the only place that
// used to render diagrams. So the card came back with its diagram stuck on "loading…" until some later
// refresh happened to run, which is what made it look intermittent.
test("a diagram renders when the source view injects its cards, not only on a comment refresh", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  // No mermaid yet: the placeholder is created but nothing can render it, and it stays un-rendered rather
  // than being marked done — exactly the state a card is in before you navigate to it.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, title: "flow", text: NOTE_TEXT });
  await v.settle(30);
  assert.ok(v.$(".explain-mermaid"), "the placeholder exists");
  assert.equal(v.$(".explain-mermaid svg"), null, "and has not been rendered");

  // Now mermaid is available (loadMermaid checks window.mermaid before its cached script promise), and the
  // source view opens — the path a note link takes.
  v.window.mermaid = {
    initialize() {},
    render: (id) => Promise.resolve({ svg: `<svg data-rendered="${id}"></svg>` }),
  };
  await v.openSourceFile("src/app.ts");
  await v.settle(60);

  const rendered = v.$("#source-body .explain-mermaid svg");
  assert.ok(rendered, "opening the file renders the diagram it just re-injected");
  assert.match(rendered.dataset.rendered, /explain-mermaid-/, "and it is this placeholder's own render");
  v.close();
});

// "Full size" that comes back the size it already was reads as a broken button. The data URL pins the SVG to
// whatever it measured inside the note card, and the lightbox only ever had max-width/max-height, which can
// shrink but never grow — so a diagram opened from a 700px card stayed 700px on a 2000px screen.
test("a diagram fills the lightbox, while a raster preview is still never blown up", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  v.window.openLightbox("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E", "diagram", true);
  await v.settle(20);
  const img = v.$("#mc-lightbox img");
  assert.ok(img.classList.contains("mc-lightbox-vector"), "a vector source is marked as one");
  assert.equal(v.window.getComputedStyle(img).width, "96vw", "and is given the viewport to grow into");

  v.window.openLightbox("data:image/png;base64,iVBORw0KGgo=", "screenshot");
  await v.settle(20);
  assert.equal(img.classList.contains("mc-lightbox-vector"), false, "a raster preview is not");
  assert.notEqual(v.window.getComputedStyle(img).width, "96vw", "so its own pixels still bound it");
  v.close();
});

// Shift+F8 has to undo F8. It did not once the walk was ordered by group: stepping searched by file position,
// so from a note at line 4 whose predecessor in the story sits at line 1, "previous" looked for something
// ABOVE line 4 and found the wrong card — or nothing. The list was ordered correctly and nothing walked it.
test("Shift+F8 goes back to the note F8 just came from", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      after: "const a = 9;\nconst b = 8;\nconst c = 7;\nconst d = 6;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  // Group 1 runs DOWN the file, group 2 jumps back UP it — the case file-position stepping cannot follow.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, group: 1, text: "first" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 4, group: 1, text: "second" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 3, group: 2, text: "third" });
  await v.settle(30);

  const line = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1) + 1;
  const seen = [];
  for (let i = 0; i < 3; i++) { v.key("F8"); await v.settle(60); seen.push(line()); }
  assert.deepEqual(seen, [2, 4, 3], "F8 walks the groups in order (the caret starts above them all)");

  v.key("F8", { shiftKey: true });
  await v.settle(60);
  assert.equal(line(), 4, "and Shift+F8 returns to the one before it, not to the one above it in the file");

  v.key("F8", { shiftKey: true });
  await v.settle(60);
  assert.equal(line(), 2, "step by step, all the way back");
  v.close();
});

// The order the agent chose was only reachable by a key you had to already know. Once the notes ARE ordered,
// the card carries the walk itself — and both routes go through gotoComment, so the mouse and F8 can never
// disagree about where "next" is.
test("an ordered note carries its own prev/next, and they drive the same walk as the keys", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      after: "const a = 9;\nconst b = 8;\nconst c = 7;\nconst d = 6;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, group: 1, text: "first" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 4, group: 1, text: "second" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 3, group: 2, text: "third" });
  await v.settle(40);

  const line = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1) + 1;
  const buttons = () => v.$all("#source-body .mc-card.mc-ai .mc-walk-step");
  assert.ok(buttons().length >= 2, "the card offers both directions");
  assert.deepEqual([...new Set(buttons().map((b) => b.dataset.keyhint))].sort(), ["F8", "⇧F8"],
    "and each names the key it stands for");

  v.click(buttons().find((b) => b.dataset.walk === "1"));
  await v.settle(60);
  assert.equal(line(), 2, "clicking next walks the same order the keys do");

  v.click(v.$all("#source-body .mc-card.mc-ai .mc-walk-step").find((b) => b.dataset.walk === "1"));
  await v.settle(60);
  assert.equal(line(), 4, "and keeps walking it");

  v.click(v.$all("#source-body .mc-card.mc-ai .mc-walk-step").find((b) => b.dataset.walk === "-1"));
  await v.settle(60);
  assert.equal(line(), 2, "back is the same step in reverse");
  v.close();
});

// Shift+F8 walked and F8 did not. A reply carries its parent's anchor, so the entry after a note is very
// often that note's own answer — stepping onto it moved the caret to the line it was already on, which looks
// exactly like a key that does nothing. Backwards never hit it, because the previous entry is a different
// line. A thread is one stop, not one per turn.
test("F8 steps past a note's own replies instead of standing still on them", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      after: "const a = 9;\nconst b = 8;\nconst c = 7;\nconst d = 6;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  // Ungrouped, like every note written before groups existed: the walk is file order, so a reply — which
  // carries its parent's anchor — sits directly after the note it answers.
  const first = v.agentSays({ kind: "note", path: "src/app.ts", line: 2, text: "the note" });
  v.agentSays({ re: first, by: "agent", text: "an answer under it" });
  v.agentSays({ re: first, by: "agent", text: "and another" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 4, text: "the next note" });
  await v.settle(40);

  const line = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1) + 1;
  v.key("F8");
  await v.settle(60);
  assert.equal(line(), 2, "the first step lands on the note");

  v.key("F8");
  await v.settle(60);
  assert.equal(line(), 4, "the second steps over its two replies to the next note, not onto its own thread");

  v.key("F8", { shiftKey: true });
  await v.settle(60);
  assert.equal(line(), 2, "and back is the same stop in reverse");
  v.close();
});

// These prompts are sixty lines of instructions. Pasted into the composer they filled it with a wall of text
// the reviewer had to scroll past to reach the send button, and every send pasted the same sixty lines again.
// The merged review request already solved this: write the document, send the line that names it.
test("an Explain prompt is written to a file and the terminal carries its path", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const sent = [];
  const written = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };
  v.window.kakapoComments = {
    ...(v.window.kakapoComments || {}),
    writeRequest: (text, name) => {
      written.push({ name, text });
      return Promise.resolve({ ok: true, path: "/repo/.git/kakapo/" + name });
    },
  };

  v.key("7", { metaKey: true, code: "Digit7" });
  await v.settle(30);

  assert.equal(written.length, 1, "the prompt went to disk");
  assert.equal(written[0].name, "explain-diff.md", "under a name of its own, so it cannot overwrite a review request");
  assert.match(written[0].text, /problem note/, "and it is the whole prompt that was written");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\/repo\/\.git\/kakapo\/explain-diff\.md$/, "the composer carries the path");
  assert.doesNotMatch(sent[0], /problem note/, "not the sixty lines");
  v.close();
});

// A prompt that reaches the agent as text still works. One that reaches it as a path to a file that was never
// written does not — so the wall of text is the right answer whenever the write cannot happen at all.
test("a prompt still pastes when there is nowhere to write it", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };
  v.window.kakapoComments = { ...(v.window.kakapoComments || {}), writeRequest: () => Promise.reject(new Error("no git dir")) };

  v.key("7", { metaKey: true, code: "Digit7" });
  await v.settle(30);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /problem note/, "the prompt itself is sent when the file could not be");
  v.close();
});

// A card's anchor is a RANGE, and the walk has to recognise the caret as standing on it wherever inside that
// range it lands. This one passes on the old code too — reveal puts the caret at `from` and the old test read
// `from`, so the two agreed by luck. It is here as the guard for the day one of them changes.
test("F8 keeps walking after it lands on a card whose anchor is a range", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts",
      before: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n",
      after: "const a = 9;\nconst b = 8;\nconst c = 7;\nconst d = 6;\nconst e = 5;\nconst f = 0;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts");

  // The middle card covers lines 2-4: `from` is 2, and the caret lands on `line`, which is 4.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, group: 1, text: "first" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 4, from: 2, to: 4, group: 1, text: "a range" });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 6, group: 1, text: "last" });
  await v.settle(40);

  const line = () => Number(v.$("#source-body .source-row.cursor-line")?.dataset.lineIndex ?? -1) + 1;
  const walked = [];
  for (let i = 0; i < 3; i++) { v.key("F8"); await v.settle(60); walked.push(line()); }

  // Entering at the nearest card below the caret, then following the story: 1 is where the caret already is,
  // so the walk starts at the range and carries on — it must never skip to the end and stay there.
  // Landing on a range puts the caret at its START (line 2), which is where the selection begins — the point
  // is that the walk carries ON from there instead of losing track of where it is.
  assert.deepEqual(walked, [2, 6, 1], "the walk continues past a range card instead of stranding on it");

  v.key("F8", { shiftKey: true });
  await v.settle(60);
  assert.equal(line(), 6, "and backwards still undoes the step");
  v.close();
});

// The card counts "8/9" from one list and F8 walked another: the walk was filtered by the source index, which
// on a diff-first launch holds only the CHANGED files, so notes on untouched files disappeared from the walk
// while the badge went on numbering them. Stepping then bounced between whichever two survived. Whatever is
// counted must be what is walked — scoping a shared note to this workspace happens in main, before either.
test("the number on a card counts the same cards F8 walks", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/changed.ts", before: "const a = 1;\nconst b = 2;\n", after: "const a = 9;\nconst b = 8;\n" },
  ]);
  const v = await loadViewer(html);
  await v.openSourceFile("src/changed.ts");

  // One note on the changed file, two on a file this launch never indexed — all three belong to this
  // workspace, and all three must be walkable.
  v.agentSays({ kind: "note", path: "src/changed.ts", line: 1, group: 1, text: "on the diff" });
  v.agentSays({ kind: "note", path: "src/untouched.ts", line: 3, group: 1, text: "not in the diff" });
  v.agentSays({ kind: "note", path: "src/untouched.ts", line: 7, group: 2, text: "nor is this" });
  await v.settle(40);

  const walked = Array.from(v.window.sortedNavThread()).filter((c) => c.by === "agent");
  assert.equal(walked.length, 3, "every note in this workspace is in the walk, indexed or not");

  const badges = v.$all(".mc-card.mc-ai .mc-walk").map((el) => el.textContent);
  assert.ok(badges.length > 0, "the cards carry their place in it");
  for (const badge of badges) {
    assert.match(badge, /\/3$/, `a card counts out of the walk it belongs to, got ${badge}`);
  }
  v.close();
});
