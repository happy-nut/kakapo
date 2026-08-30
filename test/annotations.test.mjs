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
  assert.equal(items.length, 3, "the section lists the send-on-purpose prompts");
  assert.match(items[0].textContent, /diff/i, "the inline-diff explanation prompt is first");
  assert.match(items[1].textContent, /codebase/i, "then the codebase map");
  // …and the one that is about the conversation rather than the code: it asks the agent to record the words
  // the reader took in during an ordinary terminal exchange, which nothing else in kakapo can see.
  assert.match(items[2].textContent, /learned|배운 말/i, "then keeping what a terminal conversation taught");

  v.key("Enter");
  await v.settle(10);
  assert.equal(sent.length, 1, "Enter hands the prompt to the terminal send composer");
  assert.match(sent[0], /"kind":"note"/, "the annotate prompt is what was sent");
  assert.doesNotMatch(sent[0], /\{\{NOTES_PATH\}\}/, "the notes-path placeholder is substituted before sending");
  assert.ok(v.$("#quick-open").classList.contains("hidden"), "sending closes the launcher");
  v.close();
});

// Explain has no rail entry any more: sending the prompt is the ⌘⇧P palette's job, and reading the notes is
// the briefing's (⌘⇧B). Guards that no third door — rail button, launcher row, or the old ⌘7 — comes back.
test("Explain lives only in the palette: no rail button, launcher row, or ⌘7", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ], { app: true }); // the rail only exists in the Electron review
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  v.key("7", { metaKey: true, code: "Digit7" });
  await v.settle(10);
  assert.equal(sent.length, 0, "⌘7 is not a shortcut any more");

  assert.equal(v.$('.rail-btn[data-view="explain"]'), null, "the rail has no Explain button");
  assert.equal(v.$('.quick-open-side-item[data-section="explain"]'), null, "the launcher lists no Explain row");
  assert.equal(v.$("#explain-view"), null, "no Explain overlay exists to open");
  v.close();
});

// A comment on a changed line belongs beside its change. Which view you happened to be in decided that: the
// walk only tried the diff when the diff was already on screen, so stepping from the Files tree read every
// card in the source view — the change it was about nowhere in sight. Now the diff is tried first and only a
// line no hunk covers falls back.
test("the walk shows a comment in the diff when the diff can show it, whichever view you start in", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\n", after: "const a = 9;\nconst b = 8;\n" },
  ], { app: true });
  const v = await loadViewer(html);
  await v.openSourceFile("src/app.ts"); // start in Files, deliberately
  assert.equal(v.window.isSourceViewerVisible(), true, "the source view is what is on screen");

  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, group: 1, text: "on a changed line" });
  await v.settle(30);

  v.key("F8");
  await v.settle(80);
  assert.equal(v.window.isDiffViewVisible(), true, "stepping to it brought the diff up");
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
  const cursorLine = () => v.caretLine() - 1;

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

// A path several folders deep spends most of a line naming directories the sentence was not about. It folds to
// the filename with a (…) in front, and the whole path is still there — in the DOM, in data-path, and one
// click away — because folding it must not cost the reader the thing they might have needed it for.
test("a deep path folds to its filename, unfolds on click, and still opens the file it names", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const deep = "turtle/backend/src/app/stock/backtest/domain/evaluation_policy.py:27";
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "See `" + deep + "` and `src/app.ts`." });
  await v.settle(40);

  const body = v.$(".mc-ai-body");
  const [folded, shallow] = Array.from(body.querySelectorAll("code.mc-path-code"));
  assert.equal(folded.dataset.path, deep, "the whole path is carried on the element");
  assert.equal(folded.querySelector(".mc-path-dir").textContent, "turtle/backend/src/app/stock/backtest/domain",
    "…and the folded part is the directories, not dropped");
  assert.ok(folded.querySelector("button.mc-path-ell"), "a (…) control stands in for them");
  assert.equal(folded.title, deep, "hovering says the whole path without a click");

  // One directory deep is left alone: folding it would save no room and cost a click.
  assert.equal(shallow.querySelector(".mc-path-ell"), null, "`src/app.ts` is short enough already");
  assert.equal(shallow.textContent, "src/app.ts");

  // The (…) unfolds. It does NOT follow the path — that is what the rest of the link is for.
  const opened = [];
  v.window.openPathReference = (ref) => opened.push(ref);
  v.click(folded.querySelector("button.mc-path-ell"));
  assert.ok(folded.classList.contains("mc-path-open"), "clicking the (…) opens the path");
  assert.deepEqual(opened, [], "…and does not navigate on the way");

  v.click(folded);
  assert.deepEqual(opened, [deep], "clicking the path itself still opens the file, whole path and all");
  v.close();
});

// The same file, in one note, used to come out three different ways: folded when the span was nothing but the
// path, spelled out in full when git's status marker sat in front of it, and — unquoted — as a blue external
// link, because half the extensions agents name are country TLDs and linkify treats `chart.py` as a domain.
test("a path reads the same wherever it appears in a note, and a bare filename is never an external link", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);
  const deep = "turtle/backend/src/app/shared/strategies/daily/turtle.py";
  v.agentSays({
    kind: "note",
    path: "src/app.ts",
    line: 1,
    text: "워킹트리에서 `M " + deep + "` 로 잡힙니다. `" + deep + "` 를 보세요. chart.py 는 그대로 두고, https://example.com 참고.",
  });
  await v.settle(40);

  const body = v.$(".mc-ai-body");
  const chips = Array.from(body.querySelectorAll(".mc-path-code"));
  assert.deepEqual(chips.map((el) => el.dataset.path), [deep, deep], "both mentions are the same path chip");
  assert.deepEqual(chips.map((el) => el.querySelector(".mc-path-dir").textContent),
    ["turtle/backend/src/app/shared/strategies/daily", "turtle/backend/src/app/shared/strategies/daily"],
    "and both fold the same directories away");
  assert.match(chips[0].parentElement.textContent, /^M\s/, "git's status marker stays in front of the marked path");

  const links = Array.from(body.querySelectorAll("a"), (a) => a.getAttribute("href"));
  assert.deepEqual(links, ["https://example.com"], "a real URL still links; `chart.py` is not a domain");
  assert.doesNotMatch(body.innerHTML, /mc-path-code[^>]*data-path="chart\.py"/,
    "a filename this project does not have stays prose rather than becoming a dead link");
  v.close();
});

// The other half of the same complaint: an agent refers to a file it is not editing the way anyone does — by
// its name, no directory — and that mention has to reach the file too. The path it is missing is one the
// project index knows, so it gets filled in and the mention reads like every other mention of that file.
test("a file named without its directory gets the path filled in, in prose and in backticks alike", async () => {
  const { html } = await makeReviewHtml([
    { path: "turtle/backend/src/app/stock/backtest/chart.py", before: "a = 1\n", after: "a = 2\n" },
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const full = "turtle/backend/src/app/stock/backtest/chart.py";
  const v = await loadViewer(html);
  v.agentSays({
    kind: "note",
    path: "src/app.ts",
    line: 1,
    text: "chart.py 가 이 모듈을 씁니다 (`chart.py:106`). 버전 1.5 는 그대로.",
  });
  await v.settle(40);

  const body = v.$(".mc-ai-body");
  const chips = Array.from(body.querySelectorAll(".mc-path-code"));
  assert.deepEqual(chips.map((el) => el.dataset.path), [full, full + ":106"],
    "both the prose mention and the backticked one carry the whole path, line number kept");
  assert.ok(chips.every((el) => el.querySelector(".mc-path-dir")), "and both fold it like any other path");
  assert.doesNotMatch(body.innerHTML, /mc-path-code[^>]*data-path="1\.5"/, "a version number is not a file");
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
  const line = () => v.caretLine() - 1;
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


// The codebase prompt writes the SAME notes file the diff prompt does — its per-component notes are ordinary
// notes on the code, navigable with F8 and answerable like any other card. What differs is what the agent is
// asked to look at, and where the diagram goes: not into the note as text, but through the kakapo_map tool
// (mcp-server.ts), which validates the IR and renders map.html for the briefing panel's iframe. The node
// clicks come back as postMessage, never as script running in the review page.
test("the codebase prompt is a second editable prompt writing the same notes contract", async () => {
  const { MESSAGES } = await import("../dist/i18n.js");
  for (const locale of ["en", "ko"]) {
    const prompt = MESSAGES[locale]["codebase.prompt.default"];
    assert.ok(prompt, `${locale} has the prompt`);
    assert.ok(prompt.includes("{{NOTES_PATH}}"), "it writes to this workspace's notes file");
    assert.ok(prompt.includes("kakapo_map"), "its diagram is drawn through the kakapo_map tool");
    assert.ok(!prompt.includes("```mermaid") && !prompt.includes("Mermaid"), "and no longer as mermaid in the note");
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
test("a note can mark itself as key, and an invented role degrades to no mark", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const n = 1;\n", after: "export const n = 2;\n" },
  ]);
  const v = await loadViewer(html);

  const key = v.agentSays({ kind: "note", path: "src/app.ts", line: 1, role: "key", text: "Where the change turns." });
  // "problem" and "fix" were the two values this used to have. Notes written under them are still marked —
  // one mark now, because the distinction was weight the reader carried for nothing.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, role: "problem", text: "An older mark." });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 2, role: "fix", text: "The other older mark." });
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, role: "editorialising", text: "Not a role kakapo draws." });
  await v.settle(30);

  assert.equal(v.$all(".mc-card.mc-role-problem").length, 0, "there is no second kind of mark to draw");
  assert.equal(v.$all(".mc-card.mc-role-fix").length, 0);
  const marked = v.$all(".mc-card.mc-role-key").map((c) => c.textContent);
  assert.ok(marked.some((t) => /Where the change turns/.test(t)), "a key note is marked");
  assert.ok(marked.some((t) => /An older mark/.test(t)), "and so is one written under the old values");
  assert.ok(marked.some((t) => /The other older mark/.test(t)));
  assert.ok(!marked.some((t) => /Not a role kakapo draws/.test(t)), "an invented role is not");

  // A card renders once per diff pane, so compare the SET of pill labels rather than counting them.
  assert.deepEqual([...new Set(v.$all(".mc-role").map((p) => p.textContent))], ["Key"], "one label, not two");
  assert.ok(v.visibleCardTexts().some((t) => /Not a role kakapo draws/.test(t)), "the unmarked note still renders");

  // Every later write re-serialises the notes already in the thread (commentToRecord), so a role that is not
  // written back would silently disappear the next time anyone comments.
  v.agentSays({ kind: "note", path: "src/app.ts", line: 1, text: "A later, unmarked note." });
  await v.settle(30);
  assert.ok(v.$all(".mc-card.mc-role-key").some((c) => /Where the change turns/.test(c.textContent)),
    "the mark survives the round trip through the thread file");
  assert.ok(key > 0, "the note kept its id");
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

  const line = () => v.caretLine();
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

  const line = () => v.caretLine();
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

  const line = () => v.caretLine();
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

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(10);
  v.key("Enter");
  await v.settle(30);

  assert.equal(written.length, 1, "the prompt went to disk");
  assert.equal(written[0].name, "explain-diff.md", "under a name of its own, so it cannot overwrite a review request");
  assert.match(written[0].text, /"kind":"note"/, "and it is the whole prompt that was written");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\/repo\/\.git\/kakapo\/explain-diff\.md$/, "the composer carries the path");
  assert.doesNotMatch(sent[0], /"kind":"note"/, "not the sixty lines");
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

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(10);
  v.key("Enter");
  await v.settle(30);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"kind":"note"/, "the prompt itself is sent when the file could not be");
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

  const line = () => v.caretLine();
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

// The walk was filtered by the source index, which on a diff-first launch holds only the CHANGED files, so
// notes on untouched files disappeared from it — and stepping bounced between whichever two survived. A note
// belongs to the walk because it belongs to this workspace, which main decides (notesForWorkspace) before the
// renderer sees it; nothing here may filter again.
test("every note in this workspace is walkable, indexed or not", async () => {
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

  // No count on the card any more — "4/7" read as "the 4th of 7 comments", which is not what it was
  // counting. What the card still carries is the step: an order exists and it goes this way.
  assert.equal(v.$all(".mc-card.mc-ai .mc-walk").length, 0, "no card claims a total nothing else shares");
  assert.ok(v.$all(".mc-card.mc-ai .mc-walk-step").length > 0, "the step buttons stay");
  v.close();
});

// A note lives in the shared knowledge file and the conversation lives in this workspace's own — main merges
// them into one list on the way in, notes LAST. The renderer resolved each record's parent from the records
// it had already walked, so a reply written to a note never found one: it inherited no anchor, came out with
// no path, and matched no file. The answer was in the file and nowhere on screen.
test("a reply to a shared note lands on the note, whichever order the two files merge in", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ]);
  const v = await loadViewer(html);
  // The merge order main sends: the conversation first (the reply is in it), the shared notes after.
  v.window.applyThreadRecords([
    { id: 7, re: 3, by: "me", text: "왜 이렇게 했어?" },
    { id: 3, by: "agent", kind: "note", path: "src/app.ts", line: 1, text: "이 줄이 바뀐 이유" },
  ]);
  await v.settle(60);

  const reply = v.storedComments().find((c) => c.seq === 7);
  const note = v.storedComments().find((c) => c.seq === 3);
  assert.ok(reply, "the reply survived the load");
  assert.equal(reply.path, note.path, "and took the note's file, rather than none at all");
  assert.equal(reply.line, note.line, "…and its line");
  assert.equal(v.window.commentsAt(note.path, note.line).length, 2, "so the note and its reply are one thread");
  v.close();
});

// An explanation is about ONE change, but the notes file is shared and append-only, so a second run landed on
// top of the first: two explanations of two different diffs, both numbering their groups from 1, read by the
// walk as one story. A new run now retires the previous run's notes — except any the reviewer replied to,
// which stopped being an explanation the moment they became a conversation.
test("a new explanation retires the last one, and keeps the notes that became conversations", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\nconst b = 2;\nconst c = 3;\n", after: "const a = 9;\nconst b = 8;\nconst c = 7;\n" },
  ], { app: true });
  const v = await loadViewer(html);
  const notes = () => v.storedComments().filter((c) => c.by === "agent" && c.replyTo == null).map((c) => c.text);

  // Run one. The first run under this code prunes nothing — it only records where it began.
  v.window.runAnnotatePrompt();
  const asked = v.agentSays({ kind: "note", group: 1, path: "src/app.ts", line: 1, text: "old: discussed" });
  v.agentSays({ kind: "note", group: 1, path: "src/app.ts", line: 2, text: "old: plain" });
  await v.settle(40);
  assert.deepEqual(notes(), ["old: discussed", "old: plain"], "run one's notes are here");

  // The reviewer takes one of them up.
  v.agentSays({ re: asked, text: "an answer, so this one is a thread now" });
  await v.settle(40);

  // Run two.
  v.window.runAnnotatePrompt();
  v.agentSays({ kind: "note", group: 1, path: "src/app.ts", line: 3, text: "new: briefing" });
  await v.settle(60);

  assert.deepEqual(notes(), ["old: discussed", "new: briefing"],
    "the plain note from run one is gone; the one with a reply stayed, and run two's is here");
  assert.equal(v.storedComments().some((c) => c.replyTo === asked), true, "the answer is still attached to it");
  v.close();
});

// A thread is two files stitched together — this workspace's conversation and the repository's shared notes —
// and `reviewComments` holds them in file order, conversation first. So a note always sank below every
// question and answer sharing its line, however long before them it was written: the reader's own question sat
// at the top of a thread that had actually started with the note it was asked about.
test("a thread reads in the order it was written, not in the order the two files were stitched", async () => {
  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "const a = 1;\n", after: "const a = 9;\n" },
  ]);
  const v = await loadViewer(html);

  // The note comes FIRST in time. agentSays appends to the same one id space, so its seq is the lowest.
  const note = v.agentSays({ kind: "note", role: "key", path: "src/app.ts", line: 1, text: "the note, written first" });
  await v.settle(40);
  v.window.addComment("q", "src/app.ts", 1, "const a = 9;", "my question, second");
  await v.settle(40);
  const question = v.storedComments().find((c) => c.text === "my question, second").seq;
  v.agentSays({ re: question, text: "the answer, third" });
  await v.settle(60);

  assert.ok(note < question, "the note really was written before the question");
  const order = v.$all(".mc-thread-cell .mc-card:not(.mc-composer) .mc-card-body").map((b) => b.textContent.trim());
  assert.deepEqual(order.slice(0, 3), ["the note, written first", "my question, second", "the answer, third"],
    "the thread reads in the order the turns were taken");
  v.close();
});
