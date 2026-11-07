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

// A grammar can be reachable and still invisible. languageForPath answers a name, hljs tokenizes the file,
// the diff carries the spans — and it still reads as flat text, because the theme maps hljs's class names
// onto the app's own --token-* palette BY HAND and a class nobody wrote a row for inherits the line's plain
// colour. `inline code` was the whole of markdown's vocabulary that way: a .md diff held 25 hljs-code spans
// and not one other token, every one the same grey as the prose around it.
//
// Rather than sample files, ask each grammar what it CAN emit — a sample only proves what it happened to
// contain. hljs renders a scope "a.b_" as class="hljs-a b_", so the first segment decides the colour, and
// `className: ""` is hljs's way of saying "no scope", which emits no class at all.
const PLAIN_ON_PURPOSE = new Set([
  // Identifiers and brackets. The source view's tokenizer paints neither, so plain is the answer that keeps
  // the two surfaces agreeing — and a palette entry for "every parameter name" would colour most of a file.
  "hljs-params", "hljs-punctuation", "hljs-operator",
  // The code inside a string interpolation. It sits INSIDE hljs-string, so with no row of its own it
  // inherits the string colour — which is exactly what the source view does with `${...}` too.
  "hljs-subst",
  // f#-only, and not a role this palette has.
  "hljs-computation-expression",
]);

function emittableClasses(name, seen = new Set()) {
  const out = new Set();
  const lang = hljs.getLanguage(name);
  if (!lang) return out;
  const add = (scope) => { const first = String(scope).split(".")[0]; if (first) out.add("hljs-" + first); };
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    for (const key of ["scope", "className"]) if (typeof node[key] === "string") add(node[key]);
    for (const key of ["beginScope", "endScope"]) {
      const v = node[key];
      if (typeof v === "string") add(v);
      else if (v && typeof v === "object") Object.values(v).forEach((x) => typeof x === "string" && add(x));
    }
    if (typeof node.subLanguage === "string" && !seen.has(node.subLanguage)) {
      seen.add(node.subLanguage);
      emittableClasses(node.subLanguage, seen).forEach((c) => out.add(c));
    }
    for (const key of ["contains", "variants", "starts", "keywords", "cases"]) {
      if (node[key] && typeof node[key] === "object") walk(node[key], depth + 1);
    }
  };
  walk(lang, 0);
  return out;
}

test("every token class the mapped grammars can emit has a colour, or is plain on purpose", () => {
  const css = readFileSync(new URL("../dist/viewer.css", import.meta.url), "utf8");
  const styled = new Set([...css.matchAll(/\.(hljs-[a-z_-]+)/g)].map((m) => m[1]));

  const names = new Set();
  for (const ext of [...EXTENSIONS, ...FILENAMES]) {
    const language = languageForPath(ext.includes("file") ? ext : `f.${ext}`);
    names.add(language === "markup" ? "xml" : language);
  }
  names.delete("text");

  const all = new Set();
  for (const name of names) emittableClasses(name).forEach((c) => all.add(c));

  // Guard the guard: a walk that stopped reaching into the grammars would report nothing missing and pass.
  assert.ok(all.size > 20, `the grammar walk found only ${all.size} classes — did hljs change shape?`);
  assert.ok(all.has("hljs-code") && all.has("hljs-selector-class"),
    "the walk no longer reaches the classes it was written for");

  const colourless = [...all].filter((c) => !styled.has(c) && !PLAIN_ON_PURPOSE.has(c)).sort();
  assert.deepEqual(colourless, [],
    "give these a row in viewer.css's hljs -> --token-* mapping, or a reason in PLAIN_ON_PURPOSE");
});

// A grammar can also be the WRONG one and still look like a mapping. highlight.js has both `bash` (the
// script) and `shell` (Shell SESSION — a pasted transcript, where the only thing it colours is the prompt
// in front of a command). `.sh` asked for `shell`, so every shell script in a diff came back with zero
// tokens: not a missing colour, nothing to colour. A name being a real hljs language is not enough; it has
// to have something to say about the file.
test("a shell script gets a grammar that actually tokenizes a script", () => {
  assert.equal(languageForPath("scripts/run.sh"), "bash");
  const line = 'if [ -f x ]; then echo "hi"; fi';
  const tokens = (name) => [...hljs.highlight(line, { language: name, ignoreIllegals: true }).value
    .matchAll(/class="hljs-[a-z_-]+/g)].length;
  assert.equal(tokens("shell"), 0, "the control: Shell Session still says nothing about a script");
  assert.ok(tokens(languageForPath("run.sh")) >= 3,
    "the mapped grammar must colour a script, not just a transcript's prompt");
});
