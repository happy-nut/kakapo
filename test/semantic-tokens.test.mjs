import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEMANTIC_TOKEN_MODIFIERS } from "../dist/lsp.js";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
const slice = readFileSync(new URL("../src/viewer/10-source-view.js", import.meta.url), "utf8");
const legends = JSON.parse(readFileSync(new URL("./fixtures/semantic-legends.json", import.meta.url), "utf8"));

// A server's legend is the whole vocabulary it can ever send. A name the paint table has no row for is a
// token the source view throws away, and the suite cannot see it happen: the renderer simply emits no
// span and the word takes the line's plain colour. `member` was lost that way for as long as the table
// existed — typescript-language-server's name for a method, and nobody wrote it down.
//
// Refresh the legends with `node scripts/semantic-legends.mjs` (it starts each bundled server and asks).
function paintTable() {
  const at = slice.indexOf("function semanticTokenClasses(");
  assert.ok(at >= 0, "the paint table is still one lazy builder in the source-view slice");
  const body = slice.slice(at, slice.indexOf("\n}", at));
  const rows = [...body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*'([^']*)'/g)]
    .map((m) => [m[1] ?? m[2], m[3]]);
  assert.ok(rows.length > 30, `only ${rows.length} rows parsed — did the table change shape?`);
  return new Map(rows);
}

// Rows deliberately left plain, with the reason. IntelliJ has a colour key for each of these and paints
// it the editor's default foreground in every scheme it ships, so a colour here would be kakapo inventing
// a distinction the IDE it is measured against does not make.
const PLAIN_ON_PURPOSE = {
  angle: "IntelliJ DEFAULT_BRACES — punctuation is default foreground",
  attributeBracket: "IntelliJ DEFAULT_BRACKETS — punctuation is default foreground",
  brace: "IntelliJ DEFAULT_BRACES — punctuation is default foreground",
  bracket: "IntelliJ DEFAULT_BRACKETS — punctuation is default foreground",
  colon: "IntelliJ DEFAULT_SEMICOLON family — punctuation is default foreground",
  comma: "IntelliJ DEFAULT_COMMA — Darcula paints it the keyword colour, the Default scheme does not",
  dot: "IntelliJ DEFAULT_DOT — punctuation is default foreground",
  parenthesis: "IntelliJ DEFAULT_PARENTHS — punctuation is default foreground",
  punctuation: "IntelliJ DEFAULT_BRACES family — punctuation is default foreground",
  semicolon: "IntelliJ DEFAULT_SEMICOLON — Darcula paints it the keyword colour, the Default scheme does not",
  operator: "IntelliJ DEFAULT_OPERATION_SIGN — operators are default foreground",
  arithmetic: "a rust-analyzer split of DEFAULT_OPERATION_SIGN",
  bitwise: "a rust-analyzer split of DEFAULT_OPERATION_SIGN",
  comparison: "a rust-analyzer split of DEFAULT_OPERATION_SIGN",
  logical: "a rust-analyzer split of DEFAULT_OPERATION_SIGN",
  negation: "a rust-analyzer split of DEFAULT_OPERATION_SIGN",
};

test("every name a bundled server's legend carries has a row in the paint table", () => {
  const table = paintTable();
  const servers = Object.entries(legends).filter(([, v]) => Array.isArray(v.tokenTypes));
  assert.ok(servers.length >= 4, `only ${servers.length} legends captured — rerun scripts/semantic-legends.mjs`);

  const missing = [];
  let checked = 0;
  for (const [family, legend] of servers) {
    for (const type of new Set(legend.tokenTypes)) {
      checked += 1;
      if (!table.has(type)) missing.push(`${family}: ${type}`);
    }
  }
  assert.ok(checked >= 80, `the sweep covered the legends (checked ${checked} names)`);
  assert.deepEqual(missing, [],
    "these arrive from a server and the source view has no row for them, so they paint as plain text");
});

test("a row left plain says why, and no row is plain without a reason", () => {
  const table = paintTable();
  const unexplained = [];
  for (const [type, className] of table) {
    if (className !== "" ) continue;
    if (!PLAIN_ON_PURPOSE[type]) unexplained.push(type);
  }
  assert.deepEqual(unexplained, [], "add these to PLAIN_ON_PURPOSE with the reason, or give them a class");
  const stale = Object.keys(PLAIN_ON_PURPOSE).filter((type) => table.get(type) !== "");
  assert.deepEqual(stale, [], "these are listed as deliberately plain but the table now paints them");
});

test("every class the table names has a colour rule of its own", () => {
  const table = paintTable();
  const classes = new Set([...table.values()].filter(Boolean));
  assert.ok(classes.size >= 20, `only ${classes.size} distinct classes — the table collapsed`);
  const unpainted = [...classes].filter((name) => !new RegExp(`^\\.${name}\\b[^{]*\\{[^}]*color\\s*:`, "m").test(css));
  assert.deepEqual(unpainted, [], "a class with no colour rule inherits the line's plain colour");
});

// Two classes that resolve to the same colour AND the same weight, slant and decoration are one colour on
// screen whatever the table says. This is the check the palette failed before this work: the default dark
// theme gave --token-number and --token-literal the same hex, so a number and a boolean were one colour.
function customPropertyBlocks() {
  const out = [];
  const re = /^(:root(?:\[[^\]]+\])*)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = re.exec(css))) {
    const vars = {};
    for (const line of match[2].split("\n")) {
      const declaration = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
      if (declaration) vars[declaration[1]] = declaration[2].trim();
    }
    if (Object.keys(vars).length) out.push({ selector: match[1], vars });
  }
  return out;
}

function themeBlocks() {
  const blocks = customPropertyBlocks();
  return blocks.filter((b) => Object.keys(b.vars).some((n) => n.startsWith("--token-")));
}

test("each theme block gives every --token- slot it declares a colour no other slot there has", () => {
  const blocks = themeBlocks();
  assert.equal(blocks.length, 12, `all twelve syntax palettes are checked (found ${blocks.length})`);

  const collisions = [];
  for (const block of blocks) {
    const slots = Object.entries(block.vars).filter(([name]) => name.startsWith("--token-"));
    const byColour = new Map();
    for (const [name, value] of slots) {
      const key = value.toLowerCase();
      if (!byColour.has(key)) byColour.set(key, []);
      byColour.get(key).push(name);
    }
    for (const [colour, names] of byColour) {
      if (names.length > 1) collisions.push(`${block.selector}: ${names.join(" = ")} are all ${colour}`);
    }
  }
  assert.deepEqual(collisions, [],
    "two slots with one colour means a distinction the table makes cannot be seen on screen");
});

test("every theme declares the same slots, so no theme silently falls back", () => {
  const blocks = themeBlocks();
  const names = blocks.map((b) => new Set(Object.keys(b.vars).filter((n) => n.startsWith("--token-"))));
  const union = new Set(names.flatMap((s) => [...s]));
  const gaps = [];
  blocks.forEach((block, i) => {
    for (const slot of union) if (!names[i].has(slot)) gaps.push(`${block.selector} is missing ${slot}`);
  });
  assert.deepEqual(gaps, [], "a theme without the slot inherits the default theme's colour for it");
});

test("no two token classes render the same colour, weight, slant and decoration", () => {
  const table = paintTable();
  const classes = [...new Set([...table.values()].filter(Boolean))];
  const look = new Map();
  for (const name of classes) {
    const rule = new RegExp(`^\\.${name}\\s*\\{([^}]*)\\}`, "m").exec(css);
    assert.ok(rule, `${name} has a rule of its own`);
    const body = rule[1];
    const pick = (property) => (new RegExp(`${property}\\s*:\\s*([^;]+)`).exec(body)?.[1] ?? "").trim();
    look.set(name, [
      pick("color"), pick("font-weight") || "normal",
      pick("font-style") || "normal", pick("text-decoration") || "none",
    ].join(" | "));
  }
  const byLook = new Map();
  for (const [name, signature] of look) {
    if (!byLook.has(signature)) byLook.set(signature, []);
    byLook.get(signature).push(name);
  }
  const twins = [...byLook.entries()].filter(([, names]) => names.length > 1)
    .map(([signature, names]) => `${names.join(" = ")} → ${signature}`);
  assert.deepEqual(twins, [], "these classes are one appearance; give one of them a slot or a slant of its own");
});

// A modifier the renderer styles but no server ever sends is dead code that reads as a shipped feature;
// `modification` was in the table that way, a standard LSP name none of the bundled servers uses. The
// other direction is bounded to the standard names on purpose: a server's own extras (gopls's `chan`,
// rust-analyzer's `crateRoot`) are language trivia, not distinctions a reader needs painted.
const MODIFIER_PLAIN_ON_PURPOSE = {
  readonly: "IntelliJ's shipped schemes give INSTANCE_FINAL_FIELD no device of its own",
  declaration: "IntelliJ bolds METHOD_DECLARATION only; bold already means method here",
  definition: "the same distinction as declaration, under gopls's name for it",
  async: "IntelliJ has no key for it",
  abstract: "IntelliJ italicises ABSTRACT_CLASS, and italic already means static here",
  defaultLibrary: "IntelliJ's PREDEFINED_SYMBOL is a colour, and the slot budget is spent",
  modification: "no bundled server sends it",
  deprecated: null,
  static: null,
  documentation: null,
};

function modifierTable() {
  const at = slice.indexOf("function semanticModifierClasses(");
  assert.ok(at >= 0, "the modifier table is still one lazy builder in the source-view slice");
  const body = slice.slice(at, slice.indexOf("\n}", at));
  return new Map([...body.matchAll(/([A-Za-z_$][\w$]*):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
}

test("every modifier the renderer styles is one a bundled server actually sends", () => {
  const table = modifierTable();
  assert.ok(table.size >= 2, `only ${table.size} modifier rows — did the table move?`);
  const sent = new Set(Object.values(legends).flatMap((v) => v.tokenModifiers ?? []));
  assert.ok(sent.size >= 20, `the captured legends carry the modifier vocabulary (found ${sent.size})`);
  const dead = [...table.keys()].filter((name) => !sent.has(name));
  assert.deepEqual(dead, [], "these are styled but no captured legend has them, so the rule never fires");
});

test("every standard modifier is either styled or listed with the reason it is not", () => {
  const table = modifierTable();
  const undecided = SEMANTIC_TOKEN_MODIFIERS
    .filter((name) => !table.has(name) && !MODIFIER_PLAIN_ON_PURPOSE[name]);
  assert.deepEqual(undecided, [], "give these a tokmod- class or a reason in MODIFIER_PLAIN_ON_PURPOSE");
  const contradictory = [...table.keys()].filter((name) => MODIFIER_PLAIN_ON_PURPOSE[name]);
  assert.deepEqual(contradictory, [], "these are styled and also listed as deliberately unstyled");
});

test("every tokmod- class the table names has a rule that changes how the word looks", () => {
  const classes = new Set(modifierTable().values());
  const inert = [...classes].filter((name) => {
    const rule = new RegExp(`^\\.${name}\\s*\\{([^}]*)\\}`, "m").exec(css);
    return !rule || !/font-style|font-weight|text-decoration|color/.test(rule[1]);
  });
  assert.deepEqual(inert, [], "a modifier class with no visual rule is a class nobody can see");
});
