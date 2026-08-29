// The Explain briefing panel (25-briefing.js): the explanation's visible starting point. It is shown ONCE per
// explain run, splits the briefing note on its `##` headings, and its beak names the file to start in.
//
// jsdom has no layout — every getBoundingClientRect is zero — so the beak's arithmetic is not testable here.
// What IS testable is everything the arithmetic depends on: which row is chosen, which rows light up, and
// whether the panel comes back a second time. Those are where the behaviour actually lives.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

const BRIEFING = [
  "## Going to a comment opened the file but left the comment off-screen",
  "**Symptom** The file opens and you are looking at line 1.",
  "",
  "## The move waits for the file to arrive instead of guessing how long it takes",
  "**What changed** It waits for the notification now.",
  "",
  "## Read these two, then watch for the old shape coming back",
  "- `src/b.ts` — the wait is decided here.",
  "- **Test** “comment nav waits for a lazy file”.",
].join("\n");

const FILES = [
  { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  { path: "src/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
];

test("the briefing shows itself once, pages on its headings, and points at a file", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const w = v.window;

  assert.equal(v.$("#mc-briefing"), null, "nothing to brief on before the agent has written anything");
  assert.ok(v.$("#mc-briefing-recall").classList.contains("hidden"), "and no way back to a briefing that does not exist");

  // The run boundary is what makes these notes THIS workspace's — runAnnotatePrompt records it when the prompt
  // is sent, before the agent writes a line.
  w.markExplainRunStarting();
  const seq = v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "why", text: BRIEFING });
  await v.settle(30);
  assert.equal(v.$("#mc-briefing"), null, "notes arriving while a source file is open do not interrupt it");

  // The trigger is the diff coming into view: the panel points at a row in the Changes list, and that list is
  // what the reader is looking at when it means anything.
  w.showDiffView(false);
  await v.settle(30);

  const pop = v.$("#mc-briefing");
  assert.ok(pop, "a new explanation puts its briefing up by itself the first time the diff is open");
  assert.ok(!v.$("#mc-briefing-recall").classList.contains("hidden"), "and the way back appears in the sidebar");
  assert.equal(v.$all("#mc-briefing .mc-brf-dot").length, 3, "three `##` headings are three pages");
  assert.match(pop.querySelector(".mc-brf-h").textContent, /left the comment off-screen/, "the heading is the page's title");
  assert.match(pop.querySelector(".mc-brf-body").textContent, /looking at line 1/, "…and the text under it is the page");
  assert.doesNotMatch(pop.querySelector(".mc-brf-body").textContent, /waits for the notification/, "page two is not on page one");

  // Page 1 and 2 light nothing: a row lit there answers a question the reader has not asked yet.
  assert.equal(v.$(".change-row.mc-brf-aim"), null, "the problem page lights no file");
  pop.querySelector('[data-brf="1"]').click();
  assert.equal(v.$(".change-row.mc-brf-mark"), null, "nor does the as-is/to-be page");

  pop.querySelector('[data-brf="1"]').click();
  assert.match(pop.querySelector(".mc-brf-h").textContent, /Read these two/, "…and the third page is reached");
  assert.equal(v.$(".change-row.mc-brf-aim").dataset.file, "src/a.ts", "the beak's row is the briefing note's own file");
  assert.equal(v.$(".change-row.mc-brf-mark").dataset.file, "src/b.ts", "a file the page NAMES is lit separately, and softly");

  // The last page's "next" is the way out.
  pop.querySelector('[data-brf="1"]').click();
  assert.equal(v.$("#mc-briefing"), null, "the panel closes");
  assert.equal(v.$(".change-row.mc-brf-aim"), null, "and takes its highlights with it");

  // Seen on the moment it went up, not on the moment it was dismissed: it must never become a notice board.
  w.syncRail();
  assert.equal(v.$("#mc-briefing"), null, "the same explanation does not put itself up a second time");
  assert.equal(w.readExplainRuns().seen, seq, "…because the run it belongs to is marked seen");

  w.toggleBriefing();
  assert.ok(v.$("#mc-briefing"), "but asking for it brings it back");
  assert.match(v.$(".mc-brf-h").textContent, /left the comment off-screen/, "from the top");
  v.close();
});

test("a briefing anchored outside the diff falls back to the file most of the fix notes are on", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);

  // The prompt deliberately hangs the briefing where the problem HAPPENS, which is regularly a file this diff
  // never touched — and a file the diff never touched has no row in the Changes list to point at.
  v.window.markExplainRunStarting();
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/untouched.ts", line: 1, title: "why", text: BRIEFING });
  v.agentSays({ kind: "note", role: "fix", group: 2, path: "src/b.ts", line: 1, title: "here", text: "The wait." });
  await v.settle(30);

  assert.equal(v.window.briefingAnchorRow().dataset.file, "src/b.ts", "the fix notes say where to start instead");
  v.close();
});

test("a briefing with no headings is one page rather than nothing", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);

  v.window.markExplainRunStarting();
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "the old shape", text: "Four labelled lines, no headings." });
  v.window.showDiffView(false);
  await v.settle(30);

  assert.ok(v.$("#mc-briefing"), "a note written before this shape existed still opens");
  assert.equal(v.$all("#mc-briefing .mc-brf-dot").length, 1, "as a single page");
  assert.equal(v.$(".mc-brf-h").textContent, "the old shape", "titled by the note's own title");
  assert.ok(v.$(".mc-brf-of").classList.contains("hidden"), "with no 1/1 counter to read");
  v.close();
});

// Notes live in the repository's shared knowledge file and arrive in every worktree whose tree has the file
// they name, so "there is a note here" does not mean "this workspace explained something". Only a run started
// HERE has a briefing; another worktree's explanation must not open itself over this diff.
test("a note from another worktree's explanation is not this workspace's briefing", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);

  // No markExplainRunStarting: nothing was ever explained in this workspace. The note is shared knowledge.
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "theirs", text: BRIEFING });
  v.window.showDiffView(false);
  await v.settle(30);

  assert.equal(v.$("#mc-briefing"), null, "no briefing opens for an explanation this workspace did not run");
  assert.ok(v.$("#mc-briefing-recall").classList.contains("hidden"), "and nothing offers to replay one");
  assert.ok(v.$(".mc-card.mc-ai"), "the note itself still renders — it is knowledge about a file that is here");

  // Run Explain here and the briefing is the one THIS run wrote, not the one already on screen.
  v.window.markExplainRunStarting();
  const mine = v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "mine", text: "## Ours\nOur own." });
  await v.settle(30);

  assert.ok(v.$("#mc-briefing"), "this workspace's own run does open one");
  assert.equal(v.$(".mc-brf-h").textContent, "Ours", "…and it is this run's note, not the older shared one");
  assert.equal(v.window.readExplainRuns().seen, mine, "seen is recorded against this run");
  v.close();
});

// The subtler half of the same rule: a workspace that HAS explained something owns a run boundary, and every
// note another worktree appends to the shared file lands past it — so "seq past my boundary" called foreign
// notes mine, and an Explain run in a task worktree popped its briefing in the main checkout too. Only the
// workspace still WAITING on a run it sent (runs.await) may auto-open.
test("another worktree's later run does not reopen a briefing where one was already shown", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const w = v.window;

  w.markExplainRunStarting();
  v.agentSays({ kind: "note", role: "problem", group: 2, path: "src/a.ts", line: 1, title: "mine", text: "## Mine\nOur own run." });
  w.showDiffView(false);
  await v.settle(30);
  assert.ok(v.$("#mc-briefing"), "its own run briefs this workspace");
  w.closeBriefing();

  // Another worktree explains next: its briefing note arrives through the shared file with a higher seq and
  // an earlier group, so the walk would put it first — exactly the shape that reopened the panel here.
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/b.ts", line: 1, title: "theirs", text: "## Theirs\nNot ours." });
  await v.settle(60);
  w.syncRail();
  await v.settle(30);
  assert.equal(v.$("#mc-briefing"), null, "an explanation this workspace did not send stays a note, not a briefing");
  v.close();
});

// The launcher is how the Explain prompt is actually sent (⌘⇧P opens it on the Prompts section) — and it
// used to hand over the text without recording that a run had started. A briefing is only ever a note from
// the CURRENT run (briefingNote reads that boundary), so with no boundary there was no candidate and the
// briefing never appeared at all: "explain diff 시켜도 브리핑이 안 뜬다".
test("sending Explain from the launcher is what starts a run, and the briefing follows", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  // Nothing sent yet: a note arriving belongs to no run, and nothing is put in front of the reader.
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "stray", text: BRIEFING });
  v.window.showDiffView(false);
  await v.settle(40);
  assert.equal(v.$("#mc-briefing"), null, "a note from no run is not a briefing");

  // Send it the way a reviewer does.
  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(20);
  v.key("Enter");
  await v.settle(30);
  assert.equal(sent.length, 1, "the prompt went to the terminal");

  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "this run", text: BRIEFING });
  await v.settle(60);
  const pop = v.$("#mc-briefing");
  assert.ok(pop, "the run's briefing opens by itself");
  assert.match(pop.querySelector(".mc-brf-h").textContent, /left the comment off-screen/);
  v.close();
});

// A briefing must not open behind something. History (⌘9) is a full-view overlay over the review, and the
// diff underneath still counts as "visible" — so the panel went up under it and marked itself seen, spending
// the one showing it gets on a panel nobody could see. It waits for History to close instead.
test("the briefing waits rather than opening behind the History overlay", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  v.window.__kakapoTerminal = { enterSendMode: () => {} };
  v.window.showDiffView(false);
  await v.settle(30);

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(20);
  v.key("Enter");
  await v.settle(20);

  // Opening History for real needs the git bridge; what the briefing actually reads is the overlay being
  // up, so put it up.
  v.$("#history-view").classList.remove("hidden");
  assert.equal(v.window.isHistoryOpen(), true, "History is up");

  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "why", text: BRIEFING });
  await v.settle(60);
  assert.equal(v.$("#mc-briefing"), null, "nothing opens underneath it");

  v.window.closeHistory(); // its own close is what calls syncRail, and syncRail is what re-checks this
  await v.settle(60);
  assert.ok(v.$("#mc-briefing"), "and it is still there to be shown once History is gone");
  v.close();
});

// What the review is comparing is not what `git diff` prints. Shift-picking commits in History, or moving the
// patch-set selector, leaves the working tree clean — an agent told only "walk the current diff" then runs
// git diff, sees nothing, and explains nothing. The prompt has to name the range the reader is looking at.
test("the explain prompt names the range this review is showing", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const w = v.window;

  assert.doesNotMatch(w.currentAnnotatePromptText(), /\{\{DIFF_RANGE\}\}/, "the placeholder is substituted");
  assert.match(w.currentAnnotatePromptText(), /git diff/, "and it names a git command either way");

  // A commit range picked in History: base and target are commits, and the working tree is not involved.
  w.patchSetData = { activeBase: "aaaa111", activeTarget: "bbbb222", commits: [], branchPoint: "aaaa111" };
  assert.match(w.currentAnnotatePromptText(), /git diff aaaa111\.\.bbbb222/, "the picked commits are what it explains");

  // Back to the working tree as the right side: the range is the branch point up to HEAD.
  w.patchSetData = { activeBase: "auto", activeTarget: "worktree", commits: [], branchPoint: "cccc333" };
  assert.match(w.currentAnnotatePromptText(), /git diff cccc333\.\.HEAD/);
  v.close();
});

// A review with nothing in it is worth refusing at the keystroke rather than ten seconds later, in a terminal,
// as an agent reporting it found nothing.
test("Explain refuses up front when the review has no changed files", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const sent = [];
  v.window.__kakapoTerminal = { enterSendMode: (text) => sent.push(text) };

  v.$all("#changes-panel .change-row[data-file]").forEach((row) => row.remove());
  assert.equal(v.window.reviewHasChanges(), false, "the review is empty now");

  v.key("P", { metaKey: true, shiftKey: true, code: "KeyP" });
  await v.settle(20);
  v.key("Enter");
  await v.settle(30);
  assert.equal(sent.length, 0, "nothing was sent");
  assert.match(v.$("#mc-toast, .mc-toast")?.textContent || "", /설명할 변경이 없|Nothing to explain/, "and it says why");
  v.close();
});

// The way back into the briefing lives INSIDE #changes-panel, and a watch tick replaces that panel wholesale
// from the payload — where the button is, correctly, hidden. Nothing put it back, so on a review being
// watched (an agent writing files rebuilds every tick) the button appeared and then vanished seconds later.
test("the replay button survives a watch rebuild of the Changes panel", async () => {
  const { html, build } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { menuBridge: true });
  v.window.markExplainRunStarting();
  v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "start here", text: BRIEFING });
  v.window.showDiffView(false);
  await v.settle(40);
  v.window.closeBriefing();
  assert.equal(v.$("#mc-briefing-recall").classList.contains("hidden"), false, "the button is there to begin with");

  await v.pushDiffUpdate(build.update);
  await v.settle(60);
  assert.equal(v.$("#mc-briefing-recall").classList.contains("hidden"), false,
    "and it is still there after the panel it lives in was rebuilt");
  v.close();
});

// The briefing is the panel, not a card. It is the same record as one of the run's notes, so it used to be
// BOTH — read once in the panel, then met again pinned to a line, saying the same thing twice. It keeps its
// place in the walk that defines it (annotationWalk) and loses the card, the slot the card sat in, and the
// F8 stop; ⌘⇧B is the way back to it.
test("the briefing note is not also an inline comment card", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  v.window.markExplainRunStarting();
  const briefing = v.agentSays({ kind: "note", role: "problem", group: 1, path: "src/a.ts", line: 1, title: "start here", text: BRIEFING });
  const ordinary = v.agentSays({ kind: "note", group: 2, path: "src/b.ts", line: 1, title: "a normal note", text: "This one stays a card." });
  v.window.showDiffView(false);
  await v.settle(60);

  assert.ok(v.$("#mc-briefing"), "the briefing is up as a panel");
  v.window.closeBriefing();
  await v.settle(30);

  const cards = v.$all("#diff2html-container .mc-card.mc-ai .mc-card-body").map((b) => b.textContent);
  assert.equal(cards.some((text) => text.includes("This one stays a card")), true, "the run's other notes still render inline");
  assert.equal(cards.some((text) => text.includes("Symptom")), false, "the briefing's own note does not");

  // F8 walks to the note that HAS a card, never to the briefing's empty line.
  v.key("F8");
  await v.settle(60);
  const walked = v.window.sortedNavThread().filter((c) => !v.window.isBriefingCard(c)).map((c) => c.seq);
  assert.equal(walked.includes(briefing), false, "the walk steps past the briefing");
  assert.equal(walked.includes(ordinary), true, "and still stops at the ordinary note");

  v.key("B", { metaKey: true, shiftKey: true, code: "KeyB" });
  await v.settle(40);
  assert.ok(v.$("#mc-briefing"), "⌘⇧B is still the way back to it");
  v.close();
});

// The codebase map's rendered diagram (kakapo_map, mcp-server.ts) arrives as map.html next to the shared
// knowledge file, and the panel embeds it in a sandboxed iframe. The iframe has exactly two words, both
// postMessage: "I loaded" opens the collapsed frame, and "a node was clicked" becomes navigateToLine.
test("the map panel embeds map.html and routes a node click to the code", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html);
  const w = v.window;

  w.annotationsPath = "/repo/.git/kakapo/knowledge.jsonl";
  assert.equal(w.codebaseMapUrl(), "file:///repo/.git/kakapo/map.html", "map.html is the knowledge file's sibling");

  v.agentSays({ kind: "note", path: "src/a.ts", line: 1, title: "the map", text: "One paragraph per component." });
  await v.settle(30);
  w.openCodebaseMap();

  const frame = v.$("#mc-briefing-map");
  assert.ok(frame, "the map panel carries the iframe");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "…sandboxed: the map runs scripts and nothing else");
  assert.ok(!v.$("#mc-briefing").classList.contains("mc-brf-has-map"), "and stays collapsed until the file itself speaks");

  // A message from anywhere else is not the map speaking.
  w.dispatchEvent(new w.MessageEvent("message", { data: { kakapoMapReady: true }, source: w }));
  assert.ok(!v.$("#mc-briefing").classList.contains("mc-brf-has-map"), "a stranger's ready ping opens nothing");

  w.dispatchEvent(new w.MessageEvent("message", { data: { kakapoMapReady: true }, source: frame.contentWindow }));
  assert.ok(frame.classList.contains("mc-brf-map-live"), "the map's own ready ping shows the diagram");
  assert.ok(v.$("#mc-briefing").classList.contains("mc-brf-has-map"), "…and widens the panel around it");

  const opened = [];
  w.openPathReference = (ref) => opened.push(ref);
  w.dispatchEvent(new w.MessageEvent("message", { data: { kakapoNav: { path: "src/app-main.ts", line: 42 } }, source: frame.contentWindow }));
  assert.deepEqual(opened, ["src/app-main.ts:42"], "a node click opens that file at that line");
  assert.equal(v.$("#mc-briefing"), null, "and the panel gets out of the way first");

  // A workspace still on the legacy per-worktree comments file has no shared directory to look in.
  w.annotationsPath = "/repo/.git/kakapo/comments.jsonl";
  assert.equal(w.codebaseMapUrl(), null, "no shared knowledge file, no map");
  v.close();
});
