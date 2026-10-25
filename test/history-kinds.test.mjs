// The history overlay as a reader of three read-only Git histories: the commit log (filtered by git), the
// reflog, and the stash list — plus going to a commit by hash and copying the one that is selected.
//
// What these guard is the boundary rather than the chrome: which bridge call each kind makes, what the
// filter row actually sends, and that a reload while someone is typing does not take the keyboard away
// from the box they are typing in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const __realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
after(() => Object.defineProperty(process, "platform", { value: __realPlatform, configurable: true }));

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

const COMMITS = [
  { hash: "a".repeat(40), parents: ["b".repeat(40)], author: "Ada", email: "ada@test", date: "2026-06-01T10:00:00+09:00", refs: "HEAD -> main", subject: "newer commit" },
  { hash: "b".repeat(40), parents: [], author: "Grace", email: "grace@test", date: "2026-05-31T10:00:00+09:00", refs: "", subject: "older commit" },
];

/** Opens History with every read-only bridge recorded, so a test can say which call a gesture made. */
async function openHistory(options = {}) {
  const v = await loadViewer(html);
  const asked = { log: [], reflog: [], stashes: 0, resolve: [], compare: [] };
  const clipboard = [];
  v.window.kakapoGit = {
    log: (request) => { asked.log.push(JSON.parse(JSON.stringify(request || {}))); return Promise.resolve(options.commits ?? COMMITS); },
    lineLog: (request) => { asked.log.push(JSON.parse(JSON.stringify(request || {}))); return Promise.resolve(COMMITS.slice(1)); },
    reflog: (request) => {
      asked.reflog.push(JSON.parse(JSON.stringify(request || {})));
      return Promise.resolve([
        { ...COMMITS[0], selector: "HEAD@{0}", action: "commit: newer commit" },
        { ...COMMITS[1], selector: "HEAD@{1}", action: "checkout: moving from side to main" },
      ]);
    },
    stashes: () => {
      asked.stashes += 1;
      return Promise.resolve([
        {
          selector: "stash@{0}", hash: "c".repeat(40), parents: ["a".repeat(40), "e".repeat(40)],
          author: "Ada", date: "2026-06-02T10:00:00+09:00", subject: "On main: work in progress",
        },
      ]);
    },
    resolveRevision: (query) => {
      asked.resolve.push(query);
      return Promise.resolve(options.revision === undefined ? null : options.revision);
    },
    setReviewCompare: (base, target) => { asked.compare.push([base, target]); return Promise.resolve({ ok: true }); },
  };
  v.window.kakapoClipboard = { write: (text) => clipboard.push(text) };
  v.window.__kakapoHistory.open();
  await v.settle(40);
  return { v, asked, clipboard };
}

/** Types into one of the filter inputs the way a person does — one input event, then the debounce. */
async function type(host, id, value) {
  const field = host.v.$(`#${id}`);
  field.value = value;
  field.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
  await host.v.settle(320); // past the 220ms debounce
}

test("the log is the opening kind, and its rows carry the graph", async () => {
  const host = await openHistory();
  assert.equal(host.asked.log.length, 1);
  assert.equal(host.asked.reflog.length, 0);
  assert.equal(host.v.$all("#history-list .hrow").length, 2);
  assert.ok(host.v.$("#history-list .hgraph-cell svg"), "a commit row draws its lane");
  assert.equal(host.v.$(".history-kind[data-history-kind='commits']").classList.contains("active"), true);
  host.v.close();
});

test("switching kind asks the matching bridge, once", async () => {
  const host = await openHistory();
  host.v.$(".history-kind[data-history-kind='reflog']").click();
  await host.v.settle(40);
  assert.equal(host.asked.reflog.length, 1);
  assert.equal(host.v.$all("#history-list .hrow").length, 2);
  assert.equal(host.v.$("#history-list .hselector").textContent, "HEAD@{0}",
    "a reflog entry is named by its selector — without it the rows are indistinguishable");
  assert.match(host.v.$("#history-list .hsubject").textContent, /^commit: /,
    "and by what git recorded it as doing");

  host.v.$(".history-kind[data-history-kind='stashes']").click();
  await host.v.settle(40);
  assert.equal(host.asked.stashes, 1);
  assert.equal(host.v.$("#history-list .hselector").textContent, "stash@{0}");

  host.v.$(".history-kind[data-history-kind='commits']").click();
  await host.v.settle(40);
  assert.equal(host.asked.log.length, 2, "going back re-reads the log and nothing else");
  host.v.close();
});

test("a stash opens in the review as its own first parent, which is where HEAD was", async () => {
  const host = await openHistory();
  host.v.$(".history-kind[data-history-kind='stashes']").click();
  await host.v.settle(40);
  host.v.$("#history-list .hrow").click();
  await host.v.settle(20);
  host.v.$("#history-list .hrow").dispatchEvent(new host.v.window.MouseEvent("dblclick", { bubbles: true }));
  await host.v.settle(40);
  assert.deepEqual(host.asked.compare[0], ["a".repeat(40), "c".repeat(40)],
    "its FIRST parent — the second is the index commit, which is not what was stashed");
  host.v.close();
});

test("the filter row sends its fields to git rather than hiding rows", async () => {
  const host = await openHistory();
  host.v.$("#history-filter-toggle").click();
  assert.equal(host.v.$("#history-filters").classList.contains("hidden"), false);

  await type(host, "history-filter-author", "Grace");
  const request = host.asked.log[host.asked.log.length - 1];
  assert.equal(request.author, "Grace");
  assert.equal(request.limit, 300, "a filter is a new page, not a narrowing of the old one");

  await type(host, "history-filter-path", "src/a.ts");
  await type(host, "history-filter-content", "needle");
  await type(host, "history-filter-since", "2026-01-01");
  const latest = host.asked.log[host.asked.log.length - 1];
  assert.equal(latest.author, "Grace", "the fields accumulate instead of replacing each other");
  assert.equal(latest.path, "src/a.ts");
  assert.equal(latest.content, "needle");
  assert.equal(latest.since, "2026-01-01");

  const current = host.v.$("#history-filter-current");
  current.checked = true;
  current.dispatchEvent(new host.v.window.Event("change", { bubbles: true }));
  await host.v.settle(320);
  assert.equal(host.asked.log[host.asked.log.length - 1].currentBranchOnly, true);
  host.v.close();
});

test("typing is debounced into one query, not one per keystroke", async () => {
  const host = await openHistory();
  const before = host.asked.log.length;
  const field = host.v.$("#history-search");
  for (const value of ["f", "fi", "fix"]) {
    field.value = value;
    field.dispatchEvent(new host.v.window.Event("input", { bubbles: true }));
    await host.v.settle(30);
  }
  await host.v.settle(320);
  assert.equal(host.asked.log.length - before, 1, "three keystrokes, one git invocation");
  assert.equal(host.asked.log[host.asked.log.length - 1].text, "fix");
  host.v.close();
});

test("a reload does not take the keyboard away from the box being typed in", async () => {
  const host = await openHistory();
  const field = host.v.$("#history-search");
  field.focus();
  await type(host, "history-search", "fix");
  assert.equal(host.v.document.activeElement, field,
    "the list reloaded underneath, and the rest of the word still goes into the box");
  host.v.close();
});

test("clearing the filters empties every field and re-reads the log", async () => {
  const host = await openHistory();
  host.v.$("#history-filter-toggle").click();
  await type(host, "history-filter-author", "Grace");
  host.v.$("#history-filter-clear").click();
  await host.v.settle(40);
  assert.equal(host.v.$("#history-filter-author").value, "");
  assert.equal(host.asked.log[host.asked.log.length - 1].author, "");
  host.v.close();
});

test("a hash typed in the box offers to go to the commit it names", async () => {
  const host = await openHistory({
    revision: { hash: "d".repeat(40), short: "ddddddd", subject: "a commit from another page", author: "Ada", date: "2026-01-01T10:00:00+09:00", refs: "" },
  });
  await type(host, "history-search", "ddddddd");
  assert.deepEqual(host.asked.resolve, ["ddddddd"]);
  const bar = host.v.$("#history-select-bar");
  assert.match(bar.textContent, /a commit from another page/);
  host.v.$("#hsel-goto").click();
  await host.v.settle(40);
  assert.deepEqual(host.asked.compare[0], [`${"d".repeat(40)}^`, "d".repeat(40)]);
  host.v.close();
});

test("a hash already on screen is selected rather than offered as a jump", async () => {
  const host = await openHistory({
    revision: { hash: "b".repeat(40), short: "bbbbbbb", subject: "older commit", author: "Grace", date: "2026-05-31T10:00:00+09:00", refs: "" },
  });
  await type(host, "history-search", "bbbbbbb");
  assert.equal(host.v.$("#hsel-goto"), null, "nothing to jump to — it is right there");
  assert.equal(host.v.$(`#history-list .hrow[data-sha="${"b".repeat(40)}"]`).classList.contains("active"), true);
  host.v.close();
});

test("ordinary words stay a text filter even though the box also resolves revisions", async () => {
  const host = await openHistory(); // resolveRevision answers null, as it does for words
  await type(host, "history-search", "older");
  assert.equal(host.v.$("#hsel-goto"), null);
  assert.equal(host.asked.log[host.asked.log.length - 1].text, "older");
  host.v.close();
});

test("⌘C copies the selected commit's hash", async () => {
  const host = await openHistory();
  host.v.$(`#history-list .hrow[data-sha="${"a".repeat(40)}"]`).click();
  await host.v.settle(20);
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", {
    key: "c", code: "KeyC", metaKey: true, bubbles: true,
  }));
  await host.v.settle(20);
  assert.deepEqual(host.clipboard, ["a".repeat(40)]);
  host.v.close();
});

test("⌘C inside the search box is left to the box", async () => {
  const host = await openHistory();
  const field = host.v.$("#history-search");
  field.focus();
  host.v.document.dispatchEvent(new host.v.window.KeyboardEvent("keydown", {
    key: "c", code: "KeyC", metaKey: true, bubbles: true,
  }));
  await host.v.settle(20);
  assert.deepEqual(host.clipboard, [], "copying text you have selected in a field is that field's ⌘C");
  host.v.close();
});

test("a file's history is the log with its path, followed through renames", async () => {
  const host = await openHistory();
  host.v.window.__kakapoHistory.openFile("src/a.ts");
  await host.v.settle(40);
  const request = host.asked.log[host.asked.log.length - 1];
  assert.equal(request.path, "src/a.ts");
  assert.equal(request.follow, true, "a rename does not end the story");
  assert.equal(host.v.$("#history-scope").textContent, "src/a.ts");
  assert.equal(host.v.$("#history-scope").classList.contains("hidden"), false);
  // A scoped history is one file's story: the repository-wide kinds and filters do not apply to it.
  assert.equal(host.v.$(".history-kinds").classList.contains("hidden"), true);
  assert.equal(host.v.$("#history-filter-toggle").classList.contains("hidden"), true);
  host.v.close();
});

test("a line's history still asks for that line, and says which line it is showing", async () => {
  const host = await openHistory();
  host.v.window.__kakapoHistory.openLine("src/a.ts", 7);
  await host.v.settle(40);
  const request = host.asked.log[host.asked.log.length - 1];
  assert.equal(request.line, 7);
  assert.equal(host.v.$("#history-scope").textContent, "src/a.ts:L7");
  host.v.close();
});

test("an empty answer explains itself per kind", async () => {
  const host = await openHistory({ commits: [] });
  assert.match(host.v.$("#history-list").textContent, /No commits/);
  await type(host, "history-search", "nothing matches this");
  assert.match(host.v.$("#history-list").textContent, /No commit matches/,
    "with a filter on, the empty list is a filtered one — not an empty repository");
  host.v.close();
});
