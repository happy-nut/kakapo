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
