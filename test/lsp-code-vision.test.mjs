// Code Vision and inlay hints were plumbed, keyed, menued, documented — and blank, in the language this
// app is written in. Two separate reasons, both invisible to every test that stubbed the analysis bridge,
// because nothing in the client was broken: it asked, the server answered `ok`, and the answer was empty.
//
//  1. kakapo sent `workspace/didChangeConfiguration` with `{}`. typescript-language-server takes that
//     notification's `settings` AS its workspace configuration and reads Code Vision and inlay hints out
//     of exactly those keys, so both were off for every TypeScript and JavaScript review.
//  2. A server may answer `textDocument/codeLens` with `{range, data}` and no title, expecting one
//     `codeLens/resolve` per lens. That is not an edge case — typescript-language-server does it for
//     EVERY lens — and the client dropped every title-less lens rather than resolving it.
//
// Both halves live in LspClient, so this drives a real one over stdio against a server that behaves the
// way the real one does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../dist/lsp.js";

/** A server that answers only what this test is about, and records the configuration it was handed. */
function fakeServer(root, settingsFile, lensCount) {
  const path = join(root, "server.mjs");
  writeFileSync(path, `
import { writeFileSync } from "node:fs";
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\\r\\n\\r\\n");
    if (header < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.slice(0, header).toString())?.[1]);
    if (!Number.isFinite(length) || buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.slice(header + 4, header + 4 + length).toString());
    buffer = buffer.slice(header + 4 + length);

    if (message.method === "workspace/didChangeConfiguration") {
      writeFileSync(${JSON.stringify(settingsFile)}, JSON.stringify(message.params?.settings ?? null));
    }
    if (message.id === undefined) continue; // a notification: nothing to answer

    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {
        codeLensProvider: { resolveProvider: true }, inlayHintProvider: true,
      } } });
    } else if (message.method === "textDocument/codeLens") {
      // Unresolved, exactly as typescript-language-server answers: a range and opaque data, no command.
      send({ jsonrpc: "2.0", id: message.id, result: Array.from({ length: ${lensCount} }, (_unused, i) => ({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 4 } },
        data: { index: i },
      })) });
    } else if (message.method === "codeLens/resolve") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        ...message.params, command: { title: \`\${message.params.data.index} references\` },
      } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }
});
`);
  return path;
}

/**
 * Run `body` against a fresh client and ALWAYS dispose it.
 *
 * A failing assertion must still kill the server: without this the first `assert` to fail skipped the
 * `dispose()` below it, the fake server survived the test file, and `node --test` waited on it forever —
 * so the suite could only ever report success. A guard that cannot fail out loud is not a guard.
 */
async function withClient(lensCount, body) {
  const host = clientAgainst(lensCount);
  try {
    await body(host);
  } finally {
    host.client.dispose();
  }
}

function clientAgainst(lensCount) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-code-vision-"));
  writeFileSync(join(root, "one.ts"), "export const one = 1;\n");
  const settingsFile = join(root, "settings.json");
  const client = new LspClient(root, {
    // The family is what picks the settings, so it has to be the real one.
    family: "typescript", name: "fake-ts", command: process.execPath,
    args: [fakeServer(root, settingsFile, lensCount)], source: "project",
  });
  return { root, client, settings: () => JSON.parse(readFileSync(settingsFile, "utf8")) };
}

test("the server is told the reader wants Code Vision and inlay hints at all", async () => {
  await withClient(0, async ({ client, settings }) => {
  await client.codeLenses("one.ts");
  const sent = settings();

  for (const language of ["typescript", "javascript"]) {
    assert.equal(sent[language].referencesCodeLens.enabled, true, `${language}: usages above a declaration`);
    assert.equal(sent[language].referencesCodeLens.showOnAllFunctions, true,
      `${language}: on every declaration, which is where IntelliJ draws it`);
    assert.equal(sent[language].implementationsCodeLens.enabled, true, `${language}: implementations too`);
    assert.equal(sent[language].inlayHints.includeInlayParameterNameHints, "all",
      `${language}: parameter names at a call site`);
    assert.equal(sent[language].inlayHints.includeInlayParameterNameHintsWhenArgumentMatchesName, false,
      `${language}: except the one IntelliJ leaves out — a name that repeats the argument's`);
    assert.equal(sent[language].inlayHints.includeInlayVariableTypeHints, true,
      `${language}: and the types it inferred for you`);
  }
  });
});

test("a lens with no title is resolved, not dropped", async () => {
  await withClient(5, async ({ client }) => {
  const { supported, lenses } = await client.codeLenses("one.ts");
  assert.equal(supported, true);
  assert.equal(lenses.length, 5, "every lens the server sent is drawn — none arrived with a title");
  assert.deepEqual(lenses.map((lens) => lens.title), [
    "0 references", "1 references", "2 references", "3 references", "4 references",
  ], "the titles came from codeLens/resolve");
  assert.deepEqual(lenses.map((lens) => lens.lineIndex), [0, 1, 2, 3, 4], "each on its own declaration's line");
  });
});

// The bound the resolving replaces the old "drop them all" with. 300 is the cap; a file with more
// declarations than that is read one screen at a time anyway.
test("one file's Code Vision is bounded", async () => {
  await withClient(420, async ({ client }) => {
  const { lenses } = await client.codeLenses("one.ts");
  assert.equal(lenses.length, 300, "capped rather than unbounded — a resolve is a references lookup each");
  });
});
