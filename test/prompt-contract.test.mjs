// The prompts tell an agent what to write; comments-file.ts decides what kakapo can read. Nothing connected
// the two, and they came apart: the English codebase prompt asked for {"version":1,"notes":[…]} — a shape
// readThread() drops on the floor — while the Korean one asked for JSONL. Both were correct-looking text
// inside a 4,000-character line nobody could diff (issue #28).
//
// So the examples in the prompts are tested as the contract they are: every JSON object a prompt shows the
// agent is parsed back through the real reader, and its fields must exist on ThreadRecord/NoteStep. The key
// list is read out of src/comments-file.ts rather than copied here, so renaming a field fails this test
// instead of quietly outdating it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThread } from "../dist/comments-file.js";
import { MESSAGES } from "../dist/i18n.js";

const source = readFileSync(new URL("../src/comments-file.ts", import.meta.url), "utf8");

function typeKeys(name) {
  const body = source.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(body, `${name} is still a type literal in comments-file.ts`);
  const keys = [...body[1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 3, `${name} has fields`);
  return new Set(keys);
}

const RECORD_KEYS = typeKeys("ThreadRecord");
const STEP_KEYS = typeKeys("NoteStep");

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
const PROMPT_KEYS = ["annotate.prompt.default", "codebase.prompt.default", "mergePrompt.answersFile"];

test("every JSON example in the prompts is a record kakapo can read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-prompt-"));
  try {
    for (const key of PROMPT_KEYS) {
      for (const locale of Object.keys(MESSAGES)) {
        const examples = jsonExamples(MESSAGES[locale][key]);
        assert.ok(examples.length > 0, `${locale} ${key} shows the agent at least one JSON line`);

        // Straight through the reader the app uses — one example per line, exactly how an agent appends.
        const file = join(dir, "comments.jsonl");
        writeFileSync(file, examples.join("\n") + "\n");
        const records = readThread(file);
        assert.equal(records.length, examples.length, `${locale} ${key}: every example survives readThread`);

        for (const record of records) {
          for (const field of Object.keys(record)) {
            assert.ok(RECORD_KEYS.has(field), `${locale} ${key}: "${field}" is not a ThreadRecord field`);
          }
          for (const step of record.steps ?? []) {
            for (const field of Object.keys(step)) {
              assert.ok(STEP_KEYS.has(field), `${locale} ${key}: step "${field}" is not a NoteStep field`);
            }
            assert.ok(Number.isFinite(step.line), `${locale} ${key}: a step names its line`);
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
