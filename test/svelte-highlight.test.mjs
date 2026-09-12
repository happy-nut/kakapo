// CORE: a .svelte diff has to be highlighted as the code it actually is. hljs resolves a single-file
// component to its `xml` grammar, which colours the tags and leaves the <script> body plain — and a diff
// shows hunks, so the block a line is in is usually not visible from the hunk itself. The fix reads the
// whole file to decide, and these guard both halves of that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderDiff2Html } from "../dist/highlight.js";
import { renderLazyDiffBody } from "../dist/build.js";
import { readUnifiedDiff } from "../dist/diff.js";

// A component whose <script> runs long enough that a change in the middle of it cannot see either end —
// the ordinary shape of a real .svelte file, and the one the hunk-only scanner cannot read.
function componentSource(listLiteral) {
  const filler = (from, to, name) =>
    Array.from({ length: to - from + 1 }, (_, i) => `  const ${name}${from + i} = ${from + i};`).join("\n");
  return [
    '<script lang="ts">',
    filler(1, 60, "value"),
    "  function step(delta: number) {",
    `    const list = ${listLiteral};`,
    "    if (delta) return list.length;",
    "  }",
    filler(61, 120, "other"),
    "</script>",
    "",
    '<main class="shell"><button>hi</button></main>',
    "",
    "<style>",
    "  .shell { display: flex; }",
    "</style>",
    "",
  ].join("\n");
}

function repoWithEditedComponent() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-svelte-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "Test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Big.svelte"), componentSource("[1, 2, 3]"));
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(root, "src", "Big.svelte"), componentSource("[1, 2, 3, 4]"));
  return { root, text: componentSource("[1, 2, 3, 4]") };
}

function tokenKinds(html) {
  return new Set(Array.from(html.matchAll(/hljs-([\w-]+)/g), (m) => m[1]));
}

test("a hunk deep inside <script> is highlighted as script, not as markup", () => {
  const { root, text } = repoWithEditedComponent();
  try {
    const diff = readUnifiedDiff({ staged: false, context: 3, includeUntracked: true, root });
    assert.doesNotMatch(diff, /^[ +-]<script/m, "the hunk really does not carry its own <script> opener");

    // Reading the hunks alone, there is nothing to say these lines are code — this is the floor.
    assert.equal(tokenKinds(renderDiff2Html(diff)).size, 0, "no file, no highlighting");

    const kinds = tokenKinds(renderDiff2Html(diff, () => text));
    assert.ok(kinds.has("keyword"), `const/if/return are keywords (got ${[...kinds].join(", ") || "nothing"})`);
    assert.ok(kinds.has("number"), "and the literals are numbers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The app fetches one file's diff body at a time (kakapo:get-file), so the same lookup has to reach that
// path too — it is the path every review in the desktop app actually takes.
test("a lazily fetched diff body gets the same treatment", () => {
  const { root, text } = repoWithEditedComponent();
  try {
    const diff = readUnifiedDiff({ staged: false, context: 3, includeUntracked: true, root });
    assert.equal(tokenKinds(renderLazyDiffBody(diff)).size, 0);
    assert.ok(tokenKinds(renderLazyDiffBody(diff, () => text)).has("keyword"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The three blocks are three languages, and the lines that carry the tags belong to the markup around them.
test("<script>, template and <style> are each read as their own language", () => {
  const { root, text } = repoWithEditedComponent();
  try {
    // A whole-file diff (every line added) so all three blocks are on screen at once.
    const wholeFile = ["diff --git a/src/Big.svelte b/src/Big.svelte", "new file mode 100644",
      "--- /dev/null", "+++ b/src/Big.svelte", `@@ -0,0 +1,${text.split("\n").length} @@`,
      ...text.split("\n").map((line) => `+${line}`)].join("\n");
    const html = renderDiff2Html(wholeFile, () => text);
    const kinds = tokenKinds(html);
    assert.ok(kinds.has("keyword"), "the script block is script");
    assert.ok(kinds.has("tag"), "the template is markup");
    assert.ok(kinds.has("selector-class") || kinds.has("attribute"), `the style block is css (got ${[...kinds].join(", ")})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A history diff has no working-tree file behind it, so it keeps the hunk-only scanner. It must still read
// a hunk that DOES carry its own opener.
test("with no file to consult, a hunk carrying its own <script> still highlights", () => {
  const short = ['<script lang="ts">', "  const answer = 42;", "</script>", "<main>hi</main>", ""].join("\n");
  const diff = ["diff --git a/Small.svelte b/Small.svelte", "new file mode 100644",
    "--- /dev/null", "+++ b/Small.svelte", "@@ -0,0 +1,5 @@",
    ...short.split("\n").map((line) => `+${line}`)].join("\n");
  const kinds = tokenKinds(renderDiff2Html(diff));
  assert.ok(kinds.has("keyword"), `the scanner sees the opener in the hunk (got ${[...kinds].join(", ")})`);
});
