// Drives the two shell pages (rail + modal overlay) in jsdom, the way the real app does: main pushes a
// hub-state, the user hits ⌘N, and the overlay opens the New-workspace dialog with whatever payload the rail
// sent. Covers three behaviours that only exist inside those inline page scripts:
//   - a main checkout parked on a feature branch still reads as the project's main (it used to be labelled by
//     the branch, so a project whose main wasn't on `main` looked like it had no main at all),
//   - ⌘N prefills the project of the active workspace,
//   - the "create a new worktree" toggle reaches the create/preview IPC and hides the now-meaningless task name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { hubHtml, modalOverlayHtml } from "../dist/shell-pages.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const t = (key) => key;

// One stub for both preloads: `on*` members stash the callback so the test can play main's role, everything
// else records its arguments. Async members resolve with whatever the test parked in `results`.
function stubHub(results = {}) {
  const handlers = {}, calls = [];
  const api = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (name.startsWith("on")) return (callback) => { handlers[name] = callback; };
      return (...args) => {
        calls.push({ name, args });
        return Promise.resolve(name in results ? results[name] : { ok: true });
      };
    },
  });
  // Arguments cross the jsdom realm boundary, so a payload object isn't deepEqual to a plain one here — compare
  // the JSON shape instead. `undefined` survives as null, which is all these assertions need to tell apart.
  const lastCall = (name) => {
    const call = [...calls].reverse().find((c) => c.name === name);
    return call ? JSON.parse(JSON.stringify(call.args.map((a) => (a === undefined ? null : a)))) : undefined;
  };
  return { api, handlers, calls, lastCall };
}

// Both pages arm long-lived timers (the rail polls agent usage every 60s), and jsdom keeps a window alive
// while a timer is pending — so an unclosed window stops the test process from ever exiting. Close them all.
const openWindows = [];
after(() => { for (const w of openWindows) { try { w.close(); } catch { /* already gone */ } } });

function loadPage(html, hub) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse: (window) => {
      window.kakapoHub = hub.api;
      // jsdom has no dialog layout engine; showModal/close just need to exist and flip `open`.
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function (value) {
        this.open = false; this.returnValue = value ?? "";
        this.dispatchEvent(new window.Event("close"));
      };
    } });
  openWindows.push(dom.window);
  return dom.window.document;
}

const KAKAPO_MAIN = { id: 1, path: "/repos/kakapo", repoRoot: "/repos/kakapo", repoName: "kakapo",
  branch: "main", kind: "main", active: false };
// The reported case: zoobox's ONLY checkout is its main, sitting on a feature branch.
const ZOOBOX_MAIN = { id: 2, path: "/repos/zoobox", repoRoot: "/repos/zoobox", repoName: "zoobox",
  branch: "claude/legacy-strategy-removal", kind: "main", active: true };
const ZOOBOX_WORKTREE = { id: 3, path: "/kakapo/workspaces/zoobox/fix-login", repoRoot: "/repos/zoobox",
  repoName: "zoobox", branch: "kakapo/fix-login", kind: "worktree", active: false };

function railWithState(items) {
  const hub = stubHub();
  const document = loadPage(hubHtml(false, "1.0.0", t), hub);
  hub.handlers.onState(items);
  return { hub, document };
}

// The expanded rail card: bold name on top, real branch underneath.
const cardName = (document, branch) => {
  const card = [...document.querySelectorAll(".ev .wt")]
    .find((el) => el.querySelector(".wt-branch")?.textContent === branch);
  return card?.querySelector(".wt-name")?.textContent;
};

test("a main checkout on a feature branch is still labelled as the main worktree", () => {
  const { document } = railWithState([ZOOBOX_MAIN, KAKAPO_MAIN]);
  assert.equal(cardName(document, "claude/legacy-strategy-removal"), "hub.mainWorktree");
  // ...and its branch is still shown, so nothing is hidden by the rename.
  assert.equal(cardName(document, "main"), "hub.mainWorktree");
});

test("worktrees keep their branch as the label, and an alias still wins everywhere", () => {
  const { document } = railWithState([ZOOBOX_WORKTREE, { ...KAKAPO_MAIN, alias: "trunk" }]);
  assert.equal(cardName(document, "kakapo/fix-login"), "kakapo/fix-login");
  assert.equal(cardName(document, "main"), "trunk");
});

// The expanded card for a given branch, whichever project it sits under.
const cardFor = (document, branch) => [...document.querySelectorAll(".ev .wt")]
  .find((el) => el.querySelector(".wt-branch")?.textContent === branch);

test("an expanded tile badges the agent its worktree is running", () => {
  const { document } = railWithState([
    { ...ZOOBOX_WORKTREE, agent: "claude" },
    { ...KAKAPO_MAIN, branch: "topic", kind: "worktree", agent: "codex" },
  ]);

  const claude = cardFor(document, "kakapo/fix-login").querySelector(".wt-agent");
  assert.ok(claude, "a claude worktree carries a badge");
  assert.equal(claude.getAttribute("aria-label"), "Claude", "the badge names the agent for a screen reader");
  // The brand colour comes from the icon's own class, which is what makes claude and codex tell apart at
  // 12px — a shared monochrome glyph would defeat the whole point of the badge.
  assert.ok(claude.querySelector("svg.usage-ico-claude"), "claude keeps its own mark");

  assert.ok(cardFor(document, "topic").querySelector("svg.usage-ico-codex"), "codex keeps its own mark");
});

// A workspace with something waiting in it — an agent finished a turn, or answered a review comment — has to
// read differently from one that is merely alive. Both wore the same green dot in the expanded rail, so the
// one you needed to open looked exactly like the three you did not.
test("a workspace with something waiting wears a red dot, not the running green", () => {
  const { document } = railWithState([
    { ...ZOOBOX_WORKTREE, running: true, unread: true },
    { ...KAKAPO_MAIN, branch: "topic", kind: "worktree", running: true },
  ]);
  const css = document.querySelector("style").textContent;

  assert.ok(cardFor(document, "kakapo/fix-login").classList.contains("attn"), "the waiting one is flagged");
  assert.ok(!cardFor(document, "topic").classList.contains("attn"), "the busy-but-read one is not");
  assert.ok(document.querySelector(".cv .wt.attn .udot"), "the collapsed strip keeps its own red dot");

  const attn = css.slice(css.indexOf(".ev .wt.attn .dot"));
  assert.match(attn.slice(0, attn.indexOf("}")), /background:#e5484d/, "the expanded dot goes red");
  assert.ok(css.indexOf(".ev .wt.attn .dot") > css.indexOf(".ev .wt.running .dot"),
    "and wins over the green, which is only source order away");

  // Working right now is a third state, and it has to look like work: a steady disc already says "alive", so
  // a pulsing one said nothing new. The ring turns.
  const busy = css.slice(css.indexOf(".ev .wt.busy .dot"));
  const busyRule = busy.slice(0, busy.indexOf("}"));
  assert.match(busyRule, /animation:wtspin/, "a working workspace spins");
  assert.match(busyRule, /box-sizing:border-box/, "…inside the same 8px slot, so nothing beside it moves");
  assert.ok(css.indexOf(".ev .wt.attn .dot") > css.indexOf(".ev .wt.busy .dot"),
    "and something waiting still outranks something working");
});

test("a worktree with no agent gets no badge, and the collapsed rail never does", () => {
  // No agent is a real state — a worktree you have only run shell commands in — and must read as absent
  // rather than as an unnamed agent.
  const { document } = railWithState([ZOOBOX_WORKTREE, { ...KAKAPO_MAIN, agent: "claude" }]);
  assert.equal(cardFor(document, "kakapo/fix-login").querySelector(".wt-agent"), null);
  // The collapsed strip is 46px of initials and a status dot; the badge belongs to the expanded rail only.
  assert.equal(document.querySelector(".cv .wt-agent"), null, "no badge in the collapsed rail");
});

test("the + button and ⌘N both prefill the active workspace's project", () => {
  const { hub, document } = railWithState([KAKAPO_MAIN, ZOOBOX_MAIN]);
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/zoobox", name: "zoobox" }]);
  hub.handlers.onNew();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/zoobox", name: "zoobox" }]);
});

// A detached workspace has its own OS window, so the hub's "active" can name a different one entirely —
// ⌘N pressed in B offered A. Main now names the project of the window the key was pressed in, and that wins
// over whatever the rail last saw activated.
test("⌘N takes the project main names, over the rail's own active workspace", () => {
  const { hub, document } = railWithState([KAKAPO_MAIN, ZOOBOX_MAIN]); // zoobox is the active one
  hub.handlers.onNew({ path: "/repos/kakapo", name: "kakapo" });
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/kakapo", name: "kakapo" }]);

  // With nothing named (no workspace open anywhere), the rail's own answer still stands.
  hub.handlers.onNew(undefined);
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/zoobox", name: "zoobox" }]);

  // The + button hands its click event to the same function; a MouseEvent must not read as a project.
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/zoobox", name: "zoobox" }]);
});

test("an active worktree prefills its PROJECT root, not the worktree path", () => {
  const { hub, document } = railWithState([{ ...ZOOBOX_WORKTREE, active: true }]);
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/zoobox", name: "zoobox" }]);
});

test("with no active workspace ⌘N opens the dialog with no prefill", () => {
  const { hub, document } = railWithState([{ ...KAKAPO_MAIN, active: false }]);
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", null]);
});

function openDialog(payload, results) {
  const hub = stubHub(results);
  const document = loadPage(modalOverlayHtml(false, t), hub);
  hub.handlers.onModalOpen({ type: "new", ...payload });
  return { hub, document };
}

test("the dialog opens with the prefilled project already selected", async () => {
  const { hub, document } = openDialog({ path: "/repos/zoobox", name: "zoobox" });
  await tick();
  assert.equal(document.querySelector("#repo").value, "/repos/zoobox");
  assert.equal(document.querySelector("#repoName").textContent, "zoobox");
  assert.ok(!document.querySelector("#repoName").classList.contains("ph"), "placeholder styling cleared");
  // A prefilled project previews immediately instead of waiting for a pick.
  assert.deepEqual(hub.lastCall("preview"), ["/repos/zoobox", "", true]);
});

test("without a prefill the dialog still opens empty on the project chooser", async () => {
  const { hub, document } = openDialog({});
  await tick();
  assert.equal(document.querySelector("#repo").value, "");
  assert.equal(document.querySelector("#repoName").textContent, "newws.selectProject");
  assert.equal(hub.lastCall("preview"), undefined);
});

test("the new-worktree toggle defaults on and creates a worktree", async () => {
  const { hub, document } = openDialog({ path: "/repos/zoobox", name: "zoobox" });
  await tick();
  assert.equal(document.querySelector("#wtNew").checked, true);
  assert.ok(!document.querySelector("#labelRow").classList.contains("hidden"), "task name is asked for");
  document.querySelector("#label").value = "fix-login";
  document.querySelector("#doCreate").click();
  await tick();
  assert.deepEqual(hub.lastCall("create"), ["/repos/zoobox", "fix-login", true]);
});

test("unchecking it hides the task name and opens the checkout instead", async () => {
  const { hub, document } = openDialog({ path: "/repos/zoobox", name: "zoobox" });
  await tick();
  const box = document.querySelector("#wtNew");
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event("change"));
  await tick();
  assert.ok(document.querySelector("#labelRow").classList.contains("hidden"), "task name is irrelevant");
  assert.deepEqual(hub.lastCall("preview"), ["/repos/zoobox", "", false]);
  document.querySelector("#doCreate").click();
  await tick();
  assert.deepEqual(hub.lastCall("create"), ["/repos/zoobox", "", false]);
});

test("re-opening the dialog resets the toggle back on", async () => {
  const { hub, document } = openDialog({ path: "/repos/zoobox", name: "zoobox" });
  await tick();
  const box = document.querySelector("#wtNew");
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event("change"));
  hub.handlers.onModalOpen({ type: "new", path: "/repos/kakapo", name: "kakapo" });
  await tick();
  assert.equal(box.checked, true, "a stale toggle would silently skip worktree creation next time");
  assert.ok(!document.querySelector("#labelRow").classList.contains("hidden"));
});
