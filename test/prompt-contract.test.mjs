// The prompts tell an agent what to write; comments-file.ts decides what kakapo can read. Nothing connected
// the two, and they came apart: the English codebase prompt asked for {"version":1,"notes":[…]} — a shape
// readThread() drops on the floor — while the Korean one asked for JSONL. Both were correct-looking text
// inside a 4,000-character line nobody could diff (issue #28).
//
// So the examples in the prompts are tested as the contract they are: every JSON object a prompt shows the
// agent is parsed back through the real reader, and its fields must exist on ThreadRecord. The key
// list is read out of src/comments-file.ts rather than copied here, so renaming a field fails this test
// instead of quietly outdating it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThread } from "../dist/comments-file.js";
import { readTerms } from "../dist/terms-file.js";
import { MESSAGES } from "../dist/i18n.js";

const source = readFileSync(new URL("../src/comments-file.ts", import.meta.url), "utf8");
const termsSource = readFileSync(new URL("../src/terms-file.ts", import.meta.url), "utf8");

function typeKeys(name, from = source) {
  const body = from.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(body, `${name} is still a type literal`);
  const keys = [...body[1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 3, `${name} has fields`);
  return new Set(keys);
}

const RECORD_KEYS = typeKeys("ThreadRecord");
// A prompt now hands an agent two shapes, not one: a line for the review thread, and a line for the
// vocabulary (terms-file.ts). They go to different files and different readers, so each example is checked
// against the reader that will actually have to read it back — told apart by the field only a word has.
const TERM_KEYS = typeKeys("TermRecord", termsSource);

// The prompts write placeholders where a real value goes ("id":<highest id in the file + 1>). Substituting a
// number is what the agent does; it is the KEYS that are the contract, so that is what survives the swap.
function jsonExamples(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" || text[i + 1] !== '"') continue;
    let depth = 0, inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        found.push(text.slice(i, j + 1).replace(/<[^>]*>/g, "1"));
        i = j;
        break;
      }
    }
  }
  return found;
}

// Every prompt that hands an agent a JSON shape. The merge handoff's answer line is the same contract.
//
// terms.prompt.default is deliberately NOT here any more. It stopped showing a record shape when the
// vocabulary moved behind kakapo_keep_word: the tool's inputSchema is the shape now, and it is checked
// where it lives (test/mcp-server.test.mjs). A prompt that teaches a shape the agent no longer types would
// be a second, drifting copy of it.
const PROMPT_KEYS = [
  "annotate.prompt.default", "codebase.prompt.default", "mergePrompt.answersFile",
  "mergePrompt.terms",
];

test("every JSON example in the prompts is a record kakapo can read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-prompt-"));
  try {
    for (const key of PROMPT_KEYS) {
      for (const locale of Object.keys(MESSAGES)) {
        const examples = jsonExamples(MESSAGES[locale][key]);
        assert.ok(examples.length > 0, `${locale} ${key} shows the agent at least one JSON line`);

        // Straight through the reader the app uses — one example per line, exactly how an agent appends.
        const isWord = (line) => /"w"\s*:/.test(line);
        const threadLines = examples.filter((line) => !isWord(line));
        const termLines = examples.filter(isWord);

        if (threadLines.length) {
          const file = join(dir, "comments.jsonl");
          writeFileSync(file, threadLines.join("\n") + "\n");
          const records = readThread(file);
          assert.equal(records.length, threadLines.length, `${locale} ${key}: every example survives readThread`);
          for (const record of records) {
            for (const field of Object.keys(record)) {
              assert.ok(RECORD_KEYS.has(field), `${locale} ${key}: "${field}" is not a ThreadRecord field`);
            }
          }
        }

        if (termLines.length) {
          const file = join(dir, "terms.jsonl");
          writeFileSync(file, termLines.join("\n") + "\n");
          const terms = readTerms(file);
          assert.equal(terms.length, termLines.length, `${locale} ${key}: every word example survives readTerms`);
          for (const term of terms) {
            for (const field of Object.keys(term)) {
              assert.ok(TERM_KEYS.has(field), `${locale} ${key}: "${field}" is not a TermRecord field`);
            }
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The accident was one language drifting from the other while both looked fine on their own. Comparing the
// fields the two versions ask for catches that on the next edit, not after an agent writes an unreadable file.
test("en and ko prompts ask for the same fields", () => {
  for (const key of PROMPT_KEYS) {
    const fields = (locale) => {
      const keys = new Set();
      for (const example of jsonExamples(MESSAGES[locale][key])) {
        for (const field of Object.keys(JSON.parse(example))) keys.add(field);
      }
      return [...keys].sort();
    };
    assert.deepEqual(fields("ko"), fields("en"), `${key} instructs the same record shape in both languages`);
  }
});
