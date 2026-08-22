// The knowledge map (26-terms.js). Its two rules are the whole feature, and both are testable without layout:
//   - an edge exists because one word's meaning MENTIONS another. Nobody draws links by hand, so the graph
//     and the links offered inside a word's card can never disagree.
//   - a word is read when its own card is opened, not when the map is opened.
//
// jsdom has no layout, so every clientWidth is 0 and the placement arithmetic cannot be checked here (the
// build falls back to a 640×420 world for exactly that reason). What the layout DOES have to guarantee is
// checked instead: no two words land on top of each other.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const opened = [];
after(() => { while (opened.length) { try { opened.pop().close(); } catch {} } });
after(cleanupFixtures);

const FILES = [{ path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" }];

// A small vocabulary with everything the graph has to get right in it: a word that carries two others, a
// detail scoped under its concept, and the same detail word scoped under a different concept.
const TERMS = [
  { w: "지식 베이스", gloss: "리뷰에서 쓴 말이 쌓이는 곳. 워크트리끼리 공유한다.",
    code: [{ name: "termsFilePath", at: "src/terms-file.ts:38" }] },
  { w: "브리핑", gloss: "이 변경이 왜 필요했는지 알려주는 첫 설명. 지식 베이스의 말로 쓴다." },
  { w: "말풍선", gloss: "브리핑을 담아서 띄우는 창." },
  { w: "앵커", parent: "말풍선", gloss: "뾰족한 끝이 붙는 자리." },
  { w: "앵커", parent: "코멘트", gloss: "코멘트가 매달린 줄." },
  { w: "코멘트", gloss: "줄에 남기는 말. 여기서 물어본 것이 지식 베이스로 올라간다.", seen: true },
];

// Nodes are picked with pointerdown/pointerup, not .click() — that IS the fix being locked in here. The map
// used to act on `click`, and because the stage took the pointer capture on pointerdown, the browser
// dispatched that click at the stage instead of the word, so clicking a word did nothing. jsdom stubs
// setPointerCapture into a no-op, so only driving the same events the browser does can catch it.
function pick(v, key) {
  const el = v.$(`#mc-map .mc-node[data-node="${key}"]`);
  if (!el) throw new Error(`no node for ${key}`);
  const stage = v.$("#mc-map-stage");
  const at = { bubbles: true, clientX: 100, clientY: 100, button: 0 };
  el.dispatchEvent(new v.window.MouseEvent("pointerdown", at));
  stage.dispatchEvent(new v.window.MouseEvent("pointerup", at));
}

async function openMap(terms = TERMS) {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: terms });
  opened.push(v);
  await v.settle(20);
  v.window.toggleTermMap();
  await v.settle(20);
  return v;
}

test("an edge is a mention: the map draws what the meanings already say", async () => {
  const v = await openMap();
  const w = v.window;
  assert.ok(v.$("#mc-map"), "⌘⇧K puts the map up");
  // One node per word, plus the repository itself in the middle. It is not a word — nothing was said to put
  // it there and it has no meaning to open — but with two words and no middle a map is two dots in a void.
  assert.equal(v.$all("#mc-map .mc-node:not(.is-root)").length, TERMS.length, "one node per word");
  assert.equal(v.$all("#mc-map .mc-node.is-root").length, 1, "and the project sits at the centre");

  const edge = (a, b) => w.termMap.links.some((l) =>
    (l.a.key === a && l.b.key === b) || (l.a.key === b && l.b.key === a));
  assert.ok(edge("브리핑", "지식 베이스"), "브리핑's meaning names 지식 베이스, so they are joined");
  assert.ok(edge("말풍선", "브리핑"), "and 말풍선's names 브리핑");
  assert.ok(edge("말풍선", "말풍선·앵커"), "a detail hangs off the concept it details");

  // The same word under two concepts is two words. Joining them would put an edge between 말풍선 and 코멘트
  // that nothing in the review ever claimed.
  assert.ok(!edge("말풍선·앵커", "코멘트·앵커"), "two 앵커s are not one 앵커");
  assert.ok(!edge("말풍선", "코멘트"), "so their concepts stay unconnected");

  // Abstraction is in-degree — how many other words are explained USING this one — and that is what puts a
  // word in the middle rather than on the rim.
  assert.ok(w.termMap.g.inDeg["지식 베이스"] >= 1, "a word others are explained with counts as carried");
  const [big] = w.termMap.nodes.filter((n) => !n.isRoot).sort((a, b) => b.r - a.r);
  assert.equal(big.key, "지식 베이스", "and it is drawn largest of the words");
});

test("no two words are drawn on top of each other", async () => {
  const v = await openMap();
  const nodes = v.window.termMap.nodes;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].bx - nodes[j].bx, dy = nodes[i].by - nodes[j].by;
      assert.ok(Math.hypot(dx, dy) > nodes[i].r + nodes[j].r,
        `${nodes[i].key} and ${nodes[j].key} overlap`);
    }
  }
});

test("opening a word is what marks it read — opening the map is not", async () => {
  const v = await openMap();
  const w = v.window;
  const dot = () => v.$all("#mc-map .mc-node .mc-node-new").length;
  assert.equal(dot(), 5, "every word but the one already read carries an unread pip");
  assert.equal(w.__termsWrites.length, 0, "and simply looking at the map writes nothing back");

  pick(v, "브리핑");
  await v.settle(10);
  assert.ok(v.$("#mc-term-card"), "the word's meaning opens");
  assert.match(v.$("#mc-term-card .mc-term-w").textContent, /브리핑/);
  assert.equal(dot(), 4, "and that word is read now");

  const written = w.__termsWrites.at(-1);
  assert.equal(written.find((t) => t.w === "브리핑").seen, true, "the vocabulary file is told");
  assert.equal(written.find((t) => t.w === "말풍선").seen, undefined, "and only about the word that was opened");
});

test("the card offers the same links the graph drew, and a scoped word stays in its own scope", async () => {
  const v = await openMap();
  const w = v.window;
  pick(v, "브리핑");
  await v.settle(10);

  const links = v.$all("#mc-term-card .mc-term-link").map((b) => b.dataset.w);
  assert.deepEqual(links, ["지식 베이스"], "the one vocabulary word in the meaning is the one way in");
  v.$('#mc-term-card .mc-term-link').click();
  await v.settle(10);
  assert.match(v.$("#mc-term-card .mc-term-w").textContent, /지식 베이스/, "following it opens that word");
  assert.equal(w.termMap.pinned.key, "지식 베이스", "and the card belongs to that node now");
  assert.match(v.$("#mc-term-card .mc-term-code code").textContent, /termsFilePath/, "what the word is in code");
  assert.match(v.$("#mc-term-card .mc-term-at").textContent, /src\/terms-file\.ts:38/);

  // 말풍선's own 앵커, not 코멘트's: a scoped word resolves inside its own concept first.
  w.openTermCard(w.termMap.nodes.find((n) => n.key === "말풍선"));
  await v.settle(10);
  assert.equal(w.termMap.pinned.key, "말풍선");
});

test("an empty vocabulary says how a word gets in rather than offering to add one", async () => {
  const v = await openMap([]);
  assert.ok(v.$("#mc-map"), "the map still opens");
  assert.equal(v.$all("#mc-map .mc-node").length, 0);
  assert.ok(!v.$("#mc-map-empty").classList.contains("hidden"), "the empty state is shown");
  assert.match(v.$("#mc-map-empty").textContent, /직접 써야|used it yourself/, "and it says the reader owns the words");
});

test("Escape closes the open word first, then the map", async () => {
  const v = await openMap();
  const w = v.window;
  pick(v, "코멘트");
  await v.settle(10);
  assert.ok(v.$("#mc-term-card"));

  v.key("Escape");
  assert.equal(v.$("#mc-term-card"), null, "the word closes");
  assert.ok(v.$("#mc-map"), "the map stays up");
  v.key("Escape");
  assert.equal(v.$("#mc-map"), null, "the second press closes the map");
  assert.equal(w.termMap.raf, 0, "and the frame loop is stopped, not left running behind a removed dialog");
});

// ── the harvest ──────────────────────────────────────────────────────────────────────────────────
// Deleting a thread is where a reader says "I am done with this", and everything they worked out in it goes
// with it. The offer to keep the concepts is made there — and only when the READER used the word.
test("a word the reader used, explained in the answer, is offered when the thread is deleted", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: [] });
  opened.push(v);
  await v.settle(20);
  const w = v.window;

  // The reader asks in their own words; the agent answers.
  w.reviewComments.push({ seq: 1, kind: "c", by: "me", replyTo: null, path: "src/a.ts", line: 1,
    text: "여기 지연 로딩은 언제 끝나는지 어떻게 알아?" });
  w.reviewComments.push({ seq: 2, kind: "c", by: "agent", replyTo: 1, path: "src/a.ts", line: 1,
    text: "지연 로딩은 파일이 도착했다는 알림을 기다렸다가 끝납니다. `loadSourceFile`이 그 약속을 돌려줍니다." });
  w.saveComments();

  w.removeComments([1, 2]);
  await v.settle(10);

  const box = v.$("#mc-harvest");
  assert.ok(box, "the offer is made");
  const words = v.$all("#mc-harvest .mc-harvest-w").map((el) => el.textContent);
  assert.ok(words.includes("지연 로딩") || words.includes("로딩"), `the reader's own word is offered (got ${words})`);
  assert.ok(!words.some((word) => /loadSourceFile/.test(word)), "an identifier is not a word — it is what a word IS in the code");

  const gloss = v.$("#mc-harvest .mc-harvest-g").textContent;
  assert.match(gloss, /알림을 기다/, "the meaning is the sentence from the answer that explains it");
  assert.ok(gloss.length < 160, "one line, not the whole answer");

  v.$('#mc-harvest [data-harvest="save"]').click();
  await v.settle(10);
  assert.equal(v.$("#mc-harvest"), null, "the offer closes");
  const written = w.__termsWrites.at(-1);
  assert.ok(written.length >= 1, "the vocabulary file is written");
  assert.equal(written[0].seen, undefined, "a word that has just arrived has not been read");
  assert.ok(written[0].code.some((c) => c.name === "loadSourceFile"), "and the identifier is kept as what it is in code");
});

test("an agent talking to itself teaches nobody anything, so nothing is offered", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: [] });
  opened.push(v);
  await v.settle(20);
  const w = v.window;

  // A retired explain note: agent words only, and no reader ever used them.
  w.reviewComments.push({ seq: 1, kind: "note", by: "agent", replyTo: null, path: "src/a.ts", line: 1,
    text: "지연 로딩은 파일이 도착했다는 알림을 기다립니다." });
  w.saveComments();
  w.removeComments([1]);
  await v.settle(10);
  assert.equal(v.$("#mc-harvest"), null, "an answer nobody read is not knowledge");
  assert.equal(w.__termsWrites.length, 0);
});

test("a question with no answer in it leaves nothing to keep", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: [] });
  opened.push(v);
  await v.settle(20);
  const w = v.window;
  w.reviewComments.push({ seq: 1, kind: "c", by: "me", replyTo: null, path: "src/a.ts", line: 1, text: "이거 왜 이래?" });
  w.reviewComments.push({ seq: 2, kind: "c", by: "agent", replyTo: 1, path: "src/a.ts", line: 1, text: "고쳤습니다." });
  w.saveComments();
  w.removeComments([1, 2]);
  await v.settle(10);
  assert.equal(v.$("#mc-harvest"), null, "no concept, no dialog — the thread just goes");
});

// ── the address is a cache ───────────────────────────────────────────────────────────────────────
// A word stores the NAME it is in the code plus where that name last was. Line numbers rot on the next
// commit, so the address is never trusted on sight — it is re-checked, and a name found somewhere else just
// moves. A name found nowhere is the one thing worth reporting.
const MOVED = [{ w: "지연 로딩", gloss: "파일이 도착했다는 알림을 기다리는 것.",
  code: [{ name: "loadSourceFile", at: "src/viewer/07-comments.js:100" }] }];

test("opening a word moves its address to wherever the name is now", async () => {
  const { html } = await makeReviewHtml(FILES);
  const queries = [];
  const v = await loadViewer(html, {
    termsBridge: MOVED,
    searchBridge(request) {
      queries.push(request.query);
      return { available: true, matches: [{ path: "src/viewer/10-source-view.js", line: 412 }] };
    },
  });
  opened.push(v);
  await v.settle(20);
  v.window.toggleTermMap();
  await v.settle(20);

  pick(v, "지연 로딩");
  await v.settle(30);
  assert.deepEqual(queries, ["loadSourceFile"], "the NAME is what is looked for — never the old address");
  assert.match(v.$("#mc-term-card .mc-term-at").textContent, /10-source-view\.js:412/, "the card shows where it is now");
  const written = v.window.__termsWrites.at(-1);
  assert.equal(written[0].code[0].at, "src/viewer/10-source-view.js:412", "and the cache is corrected on disk");
});

// The floating terminal covers exactly where the file opens. Landing behind it is a navigation that looks
// like it did nothing — the same reason ⌘0/⌘1 put it away.
test("following a code link puts the terminal away first", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, {
    termsBridge: MOVED,
    searchBridge: () => ({ available: true, matches: [{ path: "src/a.ts", line: 1 }] }),
  });
  opened.push(v);
  await v.settle(20);
  const w = v.window;
  let closed = false;
  w.__kakapoTerminal = { isOpen: () => true, close: () => { closed = true; } };
  w.toggleTermMap();
  await v.settle(20);

  pick(v, "지연 로딩");
  await v.settle(30);
  v.$("#mc-term-card .mc-term-code").click();
  await v.settle(20);
  assert.equal(closed, true, "the terminal is put away before the file is shown");
  assert.equal(v.$("#mc-map"), null, "and the map closes with it");
});

test("a name that is gone from the repository is reported, and the name itself is kept", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, {
    termsBridge: MOVED,
    searchBridge: () => ({ available: true, matches: [] }),
  });
  opened.push(v);
  await v.settle(20);
  v.window.toggleTermMap();
  await v.settle(20);

  pick(v, "지연 로딩");
  await v.settle(30);
  assert.ok(v.$("#mc-term-card .mc-term-at").classList.contains("is-gone"), "the reader is told the address is dead");
  assert.match(v.$("#mc-term-card .mc-term-code code").textContent, /loadSourceFile/, "the name survives — it was the truth all along");
  const written = v.window.__termsWrites.at(-1);
  assert.equal("at" in written[0].code[0], false);
});

// jsdom reports every size as 0, so the placement arithmetic only becomes testable once the three numbers it
// reads are stubbed. It is worth stubbing: a card that runs off the bottom of the window, or that sits on top
// of the very node it belongs to, is the one failure a reader cannot work around.
test("a word near the bottom opens its card above itself instead of off-screen", async () => {
  const v = await openMap();
  const w = v.window;
  const stage = v.$("#mc-map-stage");
  Object.defineProperty(stage, "clientWidth", { value: 900, configurable: true });
  Object.defineProperty(stage, "clientHeight", { value: 600, configurable: true });

  const node = w.termMap.nodes[0];
  w.openTermCard(node);
  await v.settle(10);
  const card = v.$("#mc-term-card");
  Object.defineProperty(card, "offsetWidth", { value: 300, configurable: true });
  Object.defineProperty(card, "offsetHeight", { value: 220, configurable: true });
  Object.defineProperty(card, "scrollHeight", { value: 220, configurable: true });

  // Put the node right at the bottom edge, in screen space.
  w.termMap.k = 1;
  w.termMap.tx = 0;
  w.termMap.ty = 0;
  node.x = 450;
  node.y = 580;
  w.placeTermCard();
  const top = parseFloat(card.style.top);
  assert.ok(top + 220 <= 600, `the card stays inside the window (top ${top})`);
  assert.ok(top + 220 < 580, "and above the node rather than over it");

  // And with room below, it hangs under its node the normal way.
  node.y = 120;
  w.placeTermCard();
  assert.ok(parseFloat(card.style.top) > 120, "under the node when there is room");
});

// ── the loop closes ──────────────────────────────────────────────────────────────────────────────
// The vocabulary is only worth keeping if the next explanation is written IN it. Both Explain prompts hand
// the agent the file's path and the three rules that make it mean something: no new names, hang the new thing
// off a word they already have, and keep the "why" chain unbroken.
test("both Explain prompts hand the agent the vocabulary and the rules for using it", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: TERMS });
  opened.push(v);
  await v.settle(30);
  const w = v.window;

  for (const [label, text] of [["explain-diff", w.currentAnnotatePromptText()], ["explain-codebase", w.currentCodebasePromptText()]]) {
    assert.ok(text.includes(".git/kakapo/terms.jsonl"), `${label} names the vocabulary file`);
    assert.ok(!text.includes("{{TERMS_PATH}}"), `${label} substituted the placeholder`);
    assert.match(text, /읽기만|never write to it/, `${label} keeps the agent out of the reader's words`);
    assert.match(text, /새 이름|new name/, `${label} forbids coining a term`);
    assert.match(text, /아는 것에 붙이|already know/, `${label} asks it to attach to what the reader has`);
    assert.match(text, /"왜"의 사슬|"why" chain/, `${label} asks for an unbroken why`);
    assert.match(text, /비어 있으면|missing or empty/, `${label} says what an empty vocabulary means`);
  }
});

// The path has to be the SHARED one — a workspace dies with its task, and knowledge that died with it would
// have to be learned again every time.
test("the prompt names the vocabulary even before the bridge has answered", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html); // no terms bridge at all: a browser review
  opened.push(v);
  await v.settle(20);
  assert.ok(v.window.currentAnnotatePromptText().includes(".git/kakapo/terms.jsonl"),
    "it falls back to the conventional location rather than naming nothing");
});

// ── the quieter way in: the agent judges it ──────────────────────────────────────────────────────
// Most threads are never deleted. The commoner moment — the reader answers an answer and moves on — is
// judged by the agent, in the document that carries the conversation back to it. It was a regex here first
// ("does this reply end in a question?"), and that regex was built out of Korean question words: an English
// review could never have filled the vocabulary at all.
test("handing a thread back to the agent asks it to keep what the reader took in", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: TERMS });
  opened.push(v);
  await v.settle(30);
  const w = v.window;
  w.reviewComments.push({ seq: 1, kind: "c", by: "me", replyTo: null, path: "src/a.ts", line: 1, text: "지연 로딩이 뭐야?" });
  w.saveComments();

  const written = [];
  w.__kakapoTerminal = { enterSendMode: () => {} };
  w.kakapoComments = Object.assign({}, w.kakapoComments, {
    writeRequest: (text) => { written.push(text); return Promise.resolve({ ok: true, path: "/repo/.git/kakapo/review.md" }); },
  });
  await v.openMergedView();
  const send = v.$("#mc-merged-panel .mc-send-terminal");
  assert.ok(send, "the merged dock has its send control");
  send.disabled = false;
  send.click();
  await v.settle(40);

  assert.equal(written.length, 1, "the hand-off went to disk");
  const doc = written[0];
  assert.ok(doc.includes(".git/kakapo/terms.jsonl"), "and it names the vocabulary file");
  assert.match(doc, /리뷰어가 쓴|words the REVIEWER wrote/, "only the reader's own words may go in");
  assert.match(doc, /배운 것이 없는|taught nothing/, "and most threads add nothing");
});

// ── what the agent found, offered rather than asserted ───────────────────────────────────────────
// A concept the agent found in the code is not knowledge the reader has. It is drawn — around the outside,
// hollow, joined to nothing — because seeing what is out there is useful; but an edge to it would claim the
// reader had connected two ideas they have not so much as used yet.
test("an agent's proposals ring the outside and join nothing", async () => {
  const v = await openMap(TERMS.concat([
    { w: "패치셋", gloss: "리뷰의 기준이 되는 커밋 쌍.", proposed: true, code: [{ name: "patchSets", at: "src/git.ts:20" }] },
    { w: "인덱스", gloss: "파일 목록을 미리 만들어 두는 것.", proposed: true },
  ]));
  const w = v.window;

  assert.equal(v.$all("#mc-map .mc-node:not(.is-root)").length, TERMS.length + 2, "they are on the map");
  const offered = w.termMap.nodes.filter((n) => n.offered);
  assert.equal(offered.length, 2);
  assert.equal(w.termMap.links.some((l) => l.a.offered || l.b.offered), false, "and nothing is joined to them");
  assert.ok(w.termMap.links.some((l) => l.a.isRoot || l.b.isRoot), "the project, by contrast, is joined to the leading concepts");

  // Outside everything the reader owns.
  const cx = w.termMap.W / 2, cy = (w.termMap.H - 30) / 2;
  const reach = (n) => Math.hypot(n.x - cx, n.y - cy);
  const mine = w.termMap.nodes.filter((n) => !n.offered && !n.isRoot);
  assert.ok(Math.min(...offered.map(reach)) > Math.max(...mine.map(reach)), "the ring sits beyond the reader's words");

  assert.equal(v.$all("#mc-map .mc-node.is-offered .mc-node-new").length, 0,
    "no unread pip: a proposal is not a word of theirs that arrived");
  assert.ok(v.$('#mc-map .mc-node.is-offered'), "and they are marked as what they are");

  pick(v, "패치셋");
  await v.settle(10);
  assert.match(v.$("#mc-term-card .mc-term-offered").textContent, /에이전트가 찾은|found by the agent/,
    "the card says whose word it is");
});

// A conversation in the terminal teaches as much as a comment thread does, and nothing in kakapo can read it
// — but the agent holding it can. So the vocabulary is reachable from there too: one prompt, the same file,
// the same one rule.
test("a terminal conversation can feed the vocabulary too", async () => {
  const { html } = await makeReviewHtml(FILES);
  const v = await loadViewer(html, { termsBridge: TERMS });
  opened.push(v);
  await v.settle(30);
  const w = v.window;

  const entry = w.promptPaletteEntries().find((p) => p.id === "terms");
  assert.ok(entry, "the ⌘E launcher offers it");
  const text = entry.text();
  assert.ok(text.includes(".git/kakapo/terms.jsonl"), "it names the vocabulary file");
  assert.match(text, /제가 쓴 말만|Only words I wrote/, "only the reader's own words");
  assert.match(text, /되묻고 있는|still asking about/, "and not the ones they are still asking about");
  assert.match(text, /남길 것이 없으면|nothing to keep, do nothing/, "most conversations keep nothing");
});
