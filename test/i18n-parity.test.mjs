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

// A string that counts things writes both forms — "{{n:usage|usages}}" — and `plural()` (01-core.js)
// picks one. Nothing picks it automatically: a string that grows the token without a call site that
// applies plural() renders the raw "{{n:usage|usages}}" on screen, which is worse than the "comment(s)"
// this replaced. One grep is cheaper than finding that in a screenshot.
test("every string with a plural token is read through plural()", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = new URL("../src/viewer/", import.meta.url).pathname;
  const viewer = readdirSync(dir).filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

  const withToken = new Set();
  for (const messages of Object.values(MESSAGES)) {
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value === "string" && /\{\{\w+:[^|{}]*\|[^{}]*\}\}/.test(value)) withToken.add(key);
    }
  }
  assert.ok(withToken.size > 0, "the token is in use at all — otherwise this guard is vacuous");

  const unread = [...withToken].filter((key) => {
    // The call has to wrap this key's own t(): `plural(t('the.key'), …)`.
    return !new RegExp(`plural\\(\\s*t\\(\\s*'${key.replace(/\./g, "\\.")}'`).test(viewer);
  });
  assert.deepEqual(unread, [], "these strings would render their raw {{one|many}} token");
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
