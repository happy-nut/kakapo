import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import hljs from "highlight.js";
import { languageForPath } from "../dist/util.js";

// languageForPath is the one entry both highlighters ask (highlight.js for the diff, the hand-written
// tokenizer for the source view), so a name it returns that highlight.js does not know turns the diff's
// colouring off silently — hljsLanguageForPath answers "" and the file renders flat. Groovy was worse than
// that: the extension was absent, so BOTH views fell back to plain text on every .gradle file in the repo.
//
// The corpus is read out of the source rather than listed here, so a row added to either table is covered
// the moment it is written and a typo in it fails this file instead of going quiet in the app.
const util = readFileSync(new URL("../src/util.ts", import.meta.url), "utf8");

const EXTENSIONS = [...new Set([
  ...[...util.matchAll(/lower\.endsWith\("\.([a-z0-9]+)"\)/g)].map((m) => m[1]),
  ...[...util.matchAll(/\["([a-z0-9]+)", "([a-z]+)"\]/g)].map((m) => m[1]),
])];
const FILENAMES = [...util.matchAll(/\["((?:makefile|gnumakefile|dockerfile|containerfile))", "([a-z]+)"\]/g)]
  .map((m) => m[1]);

// The two names that are kakapo's own, not highlight.js's: `markup` is mapped to xml at the call site and
// `text` means "do not highlight".
const INTERNAL = new Set(["markup", "text"]);

test("the language map reads a real corpus", () => {
  assert.ok(EXTENSIONS.length > 60, `only ${EXTENSIONS.length} extensions found — did the tables move?`);
  assert.ok(EXTENSIONS.includes("gradle"), "the .gradle row that started this is missing");
  assert.equal(FILENAMES.length, 4);
});

test("every language languageForPath returns is one highlight.js actually has", () => {
  const dead = [];
  for (const ext of EXTENSIONS) {
    const language = languageForPath(`a/b/file.${ext}`);
    if (INTERNAL.has(language)) continue;
    if (!hljs.getLanguage(language)) dead.push(`.${ext} -> ${language}`);
  }
  for (const name of FILENAMES) {
    const language = languageForPath(`a/b/${name}`);
    if (INTERNAL.has(language)) continue;
    if (!hljs.getLanguage(language)) dead.push(`${name} -> ${language}`);
  }
  assert.deepEqual(dead, [], "these resolve to a grammar highlight.js does not ship, so the diff goes flat");
});

test("a filename-declared language is read from the name, at any depth and in any case", () => {
  assert.equal(languageForPath("Makefile"), "makefile");
  assert.equal(languageForPath("build/sub/GNUmakefile"), "makefile");
  assert.equal(languageForPath("docker/Dockerfile"), "dockerfile");
  assert.equal(languageForPath("Containerfile"), "dockerfile");
  // An extension still wins over a name that merely contains one of these.
  assert.equal(languageForPath("Dockerfile.md"), "markdown");
});

test("every non-// language has a comment style for the source view", () => {
  // The generic tokenizer assumes `//`. A `#`-comment language left on that default paints its comment
  // lines as code — worse than the plain text the row replaced — so each one needs a prefix row, and the
  // ones genuinely on `//` are named here so adding a language forces a decision either way.
  const slice = readFileSync(new URL("../src/viewer/11-render-http.js", import.meta.url), "utf8");
  const table = slice.slice(slice.indexOf("function lineCommentPrefixes("));
  const declared = new Set([...table.slice(0, table.indexOf("};")).matchAll(/(\w+):\s*\[/g)].map((m) => m[1]));
  assert.ok(declared.size > 20, `only ${declared.size} comment rows found — did the table move?`);

  const SLASHES = new Set([
    "typescript", "javascript", "json", "css", "markdown", "php", "go", "rust", "java", "kotlin",
    "groovy", "c", "cpp", "csharp", "swift", "scala", "dart", "objectivec", "protobuf", "fsharp",
    "verilog", "ocaml", // ocaml has only (* *); the default is deliberate, see the table's comment
  ]);

  const undecided = [];
  for (const ext of [...EXTENSIONS, ...FILENAMES]) {
    const language = languageForPath(ext.includes("file") ? ext : `f.${ext}`);
    if (INTERNAL.has(language)) continue;
    if (!declared.has(language) && !SLASHES.has(language)) undecided.push(`${ext} -> ${language}`);
  }
  assert.deepEqual(undecided, [], "give these a LINE_COMMENT_PREFIXES row or add them to SLASHES");
});

// A grammar can be reachable and still invisible. languageForPath answers "markdown", hljs tokenizes the
// file, the diff carries the spans — and it still reads as flat prose, because the theme maps hljs's class
// names onto its own --token-* palette BY HAND and a class nobody wrote a row for inherits the line's
// plain colour. That is exactly what happened to `inline code`: markdown emits almost nothing else, so a
// .md diff held 25 hljs-code spans and not one other token, every one of them the same grey as the prose
// around it. Ask hljs which classes a markdown document produces instead of listing them here, so a
// grammar change cannot quietly add a colourless one.
test("every class a markdown file paints with has a colour in the theme", () => {
  const css = readFileSync(new URL("../dist/viewer.css", import.meta.url), "utf8");
  const styled = new Set([...css.matchAll(/\.(hljs-[a-z_-]+)/g)].map((m) => m[1]));

  // The diff highlights one line at a time (highlightSideLines), so the sample is read that way too.
  const sample = [
    "# Heading", "## Sub heading", "Prose with \`inline code\`, **bold** and *emphasis*.",
    "- a bullet", "1. an ordered item", "> a quote",
    "[a link](http://example.com)", "\`\`\`js", "const a = 1;", "\`\`\`", "    indented code", "---",
  ];
  const emitted = new Set();
  for (const line of sample) {
    const html = hljs.highlight(line, { language: "markdown", ignoreIllegals: true }).value;
    for (const m of html.matchAll(/class="(hljs-[a-z_-]+)"/g)) emitted.add(m[1]);
  }

  // Guard the guard: a sample that stopped producing the token this test was written for would pass by
  // saying nothing at all.
  assert.ok(emitted.has("hljs-code"), "the sample no longer exercises markdown's code token");
  assert.ok(emitted.size >= 5, `only ${emitted.size} markdown token classes — did the sample go stale?`);

  const colourless = [...emitted].filter((c) => !styled.has(c)).sort();
  assert.deepEqual(colourless, [], "give these a row in viewer.css's hljs -> --token-* mapping");
});
