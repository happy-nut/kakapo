import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const viewerDir = fileURLToPath(new URL("../src/viewer/", import.meta.url));
const buildScript = readFileSync(new URL("../scripts/copy-viewer-assets.mjs", import.meta.url), "utf8");

const order = buildScript.match(/const VIEWER_SLICES = \[([\s\S]*?)\];/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
assert.equal(order.length, readdirSync(viewerDir).filter((f) => f.endsWith(".js")).length, "every slice is listed");

const sources = new Map(order.map((f) => [f, readFileSync(join(viewerDir, f), "utf8")]));

const declarations = new Map();
order.forEach((file, index) => {
  sources.get(file).split("\n").forEach((line) => {
    const m = line.match(/^(function|var|let|const)\s+([A-Za-z_$][\w$]*)/);
    if (m && !declarations.has(m[2])) declarations.set(m[2], { file, index, kind: m[1] });
  });
});

const HOST_GLOBALS = new Set(["window", "document", "fetch", "Notification", "ResizeObserver", "IntersectionObserver"]);

const STANDALONE = new Set(["00-diff-layers.js"]);

function guards() {
  const found = [];
  for (const file of order) {
    sources.get(file).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[=!]==?\s*['"](function|undefined)['"]/g)) {
        found.push({ at: `${file}:${i + 1}`, name: m[1], expects: m[2] });
      }
    });
  }
  return found;
}

test("every name a viewer slice guards with typeof actually exists", () => {
  for (const guard of guards()) {
    assert.ok(
      declarations.has(guard.name) || HOST_GLOBALS.has(guard.name),
      `${guard.at}: nothing declares ${guard.name} — the guard is silently skipping this call`,
    );
  }
});

test("a function the bundle declares is never guarded — it is always there", () => {
  const dead = guards().filter((g) =>
    g.expects === "function" && declarations.get(g.name)?.kind === "function" && !STANDALONE.has(g.at.split(":")[0]));
  assert.deepEqual(
    dead.map((g) => `${g.at} ${g.name}`),
    [],
    "the slices are one script: function declarations hoist, so these guards can only ever hide a rename",
  );
});

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("no slice reads a let/const declared by a later slice", () => {
  const late = [];
  order.forEach((file, index) => {
    const text = withoutComments(sources.get(file));
    for (const [name, declaration] of declarations) {
      if (declaration.index <= index || declaration.kind === "function" || declaration.kind === "var") continue;
      if (new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text)) {
        late.push(`${file} reads ${name} (${declaration.kind}, declared in ${declaration.file})`);
      }
    }
  });
  assert.deepEqual(late, [], "a let/const read before its slice loads throws — reorder the slice or make it a var");
});

test("sourceByPath is only ever rebuilt by rebuildSourceByPath()", () => {
  const writes = order.flatMap((file) => sources.get(file).split("\n")
    .map((text, i) => ({ at: `${file}:${i + 1}`, text: text.trim() }))
    .filter(({ text }) => /\bsourceByPath = /.test(text) && !text.startsWith("//"))
    .map(({ at, text }) => `${at}  ${text.slice(0, 96)}`));
  assert.ok(writes.length >= 3, "the three known writes are still there, so this rule is still looking at something");
  assert.deepEqual(
    writes.filter((w) => !/= rebuildSourceByPath\(/.test(w)),
    [],
    "a rebuild that skips the helper drops every open library file:\n  " + writes.join("\n  "),
  );
});

test("a fact the whole viewer asks about has exactly one reader", () => {
  const sitesOf = (re, skip = []) => order.flatMap((file) => sources.get(file).split("\n")
    .map((text, i) => ({ at: `${file}:${i + 1}`, text: text.trim() }))
    .filter(({ text }) => re.test(text) && !/^(\/\/|\*|\/\*)/.test(text) && !skip.some((s) => s.test(text)))
    .map(({ at, text }) => `${at}  ${text.slice(0, 96)}`));

  const problems = [];
  const only = (what, owner, sites) => {
    if (sites.length !== 1) problems.push(`${what} must be read only by ${owner}, found ${sites.length}:\n    ` + sites.join("\n    "));
  };

  only("the source view's openPath", "sourceOpenPath()",
    sitesOf(/dataset\.openPath/, [/dataset\.openPath\s*=[^=]/, /review-meta/]));

  only("the Quick Open active-row clamp", "clampQuickActive()",
    sitesOf(/quickActive = Math\.min\(quickActive, Math\.max/));
  only("the Quick Open empty state", "showQuickEmpty()",
    sitesOf(/quickResults\.innerHTML = '<div class="quick-open-empty"/));
  only("the Quick Open loading state", "showQuickLoading()",
    sitesOf(/quickResults\.innerHTML = loadingStateHtml\(/));
  only("the Quick Open filter chip", "setQuickFilterChip()",
    sitesOf(/quickFilterEl\.innerHTML =/));

  only("the selected-comment-box key contract", "handleSelectedCommentRowKey()",
    sitesOf(/deleteCommentsInRow\(selectedCommentRow\)/));

  only("the usage occurrence scan", "scanUsageLine()",
    sitesOf(/match\.index \+ match\[0\]\.length - match\[1\]\.length/));

  only("the library-miss message", "reportLibraryMiss()", sitesOf(/source\.libraryUnavailable/));
  only("the web library handoff", "openLibraryOnWeb()", sitesOf(/window\.open\(/));

  only("the speed-search match rule", "matchesQueryVariants()",
    sitesOf(/minusculeMatchesQuery\(/, [/^function minusculeMatchesQuery/]));

  only("what a token kind looks like", "semanticTokenSpanClass()", sitesOf(/semanticTokenClasses\(\)\[/));
  only("whether a file may be painted from the server's answer", "semanticTokensForFile()",
    sitesOf(/semanticTokensFor\(/, [/function semanticTokensFor/, /semanticTokensForFile\(/]));

  assert.deepEqual(problems, [], "a fact grew a second reader:\n  " + problems.join("\n  "));
});

test("a column is mapped into a rendered line through one walker, which knows what nobody typed", () => {
  const walkers = [];
  for (const file of order) {
    sources.get(file).split("\n").forEach((line, i) => {
      if (/createTreeWalker\s*\([^)]*SHOW_TEXT/.test(line)) walkers.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(walkers, ["10-source-view.js:1144"],
    "sourceTextWalker is the only text walker: it rejects .inlay-hint and .mc-code-fold-button, "
    + "and a second walker counts that text as the line's own — which is how ⌘→ painted the caret "
    + "nine characters short of the end. Move the line number here when the function moves.");
});
