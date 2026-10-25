// What the diff counts as a difference, how much of a changed line is coloured, and the overview stripe —
// the three things IntelliJ's diff puts behind its gear, ported into kakapo's own places (the Diff menu,
// Settings, and a ruler beside the scrollbar).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnifiedDiff } from "../dist/diff.js";
import { writeReviewWorkspace, reviewBodiesFile } from "../dist/review-workspace.js";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

// ---- how much whitespace difference is a difference -------------------------------------------------

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "kakapo-ws-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "ada@kakapo.test"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "ws.ts"), [
    "const indented = 1;",      // gains leading whitespace
    "const amount = 1;",        // one space becomes two
    "const trailing = 1;",      // gains trailing whitespace
    "const tight=1;",           // gains whitespace where there was none
    "const real = 1;",          // a real change, which must survive every mode
  ].join("\n") + "\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  writeFileSync(join(root, "ws.ts"), [
    "  const indented = 1;",
    "const amount  = 1;",
    "const trailing = 1;   ",
    "const tight = 1;",
    "const real = 2;",
  ].join("\n") + "\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

const changedLines = (mode) => {
  const diff = readUnifiedDiff({ staged: false, includeUntracked: false, context: 0, root, whitespace: mode });
  return diff.split("\n").filter((line) => /^[+-][^+-]/.test(line)).map((line) => line.trim());
};

test("`none` counts every whitespace difference", () => {
  const lines = changedLines("none");
  assert.ok(lines.some((line) => line.includes("indented")), "a line that gained indentation changed");
  assert.ok(lines.some((line) => line.includes("amount")));
  assert.ok(lines.some((line) => line.includes("trailing")));
  assert.ok(lines.some((line) => line.includes("real")));
});

test("`trim` ignores how much whitespace there is, but not whitespace appearing where there was none", () => {
  const lines = changedLines("trim");
  assert.ok(!lines.some((line) => line.includes("amount")), "one space becoming two is not a change");
  assert.ok(!lines.some((line) => line.includes("trailing")), "nor is whitespace at end of line");
  assert.ok(lines.some((line) => line.includes("tight")),
    "but `a=1` becoming `a = 1` is: git's -b is about the amount, not the presence");
  assert.ok(lines.some((line) => line.includes("real")), "and a real change always survives");
});

test("`all` ignores whitespace entirely", () => {
  const lines = changedLines("all");
  assert.deepEqual(lines.filter((line) => !line.includes("real")), [],
    "every whitespace-only line is gone");
  assert.ok(lines.some((line) => line.includes("real")));
});

test("the older --ignore-whitespace boolean still means `all`, and the mode wins over it", () => {
  const legacy = readUnifiedDiff({ staged: false, includeUntracked: false, context: 0, root, ignoreWhitespace: true });
  assert.ok(!legacy.includes("indented"), "the boolean is the `all` mode under its old name");
  const both = readUnifiedDiff({
    staged: false, includeUntracked: false, context: 0, root, ignoreWhitespace: true, whitespace: "none",
  });
  assert.ok(both.includes("indented"), "an explicit mode is the one that is honoured");
});

test("context is what it says: the unchanged lines kept around a change", () => {
  const tight = readUnifiedDiff({ staged: false, includeUntracked: false, context: 0, root, whitespace: "all" });
  const wide = readUnifiedDiff({ staged: false, includeUntracked: false, context: 50, root, whitespace: "all" });
  const unchanged = (diff) => diff.split("\n").filter((line) => /^ \S/.test(line)).length;
  assert.equal(unchanged(tight), 0);
  assert.equal(unchanged(wide), 3, "every unchanged line in the file comes along");
});

// The mode reaching readUnifiedDiff is not the same claim as the mode reaching the APP: the review build
// assembles its input field by field, so an option added to the diff reader and to the menu can still be a
// silent no-op in between. This is the gate on the path the app actually takes.
test("the whitespace mode survives the review build, not only the diff reader", () => {
  const out = mkdtempSync(join(tmpdir(), "kakapo-ws-build-"));
  try {
    const built = (whitespace) => {
      const target = join(out, whitespace, "app-review.html");
      writeReviewWorkspace(target, {
        root, staged: false, includeUntracked: false, context: 0, ignoreWhitespace: false, whitespace,
      }, "kakapo");
      return readFileSync(reviewBodiesFile(target), "utf8");
    };
    assert.ok(built("none").includes("const indented"), "with `none` the whitespace-only change is there");
    const ignored = built("all");
    assert.ok(!ignored.includes("const indented"), "with `all` it is gone from what the app renders");
    assert.ok(ignored.includes("const real"), "and the real change still is not");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- the viewer: highlighting mode and the overview stripe -------------------------------------------

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    {
      path: "src/wide.ts",
      // Two separate changes with unchanged code between them, so the stripe has more than one mark and
      // their order is observable.
      before: ["const a = 1;", "const keep1 = 1;", "const keep2 = 2;", "const b = 1;", "const keep3 = 3;"].join("\n") + "\n",
      after: ["const a = 99;", "const keep1 = 1;", "const keep2 = 2;", "const b = 99;", "const keep3 = 3;"].join("\n") + "\n",
    },
  ]));
});
after(cleanupFixtures);

test("a changed line's differing characters are marked, which is what the `word` mode reads", async () => {
  const v = await loadViewer(html);
  const wrapper = v.window.diffWrapperByPath("src/wide.ts");
  assert.ok(wrapper.querySelector(".d2h-code-line-ctn ins, .d2h-code-line-ctn del"),
    "diff2html emits per-character marks; all three highlight modes are CSS readings of this one DOM");
  v.close();
});

test("the highlight mode is an attribute, persisted, and defaults to the characters that differ", async () => {
  const v = await loadViewer(html);
  assert.equal(v.document.documentElement.getAttribute("data-diff-highlight"), "word");
  v.window.applyDiffHighlight("line");
  assert.equal(v.document.documentElement.getAttribute("data-diff-highlight"), "line");
  v.window.applyDiffHighlight("none");
  assert.equal(v.document.documentElement.getAttribute("data-diff-highlight"), "none");
  v.window.applyDiffHighlight("nonsense");
  assert.equal(v.document.documentElement.getAttribute("data-diff-highlight"), "none", "an unknown mode is ignored");
  const saved = v.exportStorage()["kakapo-diff-highlight"];
  v.close();
  assert.equal(saved, "none", "the choice survives a reopen");
});

test("the stripe marks each run of changes once, not each changed line", async () => {
  const v = await loadViewer(html);
  v.window.showDiffView();
  v.window.showOnlyFile("src/wide.ts");
  v.window.renderDiffStripe();
  const stripe = v.$("#diff-stripe");
  assert.ok(stripe, "the stripe is created beside the diff scroller");
  assert.equal(stripe.classList.contains("hidden"), false);
  const marks = v.$all("#diff-stripe .diff-stripe-mark");
  assert.equal(marks.length, 2, "two changes in the file, two marks — not two per changed line");
  assert.ok(marks.every((mark) => mark.classList.contains("is-change")),
    "a deletion and the insertion that replaces it are one modification to the reader");
  assert.ok(v.$("#diff-stripe .diff-stripe-viewport"), "and a box for where in the file the reader is");
  v.close();
});

test("the stripe lives beside the scroller, not inside it — a ruler that scrolls away is not a ruler", async () => {
  const v = await loadViewer(html);
  v.window.showDiffView();
  v.window.showOnlyFile("src/wide.ts");
  v.window.renderDiffStripe();
  const scroller = v.$("#diff2html-container");
  assert.equal(v.$("#diff-stripe").parentElement, scroller.parentElement);
  assert.equal(scroller.contains(v.$("#diff-stripe")), false);
  v.close();
});

test("a comment thread is a mark of its own", async () => {
  const v = await loadViewer(html);
  v.window.showDiffView();
  v.window.showOnlyFile("src/wide.ts");
  // Build a comment row the way the diff does, then re-read the stripe.
  const wrapper = v.window.diffWrapperByPath("src/wide.ts");
  const side = v.window.diffSideTable(wrapper, "new");
  const body = side.querySelector("tbody") ?? side;
  const row = v.document.createElement("tr");
  row.className = "mc-comment-row";
  row.innerHTML = '<td class="num"></td><td class="source-code">a question</td>';
  body.appendChild(row);
  v.window.renderDiffStripe();
  const kinds = v.$all("#diff-stripe .diff-stripe-mark").map((mark) => mark.className);
  assert.ok(kinds.some((name) => name.includes("is-comment")), `a comment mark is drawn (got ${kinds.join(" | ")})`);
  v.close();
});

test("a file with nothing changed on screen gets no ruler rather than an empty one", async () => {
  const v = await loadViewer(html);
  v.window.showDiffView();
  v.window.showOnlyFile("src/wide.ts");
  v.window.renderDiffStripe();
  const wrapper = v.window.diffWrapperByPath("src/wide.ts");
  wrapper.querySelectorAll("td.d2h-ins, td.d2h-del, td.d2h-change")
    .forEach((cell) => cell.classList.remove("d2h-ins", "d2h-del", "d2h-change"));
  v.window.renderDiffStripe();
  assert.equal(v.$("#diff-stripe").classList.contains("hidden"), true,
    "an empty ruler would read as 'this file has no changes'");
  v.close();
});
