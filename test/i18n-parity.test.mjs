// The app is fully localized, so a key added to one locale and not the other does not fail anything — it
// just shows English inside a Korean UI, in whichever corner that string lives. Two of this session's own
// changes added keys to both by hand; the next one might not.
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

// A message that interpolates has to interpolate the SAME names in every locale, or one language silently
// renders "{symbol}" to the reader.
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

// applyKeyHints (01-core.js) sets `title = t(key) + " (" + chord + ")"` on every element that carries both
// data-i18n-title and data-keyhint-id — that is the rule AGENTS.md states, so the tooltip says the key the
// table currently holds, including after a rebind. A string that spells the chord as well is therefore
// printed twice. Five of them did:
//
//   "Next change (F7) (F7)"        "다음 변경 (F7) (F7)"
//   "Back to diff (F7) (F7)"       "Diff로 돌아가기 (F7) (F7)"
//   "Close (Esc) (Esc)"            "닫기 (Esc) (Esc)"
//   "Next match (Enter) (↵)"       "다음 결과 (Enter) (↵)"
//   "Previous match (Shift+Enter) (⇧↵)"
//
// The last two also disagreed with the table about how to spell the key — "Shift+Enter" beside "⇧↵" — which
// is the drift applyKeyHints exists to end.
test("no title string spells its own chord — applyKeyHints appends it", async () => {
  const { readFileSync } = await import("node:fs");
  const sources = ["../src/render.ts", "../src/viewer/03-quick-open.js", "../src/viewer/07-comments.js",
    "../src/viewer/08-dock.js", "../src/viewer/10-source-view.js", "../src/viewer/11-render-http.js",
    "../src/viewer/12-history.js"]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8")).join("\n");
  const keys = new Set([...sources.matchAll(/data-i18n-title="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(keys.size >= 10, `found the title keys to check (got ${keys.size})`);

  // A trailing "(…)" opening with a key name: how a chord reads at the end of a label.
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

// Counts are the one thing a message may not interpolate by hand.
//
// `t(key, values)` (01-core.js, and makeTranslator for the main process) substitutes `{name}` AND resolves
// `{{n:one|many}}` from the SAME object, so the noun and the number read one property and cannot disagree.
// A call site that chains `.replace('{n}', …)` onto t() has stepped off that road: it supplies the number
// and nothing supplies the form. That is how "(1 usages)", "1 problems (1 errors) in 1 files" and "Clear 1
// comments in this file" all shipped at once while the catalog's own plural token sat unused two keys away.
//
// Names, symbols and paths are still free to be substituted by hand — a `{symbol}` has no second form to
// get wrong. This bans the names that carry a quantity.
const COUNT_PLACEHOLDERS = ["n", "count", "errors", "files", "failed", "writes", "i", "w", "done", "total"];

test("no call site substitutes a count by hand", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)),
    ...readdirSync(join(dir, "viewer")).filter((f) => f.endsWith(".js")).map((f) => join(dir, "viewer", f))]
    .filter((f) => !f.endsWith("i18n.ts")); // the catalog itself writes the placeholders
  const names = COUNT_PLACEHOLDERS.join("|");
  // `.replace("{n}"` anywhere in the file: these are only ever chained onto a catalog string.
  const byHand = new RegExp(`\\.replace\\(\\s*["']\\{(?:${names})\\}["']`);
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return; // prose about the rule
      if (byHand.test(line)) offenders.push(`${file.slice(dir.length)}:${index + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `pass the count to t() instead:\n  ${offenders.join("\n  ")}`);
});

// Which counting sentences legitimately have no second form. Each one is here because the count does not
// govern a noun in the sentence — a percentage, a unit, a ratio, an identifier, or an ellipsis where the
// noun is left out. Anything else that counts must write both forms, and a NEW counting string fails this
// test until somebody decides which it is. That decision is the whole point: the twelve defects this
// replaced were not arguments anybody lost, they were strings nobody was asked about.
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

  // The exemption list is not a parking space: an entry for a key that no longer counts, or that has since
  // grown its forms, is a stale note that would quietly excuse the next defect in that key.
  const stale = Object.keys(COUNT_NEEDS_NO_PLURAL).filter((key) => {
    const value = english[key];
    return value === undefined || !counts.test(value) || /\{\{\w+:/.test(value);
  });
  assert.deepEqual(stale, [], "these exemptions no longer describe their string");
  for (const [key, why] of Object.entries(COUNT_NEEDS_NO_PLURAL)) {
    assert.ok(why && why.length > 8, `${key}'s exemption says why`);
  }
});

// A string that writes both forms has to be read WITH its count, or the reader sees the raw
// "{{n:usage|usages}}" — worse than the "comment(s)" the token replaced. The previous spelling of this
// guard searched for `plural(t('key')` in src/viewer only, which is why makeTranslator — the application
// menu, the native dialogs, the welcome screen — could print a token untouched the day a menu string grew
// one. Stated as the mistake instead: nobody reads one of these keys with no values at all.
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
    // `t('the.key')` — the call closes with no values. A ternary or a variable key cannot be read here and
    // does not need to be: the only way such a call can supply a number is through the values object,
    // because substituting one by hand is banned above.
    const noValues = new RegExp(`\\bt\\(\\s*['"]${quoted}['"]\\s*\\)`);
    for (const [name, source] of sources) if (noValues.test(source)) bare.push(`${name}: t('${key}')`);
  }
  assert.deepEqual(bare, [], "these reads would render the raw {{one|many}} token");

  // The static chrome is rewritten by applyI18n, which calls `t(key)` with no values because it has none
  // to give — it is walking elements, not counting anything. So a key with a plural token can never be a
  // data-i18n attribute: it would paint "{{n:file|files}}" into the page on every locale switch, and the
  // variable key means the check above cannot see it.
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
      // Korean inflects no nouns, so it is free to carry NO token where English carries one. What it may
      // not do is carry a token for a count the other locale does not have.
      const extra = theirs.filter((f) => !mine.includes(f));
      assert.deepEqual(extra, [], `${locale}.${key} pluralizes a count ${reference} does not`);
    }
  }
});
