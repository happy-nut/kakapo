import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
const slice = readFileSync(new URL("../src/viewer/10-source-view.js", import.meta.url), "utf8");
const schemes = JSON.parse(readFileSync(new URL("./fixtures/intellij-schemes.json", import.meta.url), "utf8"));

function tableIn(name) {
  const at = slice.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is still one lazy builder in the source-view slice`);
  const body = slice.slice(at, slice.indexOf("\n}", at));
  return new Map([...body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*'([^']*)'/g)]
    .map((m) => [m[1] ?? m[2], m[3]]));
}

function kakapoClasses() {
  const out = new Set();
  for (const value of tableIn("semanticTokenClasses").values()) {
    for (const name of value.split(/\s+/)) if (name) out.add(name);
  }
  for (const value of tableIn("semanticModifierClasses").values()) out.add(value);
  return out;
}

const MATCHED = {
  DEFAULT_KEYWORD: "tok-keyword",
  DEFAULT_NUMBER: "tok-number",
  DEFAULT_STRING: "tok-string",
  DEFAULT_VALID_STRING_ESCAPE: "tok-escape",
  DEFAULT_INVALID_STRING_ESCAPE: "tok-error",
  DEFAULT_LINE_COMMENT: "tok-comment",
  DEFAULT_BLOCK_COMMENT: "tok-comment",
  DEFAULT_DOC_COMMENT: "tokmod-documentation",
  DEFAULT_CLASS_REFERENCE: "tok-type",
  DEFAULT_INSTANCE_FIELD: "tok-property",
  DEFAULT_STATIC_FIELD: "tokmod-static",
  DEFAULT_STATIC_METHOD: "tokmod-static",
  STATIC_METHOD_ATTRIBUTES: "tokmod-static",
  DEFAULT_CONSTANT: "tok-constant",
  DEFAULT_FUNCTION_DECLARATION: "tok-function",
  DEFAULT_FUNCTION_CALL: "tok-function",
  DEFAULT_IDENTIFIER: "tok-variable",
  DEFAULT_METADATA: "tok-decorator",
  ANNOTATION_NAME_ATTRIBUTES: "tok-decorator",
  TYPE_PARAMETER_NAME_ATTRIBUTES: "tok-typeparam",
  DEFAULT_LABEL: "tok-label",
};

const UNMATCHED = {
  DEFAULT_BRACES: "every shipped scheme paints it the editor's default foreground",
  DEFAULT_BRACKETS: "every shipped scheme paints it the editor's default foreground",
  DEFAULT_PARENTHS: "every shipped scheme paints it the editor's default foreground",
  DEFAULT_DOT: "every shipped scheme paints it the editor's default foreground",
  DEFAULT_OPERATION_SIGN: "every shipped scheme paints it the editor's default foreground",
  DEFAULT_COMMA: "the two shipped schemes disagree: Darcula paints it the keyword colour, Default leaves it plain",
  DEFAULT_SEMICOLON: "the two shipped schemes disagree: Darcula paints it the keyword colour, Default leaves it plain",
  DEFAULT_REASSIGNED_LOCAL_VARIABLE: "it takes dataflow to know, and no semantic token carries it",
  DEFAULT_REASSIGNED_PARAMETER: "it takes dataflow to know, and no semantic token carries it",
  DEFAULT_HIGHLIGHTED_REFERENCE: "a caret-follows decoration, not a property of the token",
  DEFAULT_DOC_COMMENT_TAG: "it lives inside a comment, which servers send as one token",
  DEFAULT_DOC_COMMENT_TAG_VALUE: "it lives inside a comment, which servers send as one token",
  DEFAULT_DOC_MARKUP: "it lives inside a comment, which servers send as one token",
  DEFAULT_TEMPLATE_LANGUAGE_COLOR: "a background wash for an embedded language, not a token colour",
  DEFAULT_PREDEFINED_SYMBOL: "the defaultLibrary modifier reaches kakapo, and the slot budget is spent",
  DEFAULT_TAG: "markup is the lexer's half of the source view, not the server's",
  DEFAULT_ATTRIBUTE: "markup is the lexer's half of the source view, not the server's",
  DEFAULT_ENTITY: "markup is the lexer's half of the source view, not the server's",
};

function platformKeys() {
  const keys = new Set();
  for (const looks of Object.values(schemes)) for (const key of Object.keys(looks)) keys.add(key);
  return [...keys].sort();
}

test("the fixture is the two schemes IntelliJ ships, read out of the IDE", () => {
  assert.deepEqual(Object.keys(schemes).sort(), ["Darcula", "Default"]);
  assert.ok(platformKeys().length >= 35, "the platform vocabulary was captured whole");
  assert.equal(schemes.Darcula.DEFAULT_KEYWORD, "cc7832 / plain / none", "Darcula's keyword is its own orange");
  assert.equal(schemes.Darcula.DEFAULT_STATIC_FIELD, "9876aa / italic / none",
    "a static field is the field colour plus italic — the device, not a colour of its own");
});

test("every colour key IntelliJ's platform declares is either reproduced or refused with a reason", () => {
  const undecided = platformKeys().filter((key) => !MATCHED[key] && !UNMATCHED[key]);
  assert.deepEqual(undecided, [],
    "map these to a kakapo class or say in UNMATCHED what IntelliJ does that kakapo cannot");
  const both = platformKeys().filter((key) => MATCHED[key] && UNMATCHED[key]);
  assert.deepEqual(both, [], "a key is reproduced or refused, not both");
});

test("the class each reproduced key names is one the paint table really hands out", () => {
  const classes = kakapoClasses();
  const missing = Object.entries(MATCHED).filter(([, name]) => !classes.has(name))
    .map(([key, name]) => `${key} -> ${name}`);
  assert.deepEqual(missing, [], "these name a class no token kind is painted with any more");
});

test("the device IntelliJ uses for static is the device kakapo uses", () => {
  const rule = /^\.tokmod-static\s*\{([^}]*)\}/m.exec(css);
  assert.ok(rule, "tokmod-static has a rule");
  assert.match(rule[1], /font-style\s*:\s*italic/,
    "Darcula's STATIC_FIELD and STATIC_METHOD are italic and nothing else, so kakapo's static is italic too");
});

test("a doc comment is told apart from a line comment, as Darcula tells them apart", () => {
  assert.notEqual(schemes.Darcula.DEFAULT_DOC_COMMENT, schemes.Darcula.DEFAULT_LINE_COMMENT,
    "Darcula gives the doc comment a colour and a slant of its own");
  const rule = /^\.tokmod-documentation\s*\{([^}]*)\}/m.exec(css);
  assert.ok(rule, "tokmod-documentation has a rule of its own");
  assert.match(rule[1], /font-style|font-weight|text-decoration|color/, "and that rule changes how it reads");
  const comment = /^\.tok-comment\s*\{([^}]*)\}/m.exec(css);
  assert.ok(comment && css.indexOf(".tokmod-documentation") > css.indexOf(".tok-comment"),
    "and it is declared after .tok-comment, which sets font-style itself");
});
