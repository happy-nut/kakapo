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
// The reported case: acme's ONLY checkout is its main, sitting on a feature branch.
const ACME_MAIN = { id: 2, path: "/repos/acme", repoRoot: "/repos/acme", repoName: "acme",
  branch: "claude/legacy-strategy-removal", kind: "main", active: true };
const ACME_WORKTREE = { id: 3, path: "/kakapo/workspaces/acme/fix-login", repoRoot: "/repos/acme",
  repoName: "acme", branch: "kakapo/fix-login", kind: "worktree", active: false };

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
  const { document } = railWithState([ACME_MAIN, KAKAPO_MAIN]);
  assert.equal(cardName(document, "claude/legacy-strategy-removal"), "hub.mainWorktree");
  // ...and its branch is still shown, so nothing is hidden by the rename.
  assert.equal(cardName(document, "main"), "hub.mainWorktree");
});

test("worktrees keep their branch as the label, and an alias still wins everywhere", () => {
  const { document } = railWithState([ACME_WORKTREE, { ...KAKAPO_MAIN, alias: "trunk" }]);
  assert.equal(cardName(document, "kakapo/fix-login"), "kakapo/fix-login");
  assert.equal(cardName(document, "main"), "trunk");
});

// The expanded card for a given branch, whichever project it sits under.
const cardFor = (document, branch) => [...document.querySelectorAll(".ev .wt")]
  .find((el) => el.querySelector(".wt-branch")?.textContent === branch);

test("an expanded tile badges the agent its worktree is running", () => {
  const { document } = railWithState([
    { ...ACME_WORKTREE, agent: "claude" },
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
    { ...ACME_WORKTREE, running: true, unread: true },
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
  const { document } = railWithState([ACME_WORKTREE, { ...KAKAPO_MAIN, agent: "claude" }]);
  assert.equal(cardFor(document, "kakapo/fix-login").querySelector(".wt-agent"), null);
  // The collapsed strip is 46px of initials and a status dot; the badge belongs to the expanded rail only.
  assert.equal(document.querySelector(".cv .wt-agent"), null, "no badge in the collapsed rail");
});

test("the + button and ⌘N both prefill the active workspace's project", () => {
  const { hub, document } = railWithState([KAKAPO_MAIN, ACME_MAIN]);
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/acme", name: "acme" }]);
  hub.handlers.onNew();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/acme", name: "acme" }]);
});

// A detached workspace has its own OS window, so the hub's "active" can name a different one entirely —
// ⌘N pressed in B offered A. Main now names the project of the window the key was pressed in, and that wins
// over whatever the rail last saw activated.
test("⌘N takes the project main names, over the rail's own active workspace", () => {
  const { hub, document } = railWithState([KAKAPO_MAIN, ACME_MAIN]); // acme is the active one
  hub.handlers.onNew({ path: "/repos/kakapo", name: "kakapo" });
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/kakapo", name: "kakapo" }]);

  // With nothing named (no workspace open anywhere), the rail's own answer still stands.
  hub.handlers.onNew(undefined);
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/acme", name: "acme" }]);

  // The + button hands its click event to the same function; a MouseEvent must not read as a project.
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/acme", name: "acme" }]);
});

test("an active worktree prefills its PROJECT root, not the worktree path", () => {
  const { hub, document } = railWithState([{ ...ACME_WORKTREE, active: true }]);
  document.querySelector("#new").click();
  assert.deepEqual(hub.lastCall("openModal"), ["new", { path: "/repos/acme", name: "acme" }]);
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
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" });
  await tick();
  assert.equal(document.querySelector("#repo").value, "/repos/acme");
  assert.equal(document.querySelector("#repoName").textContent, "acme");
  assert.ok(!document.querySelector("#repoName").classList.contains("ph"), "placeholder styling cleared");
  // A prefilled project previews immediately instead of waiting for a pick.
  assert.deepEqual(hub.lastCall("preview"), ["/repos/acme", "", true, ""]);
});

test("without a prefill the dialog still opens empty on the project chooser", async () => {
  const { hub, document } = openDialog({});
  await tick();
  assert.equal(document.querySelector("#repo").value, "");
  assert.equal(document.querySelector("#repoName").textContent, "newws.selectProject");
  assert.equal(hub.lastCall("preview"), undefined);
});

test("the new-worktree toggle defaults on and creates a worktree", async () => {
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" });
  await tick();
  assert.equal(document.querySelector("#wtNew").checked, true);
  assert.ok(!document.querySelector("#labelRow").classList.contains("hidden"), "task name is asked for");
  document.querySelector("#label").value = "fix-login";
  document.querySelector("#doCreate").click();
  await tick();
  assert.deepEqual(hub.lastCall("create"), ["/repos/acme", "fix-login", true, { base: "", slug: "", memo: "", agent: "claude" }]);
});

test("unchecking it hides the task name and opens the checkout instead", async () => {
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" });
  await tick();
  const box = document.querySelector("#wtNew");
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event("change"));
  await tick();
  assert.ok(document.querySelector("#labelRow").classList.contains("hidden"), "task name is irrelevant");
  assert.deepEqual(hub.lastCall("preview"), ["/repos/acme", "", false, ""]);
  document.querySelector("#doCreate").click();
  await tick();
  assert.deepEqual(hub.lastCall("create"), ["/repos/acme", "", false, { base: "", slug: "", memo: "", agent: "claude" }]);
});

test("re-opening the dialog resets the toggle back on", async () => {
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" });
  await tick();
  const box = document.querySelector("#wtNew");
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event("change"));
  hub.handlers.onModalOpen({ type: "new", path: "/repos/kakapo", name: "kakapo" });
  await tick();
  assert.equal(box.checked, true, "a stale toggle would silently skip worktree creation next time");
  assert.ok(!document.querySelector("#labelRow").classList.contains("hidden"));
});

// Deleting a workspace almost always means the branch it was made for is finished too; leaving the box empty
// made "delete" routinely leave a dead branch behind, and the reviewer had to remember to tick it every time.
test("the delete confirmation offers to remove the local branch, pre-checked", async () => {
  const { hub } = railWithState([ACME_WORKTREE]);
  hub.handlers.onTileAction({ id: 3, name: "fix-login", action: "delete" });
  await tick();
  const [spec] = hub.lastCall("confirm");
  assert.equal(spec.checkbox, "hubdel.checkbox");
  assert.equal(spec.checked, true, "the local branch goes with the workspace unless the reviewer says otherwise");

  // ...and the overlay honours that default instead of always coming up empty.
  const overlay = stubHub();
  const document = loadPage(modalOverlayHtml(false, t), overlay);
  overlay.handlers.onModalOpen({ type: "confirm", ...spec });
  await tick();
  assert.equal(document.querySelector("#cfCheck").checked, true);
});

// Which ref a new worktree branches FROM decides whether it starts life current or already behind. main has
// always accepted a base (createManagedWorkspaceAsync), and the dialog has always PRINTED the default one —
// it just never let anyone change it, so on a repo that develops off the default branch every workspace
// silently started from the wrong place.
test("the start ref is a list of the repo's own refs, and the previewed slug is what gets created", async () => {
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" },
    { preview: { ok: true, worktree: true, slug: "quiet-heron", base: "origin/main", branch: "kakapo/quiet-heron",
      // A ref's short name cannot say which side it lives on (a local branch may be called `origin`), so
      // listStartRefs sends the answer from git's own refname and the picker draws an icon from it.
      refs: [{ ref: "origin/main", remote: true }, { ref: "develop", remote: false }, { ref: "origin/develop", remote: true }],
      path: "~/kakapo/workspaces/acme/quiet-heron" } });
  await tick();

  // A native <select> shipped here first: macOS draws those with the system control and ignores every
  // border/background rule in the dialog, so it landed as a white box in a dark panel. The chosen ref now
  // rides in a hidden input behind the same button+menu the project field uses.
  const base = document.querySelector("#base");
  assert.equal(base.tagName, "INPUT", "the ref is chosen, not typed");
  assert.equal(document.querySelectorAll("#create select").length, 0, "nothing in this dialog is a native select");
  const refItems = () => [...document.querySelectorAll("#baseMenu button")].map((b) => b.dataset.ref);
  assert.deepEqual(refItems(), ["origin/main", "develop", "origin/develop"], "the repo's own refs are the choices");
  const refTitles = () => [...document.querySelectorAll("#baseMenu button")].map((b) => b.title);
  assert.equal(new Set(refTitles()).size, 2, "local and remote refs are labelled apart, not all the same");
  assert.notEqual(refTitles()[0], refTitles()[1], "origin/main (remote) and develop (local) do not read alike");
  assert.equal(document.querySelectorAll("#baseMenu button .pm-ic svg").length, 3, "every ref carries its side as an icon");
  assert.equal(base.value, "origin/main", "and the default is preselected");
  assert.equal(document.querySelector("#baseName").textContent, "origin/main", "the field shows what is selected");
  assert.equal(document.querySelector("#slug").value, "quiet-heron", "the previewed slug is held for create");

  // Typing a task name re-previews on every keystroke; the slug must not reshuffle under the reader, so the
  // one already on screen is sent back with the request.
  const label = document.querySelector("#label");
  label.value = "버그 픽스";
  label.dispatchEvent(new document.defaultView.Event("input"));
  await tick();
  assert.equal(hub.lastCall("preview")?.[3], "quiet-heron", "the preview is told the slug already shown");

  [...document.querySelectorAll("#baseMenu button")].find((b) => b.dataset.ref === "develop").click();
  assert.equal(base.value, "develop", "picking from the menu is what sets the ref");
  assert.equal(document.querySelector("#baseName").textContent, "develop");
  document.querySelector("#desc").value = "왜 만들었는지";
  document.querySelector("#doCreate").click();
  await tick();
  assert.deepEqual(hub.lastCall("create"),
    ["/repos/acme", "버그 픽스", true, { base: "develop", slug: "quiet-heron", memo: "왜 만들었는지", agent: "claude" }]);
});


// Uncommitted changes and unsent commits answer different questions — "have I finished?" and "have I sent
// it?" — and only the first one had a pill. A task worktree nobody has pushed has no upstream, so its count
// is measured against the ref it was branched from (aheadArgs, workspaces.ts).
test("a workspace with unsent commits says so on its tile, and a clean one stays quiet", async () => {
  const { document } = railWithState([
    { ...KAKAPO_MAIN, id: 1, alias: "ahead-one", ahead: 3, dirtyCount: 0 },
    { ...KAKAPO_MAIN, id: 2, path: "/repos/kakapo-b", alias: "clean-one", ahead: 0, dirtyCount: 0 },
  ]);
  await tick();

  const tiles = [...document.querySelectorAll(".ev .wt")];
  const ahead = tiles.find((el) => el.textContent.includes("ahead-one"));
  const clean = tiles.find((el) => el.textContent.includes("clean-one"));
  assert.ok(ahead && clean, "both workspaces render");
  assert.equal(ahead.querySelector(".wt-ahead")?.textContent, "\u21913", "unsent commits get their own pill");
  assert.equal(clean.querySelector(".wt-ahead"), null, "zero is the usual answer and earns no ink");
  assert.match(ahead.getAttribute("title") || "", /hub\.tip\.ahead/, "and the tooltip spells it out");
});

// Pressing Enter on the open rail must enter the selected workspace. It used to close the panel instead: the
// pin you clicked to open the rail keeps keyboard focus in Chromium, and Enter reached it whenever the tile
// branch declined to swallow the key.
test("the rail head gives the keyboard back once the rail is open, and Enter never reaches it", async () => {
  const { hub, document } = railWithState([{ ...KAKAPO_MAIN, id: 1, alias: "one" }]);
  await tick();
  const pin = document.querySelector("#pin");
  pin.focus();
  assert.equal(document.activeElement, pin, "clicking the pin is what focuses it");
  pin.click();
  await tick();
  assert.equal(hub.lastCall("setHubExpanded")?.[0], true, "the rail opened");
  assert.notEqual(document.activeElement, pin, "and the arrow no longer owns the keyboard");

  // With no tile selected at all — a collapsed project group has none — Enter must still be swallowed rather
  // than falling through to whatever chrome button happens to hold focus.
  pin.focus();
  const enter = new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  document.dispatchEvent(enter);
  assert.ok(enter.defaultPrevented, "Enter belongs to the rail's tiles while the rail is open");
});

// The ring on a rail row means "the keyboard is HERE". The expanded rail deliberately survives a click into a
// terminal pane (kakapo:review-clicked), so the ring used to stay painted after the keyboard had left for the
// workspace — a second, competing "selected" workspace next to the real one, in a different project. And it
// was restored by ROW NUMBER after every state push, so a rebuilt list moved it onto whoever now sat in that
// row. The screenshot that reported this had the active workspace filled in one project and the ring around
// an unrelated worktree in another.
const ringed = (document) => [...document.querySelectorAll(".ev .wt.kbd-sel")]
  .map((el) => el.querySelector(".wt-branch")?.textContent);
const filled = (document) => [...document.querySelectorAll(".ev .wt.act")]
  .map((el) => el.querySelector(".wt-branch")?.textContent);
// jsdom always claims focus; drive it the way the shell view actually gets it and loses it.
function setFocus(document, has) {
  const window = document.defaultView;
  Object.defineProperty(document, "hasFocus", { value: () => has, configurable: true });
  window.dispatchEvent(new window.Event(has ? "focus" : "blur"));
}

test("the rail's keyboard ring is only drawn while the rail actually holds the keyboard", () => {
  const items = [KAKAPO_MAIN, { ...ACME_MAIN, active: false }, { ...ACME_WORKTREE, active: true }];
  const { hub, document } = railWithState(items);
  const window = document.defaultView;
  setFocus(document, true); // jsdom starts unfocused; the real rail is focused when you click its pin
  document.getElementById("pin").click(); // expand the rail
  // It opens on the workspace you are in, so the ring and the fill start on the same row.
  assert.deepEqual(ringed(document), filled(document));

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  const moved = ringed(document);
  assert.equal(moved.length, 1, "one row carries the keyboard cursor");
  assert.notDeepEqual(moved, filled(document), "the cursor can sit somewhere other than the active workspace");

  setFocus(document, false); // the user clicks into the terminal — main keeps the rail expanded on purpose
  assert.deepEqual(ringed(document), [], "no ring while the keyboard is in the workspace");
  assert.equal(filled(document).length, 1, "the active workspace is still the one highlighted");

  hub.handlers.onState(items); // agent activity pushes state constantly; the ring must not come back
  assert.deepEqual(ringed(document), [], "a re-render does not resurrect it either");

  setFocus(document, true);
  assert.deepEqual(ringed(document), moved, "focus returning puts it back where it was");
});

test("the keyboard ring follows its workspace across a re-render, not its row number", () => {
  // Rows: 0 kakapo/main (active) · 1 acme/main · 2 acme/fix-login.
  const items = [{ ...KAKAPO_MAIN, active: true }, { ...ACME_MAIN, active: false }, ACME_WORKTREE];
  const { hub, document } = railWithState(items);
  const window = document.defaultView;
  setFocus(document, true);
  document.getElementById("pin").click();
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.deepEqual(ringed(document), ["claude/legacy-strategy-removal"], "the cursor is on acme's main");

  // The kakapo window closes: every row below it shifts up, and a cursor kept as "row 1" now points at
  // acme's fix-login worktree — a workspace the user never moved to.
  hub.handlers.onState(items.slice(1));
  assert.deepEqual(ringed(document), ["claude/legacy-strategy-removal"], "still acme's main, wherever it now sits");
});

// Several worktrees of one repo sit on similar branches, and their title bars read identically — the path is
// the only thing that always tells them apart, and the thing you need when you go to run something there.
test("the title bar says which worktree on disk, with home folded to ~", async () => {
  const { document } = railWithState([
    { ...KAKAPO_MAIN, id: 1, active: true, branch: "fix/issue-1130",
      path: "/repos/acme", shortPath: "~/kakapo/workspaces/acme/quiet-warbler" },
  ]);
  await tick();
  const name = document.querySelector("#wsname");
  assert.match(name.textContent, /kakapo/, "the project is still first");
  assert.match(name.textContent, /fix\/issue-1130/, "then the branch");
  assert.match(name.querySelector(".wspath").textContent, /^~\/kakapo\/workspaces\/acme\/quiet-warbler$/,
    "then where it actually is, with the shared prefix folded away");
});

// Every shortcut this rail has lived only in the menu bar: the buttons carried a native `title`, which this
// frameless child view renders unreliably, and the custom bubble was wired to the top toolbar alone. Hovering
// the rail's own controls therefore told you nothing — least of all that ⌘⇧E and ⌘, existed.
test("the rail's own buttons name their shortcut on hover, like the toolbar's", async () => {
  const { document } = railWithState([{ ...KAKAPO_MAIN, id: 1, alias: "one" }]);
  await tick();
  const tip = document.querySelector("#tt");
  const hover = (id) => {
    document.querySelector(id).dispatchEvent(new document.defaultView.MouseEvent("mouseover", { bubbles: true }));
    return { shown: tip.classList.contains("show"), key: tip.querySelector("kbd")?.textContent };
  };
  assert.deepEqual(hover("#pin"), { shown: true, key: "⌘⇧E" }, "the rail toggle says ⌘⇧E");
  assert.deepEqual(hover("#settings"), { shown: true, key: "⌘," }, "the gear at the bottom says ⌘,");
  assert.deepEqual(hover("#new"), { shown: true, key: "⌘N" }, "and the ＋ says ⌘N");
  // The shortcut belongs in its own kbd, not buried in the sentence, and the label still names the action.
  assert.ok(!/⌘/.test(document.querySelector("#pin").dataset.tip), "the label text does not repeat the keys");
  assert.ok(document.querySelector("#pin").dataset.tip.length > 0, "but there is a label");
});

// A workspace runs several agents at once and the tile had ONE dot for all of them — so the summary was both
// less than you need and, when it was wrong, actively misleading (a tmux pane's pty reports "tmux" forever,
// which read as "still running" and could never turn off). The expanded tile lists the panes themselves.
test("an expanded tile lists what each terminal pane is running, with its own state", async () => {
  const { hub, document } = railWithState([{
    ...KAKAPO_MAIN, id: 1, kind: "worktree", branch: "kakapo/eager-lark", alias: "eager-lark",
    busy: true, running: true, unread: false,
    panes: [
      { id: 1, command: "claude", agent: "claude", running: true, busy: true },
      { id: 2, command: "npm", running: true, busy: false },
      { id: 3, command: "zsh", running: false, busy: false },
    ],
  }]);
  await tick();

  const rows = [...document.querySelectorAll(".ev .wt .wt-pane")];
  assert.equal(rows.length, 3, "one row per pane, including the one that is only a shell");
  assert.match(rows[0].className, /pane-busy/, "the agent mid-turn spins on its own row");
  assert.ok(rows[0].querySelector(".usage-ico"), "…and the agent icon identifies it without repeated text");
  assert.doesNotMatch(rows[0].textContent, /Claude/, "the icon makes an agent-name label redundant");
  assert.match(rows[1].className, /pane-running/, "a plain command is alive but not mid-turn");
  assert.match(rows[1].textContent, /npm/, "…and says which command it is");
  assert.match(rows[2].className, /pane-idle/, "a bare shell is neither");

  // The activity tick has to rebuild these rows: they carry per-pane state, which no class toggle can express.
  hub.handlers.onActivity([{ id: 1, busy: false, unread: true, running: true, panes: [
    { id: 1, command: "claude", agent: "claude", running: true, busy: false },
    { id: 2, command: "zsh", running: false, busy: false },
  ] }]);
  const after = [...document.querySelectorAll(".ev .wt .wt-pane")];
  assert.equal(after.length, 2, "a closed pane leaves the list on the next tick");
  assert.match(after[0].className, /pane-attn/, "the turn that just ended is the one waiting for you");
  assert.ok(!after.slice(1).some((r) => /pane-attn/.test(r.className)), "and only that one — repeated, it stops meaning look-here");
});

// The New-workspace dialog asks for a description, wrote it to the workspace record, and then nothing ever
// read it back: no tile showed it, and Edit memo opened an EMPTY box, so the only thing you could do with the
// note you wrote was overwrite it blind.
test("the workspace description is shown, and Edit memo opens holding it", async () => {
  const { hub, document } = railWithState([{
    ...KAKAPO_MAIN, id: 7, kind: "worktree", branch: "kakapo/eager-lark", alias: "eager-lark",
    memo: "리뷰 코멘트 통합",
  }]);
  await tick();

  assert.equal(document.querySelector(".ev .wt .wt-memo")?.textContent, "리뷰 코멘트 통합", "the note is on the tile");
  assert.match(document.querySelector(".ev .wt").getAttribute("title"), /리뷰 코멘트 통합/, "and in the tooltip the collapsed strip shows");

  hub.handlers.onTileAction({ id: 7, action: "memo", name: "eager-lark" });
  assert.equal(hub.lastCall("openModal")?.[1]?.memo, "리뷰 코멘트 통합", "Edit memo is handed the current note");

  // …and the dialog actually puts it in the box, rather than starting blank the way it always did.
  const overlay = stubHub();
  const overlayDoc = loadPage(modalOverlayHtml(false, t), overlay);
  await tick();
  overlay.handlers.onModalOpen({ type: "memo", id: 7, name: "eager-lark", memo: "리뷰 코멘트 통합" });
  assert.equal(overlayDoc.querySelector("#promptInput").value, "리뷰 코멘트 통합", "the prompt opens prefilled");
});

// Reordering the rail. Press and HOLD lifts a workspace; dragging then moves it inside its project. The hold
// is what keeps ordinary use intact: a press that moves before the timer fires is a scroll, and one that
// never moves is a click, so neither becomes a drag by accident.
test("holding a workspace lifts it, and dropping it reorders its project", async () => {
  const project = (id, name) => ({ ...KAKAPO_MAIN, id, kind: "worktree", alias: name,
    branch: `kakapo/${name}`, path: `/kakapo/workspaces/kakapo/${name}` });
  const { hub, document } = railWithState([project(1, "alpha"), project(2, "beta"), project(3, "gamma")]);
  hub.handlers.onSetExpanded(true);
  await tick();
  const view = document.defaultView;
  const names = () => [...document.querySelectorAll(".ev .wt")].map((el) => el.dataset.name);
  assert.deepEqual(names(), ["alpha", "beta", "gamma"], "the rail starts in the order main sent");

  const tiles = [...document.querySelectorAll(".ev .wt")];
  const press = (target, opts) => target.dispatchEvent(new view.MouseEvent("mousedown",
    { bubbles: true, button: 0, clientX: 50, clientY: 10, ...opts }));
  // jsdom has no layout: say where the drop target is and what the pointer is over.
  document.elementFromPoint = () => tiles[2];
  tiles[2].getBoundingClientRect = () => ({ top: 40, height: 20, bottom: 60, left: 0, right: 100, width: 100 });

  // A press that lets go too early is still a click — nothing is lifted and nothing moves.
  press(tiles[0]);
  document.dispatchEvent(new view.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.ok(!document.querySelector(".wt-lifted"), "a short press never lifts anything");

  press(tiles[0]);
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.ok(tiles[0].classList.contains("wt-lifted"), "holding still lifts the tile");

  tiles[2].dispatchEvent(new view.MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 58 }));
  assert.deepEqual(names(), ["beta", "gamma", "alpha"], "dragging past a tile's midpoint moves it below");

  document.dispatchEvent(new view.MouseEvent("mouseup", { bubbles: true }));
  assert.deepEqual(hub.lastCall("reorder"), ["kakapo", [
    "/kakapo/workspaces/kakapo/beta", "/kakapo/workspaces/kakapo/gamma", "/kakapo/workspaces/kakapo/alpha",
  ]], "the drop reports the project's new order by path");

  // The click that follows a drop would otherwise open whatever the tile landed on.
  tiles[0].click();
  assert.equal(hub.lastCall("activate"), undefined, "dropping a tile does not also switch to it");
});

// A workspace is made to give an agent something to do, and the first thing anyone did in the terminal it
// already opens was type that agent's name. The dialog offers to do it, defaulting to on — and remembers
// which one, because you reach for the same one most days.
test("the New-workspace dialog starts an agent, on by default, on the one used last", async () => {
  const { hub, document } = openDialog({ path: "/repos/acme", name: "acme" },
    { preview: { ok: true, worktree: true, slug: "quiet-heron", base: "origin/main", branch: "kakapo/quiet-heron",
      refs: [{ ref: "origin/main", remote: true }], path: "~/kakapo/workspaces/acme/quiet-heron",
      lastAgent: "codex" } });
  await tick();

  assert.equal(document.querySelector("#agentStart").checked, true, "starting an agent is the default");
  assert.equal(document.querySelector("#agent").value, "codex", "…and it opens on the one used last time");
  assert.equal(document.querySelector("#agentFace .fv").textContent, "Codex", "which the button says");
  // Its own mark, the one the rail already badges tiles with — a picker that names two products and draws
  // neither makes you read where you could have looked.
  assert.ok(document.querySelector("#agentFace .agent-ic-codex svg"), "and shows, in its brand colour");
  assert.deepEqual(
    [...document.querySelectorAll("#agentMenu button")].map((b) => `${b.dataset.agent}:${!!b.querySelector(".agent-ic svg")}`),
    ["claude:true", "codex:true"], "every row in the menu carries its own mark too");

  // Picking one in this dialog must survive the next preview — it re-runs on every keystroke of the task name.
  document.querySelector('#agentMenu button[data-agent="claude"]').click();
  const label = document.querySelector("#label");
  label.value = "버그 픽스";
  label.dispatchEvent(new document.defaultView.Event("input"));
  await tick();
  assert.equal(document.querySelector("#agent").value, "claude", "a deliberate pick is not undone by a re-preview");

  document.querySelector("#doCreate").click();
  await tick();
  assert.equal(hub.lastCall("create")?.[3]?.agent, "claude", "the chosen agent goes with the create request");

  // Unchecking sends nothing — and leaves the picker in place rather than making the row jump.
  document.querySelector("#agentStart").checked = false;
  document.querySelector("#agentStart").dispatchEvent(new document.defaultView.Event("change"));
  assert.ok(document.querySelector("#agentRow").classList.contains("agent-off"), "the row reads as off");
  assert.equal(document.querySelector("#chooseAgent").disabled, true, "and its picker stops answering");
  document.querySelector("#doCreate").click();
  await tick();
  assert.equal(hub.lastCall("create")?.[3]?.agent, "", "nothing is started when it is turned off");
});

// REGRESSION: the agent marks were styled in hubHtml's stylesheet while the picker that draws them lives in
// the overlay — a different document — so the dialog got none of those rules. The SVGs carry no width/height
// of their own: unsized, the mark filled the button (a 15px glyph at ~80px) and collapsed to nothing inside
// the menu rows, where `#create .pmenu .pm-ic{flex:none}` left it no basis to grow from.
test("the agent picker's marks are sized and coloured by the document that draws them", () => {
  const css = modalOverlayHtml(false, t);
  assert.match(css, /#create \.agent-ic svg\{width:15px;height:15px/,
    "the overlay sizes the mark itself — the SVGs have no width/height attribute to fall back on");
  assert.match(css, /#create \.agent-face\{display:inline-flex/, "and lays the button face out");
  // Brand colour has to beat `#create .pmenu .pm-ic`'s flat grey, which is equally specific — hence two classes.
  assert.match(css, /#create \.agent-ic\.agent-ic-codex\{color:#10a37f\}/, "each mark keeps its own colour inside the menu");
  const iconRule = css.indexOf("#create .agent-ic.agent-ic-codex");
  assert.ok(iconRule > css.indexOf("#create .pmenu .pm-ic{"), "…and comes after it, so the tie goes to the brand colour");

  assert.doesNotMatch(hubHtml(false, "1.0.0", t), /\.agent-ic\b/,
    "the rail never draws an .agent-ic, so it must not carry the rules either");
});

test("both agents render a mark in the picker button and in every menu row", async () => {
  const { document } = openDialog({ path: "/repos/acme", name: "acme" });
  await tick();
  assert.ok(document.querySelector("#agentFace .agent-ic svg"), "the button shows the selected agent's mark");
  const rows = [...document.querySelectorAll("#agentMenu button")];
  assert.deepEqual(rows.map((r) => r.dataset.agent), ["claude", "codex"], "both agents are offered");
  for (const row of rows) {
    assert.ok(row.querySelector(".agent-ic svg"), `the ${row.dataset.agent} row carries its mark, not just a label`);
  }
});
