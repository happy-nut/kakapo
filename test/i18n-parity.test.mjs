import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES } from "../dist/i18n.js";

test("every locale carries exactly the same keys", () => {
  const locales = Object.keys(MESSAGES);
  assert.ok(locales.length >= 2, `there is more than one locale to compare (got ${locales.join(", ")})`);
  const [reference, ...others] = locales;
  const referenceKeys = Object.keys(MESSAGES[reference]).sort();

  for (const locale of others) {
    const keys = Object.keys(MESSAGES[locale]).sort();
    const missing = referenceKeys.filter((key) => !(key in MESSAGES[locale]));
    const extra = keys.filter((key) => !(key in MESSAGES[reference]));
    assert.deepEqual(missing, [], `${locale} is missing keys present in ${reference}`);
    assert.deepEqual(extra, [], `${locale} has keys ${reference} does not`);
  }
});

test("no message is left empty or still holding its placeholder", () => {
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, "string", `${locale}.${key} is a string`);
      assert.notEqual(value.trim(), "", `${locale}.${key} says something`);
      assert.doesNotMatch(value, /^TODO\b|^FIXME\b/i, `${locale}.${key} is translated, not a placeholder`);
    }
  }
});

test("every locale interpolates the same placeholders", () => {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const [reference, ...others] = Object.keys(MESSAGES);
  for (const [key, value] of Object.entries(MESSAGES[reference])) {
    const want = placeholders(value);
    for (const locale of others) {
      const got = placeholders(MESSAGES[locale][key] ?? "");
      assert.deepEqual(got, want, `${locale}.${key} interpolates the same names as ${reference}.${key}`);
    }
  }
});

test("no title string spells its own chord — applyKeyHints appends it", async () => {
  const { readFileSync } = await import("node:fs");
  const sources = ["../src/render.ts", "../src/viewer/03-quick-open.js", "../src/viewer/07-comments.js",
    "../src/viewer/08-dock.js", "../src/viewer/10-source-view.js", "../src/viewer/11-render-http.js",
    "../src/viewer/12-history.js"]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8")).join("\n");
  const keys = new Set([...sources.matchAll(/data-i18n-title="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(keys.size >= 10, `found the title keys to check (got ${keys.size})`);

  const spellsAChord = /[(（]\s*(?:F\d{1,2}|Esc|Enter|Return|Tab|Space|Backspace|Delete|Shift|Ctrl|Alt|Opt|Option|Cmd|Command|Meta|⌘|⌥|⇧|⌃|↵|↑|↓|←|→)[^)）]{0,20}[)）]\s*$/;
  const doubled = [];
  for (const key of keys) {
    for (const [locale, table] of Object.entries(MESSAGES)) {
      const value = table[key];
      if (typeof value === "string" && spellsAChord.test(value)) doubled.push(`${locale} ${key} = ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(doubled, [], `these tooltips print their chord twice:\n  ${doubled.join("\n  ")}`);
});

const COUNT_PLACEHOLDERS = ["n", "count", "errors", "files", "failed", "writes", "i", "w", "done", "total"];

test("no call site substitutes a count by hand", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)),
    ...readdirSync(join(dir, "viewer")).filter((f) => f.endsWith(".js")).map((f) => join(dir, "viewer", f))]
    .filter((f) => !f.endsWith("i18n.ts"));
  const names = COUNT_PLACEHOLDERS.join("|");
  const byHand = new RegExp(`\\.replace\\(\\s*["']\\{(?:${names})\\}["']`);
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
      if (byHand.test(line)) offenders.push(`${file.slice(dir.length)}:${index + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `pass the count to t() instead:\n  ${offenders.join("\n  ")}`);
});

const COUNT_NEEDS_NO_PLURAL = {
  "update.downloading": "a percentage",
  "analysis.elapsed": "a unit abbreviation — 1s, 4s",
  "analysis.generation": "an identifier, not a quantity",
  "coach.nudgeCount": "a ratio — 1/3",
  "findusages.occurrence": "an ordinal — 3 of 12",
  "vision.more": "+1 more: the noun is the row above",
  "compare.andMore": "+1 more: the noun is the row above",
  "findusages.testCount": "1 in tests: the noun is the summary this appends to",
  "findusages.inFile": "1 in this file, 0 written: the noun is the symbol named first",
  "problems.unavailable": "1 not checked: the noun is the file count beside it",
  "diag.noneChanged": "lists all 1 in this file: the noun is in the clause before",
  "merged.copiedAndArchived": "1 archived: the noun is the comment the toast follows",
  "http.collection": "a collection of 1: the noun is the collection",
  "diff.skippedViewed": "a sibling key, diff.skippedViewedOne, carries the singular sentence",
  "problems.scanning": "1 of 272: a progress ratio",
};

test("every counting sentence either writes both forms or says why it needs one", () => {
  const english = MESSAGES.en;
  const counts = new RegExp(`\\{(?:${COUNT_PLACEHOLDERS.join("|")})\\}`);
  const unguarded = [];
  for (const [key, value] of Object.entries(english)) {
    if (!counts.test(value)) continue;
    if (/\{\{\w+:[^|{}]*\|[^{}]*\}\}/.test(value)) continue;
    if (key in COUNT_NEEDS_NO_PLURAL) continue;
    unguarded.push(`${key} = ${JSON.stringify(value)}`);
  }
  assert.deepEqual(unguarded, [],
    `write both forms — "{n} {{n:file|files}}" — or add the key to COUNT_NEEDS_NO_PLURAL with its reason:\n  ${unguarded.join("\n  ")}`);

  const stale = Object.keys(COUNT_NEEDS_NO_PLURAL).filter((key) => {
    const value = english[key];
    return value === undefined || !counts.test(value) || /\{\{\w+:/.test(value);
  });
  assert.deepEqual(stale, [], "these exemptions no longer describe their string");
  for (const [key, why] of Object.entries(COUNT_NEEDS_NO_PLURAL)) {
    assert.ok(why && why.length > 8, `${key}'s exemption says why`);
  }
});

test("no string with a plural token is read without its count", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = new URL("../src/", import.meta.url).pathname;
  const sources = [...readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "i18n.ts").map((f) => join(dir, f)),
    ...readdirSync(join(dir, "viewer")).filter((f) => f.endsWith(".js")).map((f) => join(dir, "viewer", f))]
    .map((f) => [f.slice(dir.length), readFileSync(f, "utf8")]);

  const withToken = new Set();
  for (const messages of Object.values(MESSAGES)) {
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value === "string" && /\{\{\w+:[^|{}]*\|[^{}]*\}\}/.test(value)) withToken.add(key);
    }
  }
  assert.ok(withToken.size > 0, "the token is in use at all — otherwise this guard is vacuous");

  const bare = [];
  for (const key of withToken) {
    const quoted = key.replace(/\./g, "\\.");
    const noValues = new RegExp(`\\bt\\(\\s*['"]${quoted}['"]\\s*\\)`);
    for (const [name, source] of sources) if (noValues.test(source)) bare.push(`${name}: t('${key}')`);
  }
  assert.deepEqual(bare, [], "these reads would render the raw {{one|many}} token");

  const markup = ["../src/render.ts", "../src/render-tree.ts"]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8")).join("\n");
  const attributes = ["data-i18n", "data-i18n-title", "data-i18n-aria", "data-i18n-ph"];
  const painted = [...withToken].filter((key) => attributes.some((attr) => markup.includes(`${attr}="${key}"`)));
  assert.deepEqual(painted, [], "a counting string cannot be painted by applyI18n, which has no count to pass");
});

test("a plural token means the same thing in every locale that has the key", () => {
  const forms = (value) => [...String(value).matchAll(/\{\{(\w+):/g)].map((m) => m[1]).sort();
  const [reference, ...others] = Object.keys(MESSAGES);
  for (const locale of others) {
    for (const [key, value] of Object.entries(MESSAGES[reference])) {
      const mine = forms(value);
      const theirs = forms(MESSAGES[locale][key] ?? "");
      const extra = theirs.filter((f) => !mine.includes(f));
      assert.deepEqual(extra, [], `${locale}.${key} pluralizes a count ${reference} does not`);
    }
  }
});
