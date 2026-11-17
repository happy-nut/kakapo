import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../dist/lsp.js";

function fakeServer(root, settingsFile, lensCount, firstCount) {
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
        ...message.params, command: { title: \`\${message.params.data.index + ${firstCount}} references\` },
      } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }
});
`);
  return path;
}

async function withClient(lensCount, body, firstCount = 1) {
  const host = clientAgainst(lensCount, firstCount);
  try {
    await body(host);
  } finally {
    host.client.dispose();
  }
}

function clientAgainst(lensCount, firstCount) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-code-vision-"));
  writeFileSync(join(root, "one.ts"), "export const one = 1;\n");
  const settingsFile = join(root, "settings.json");
  const client = new LspClient(root, {
    family: "typescript", name: "fake-ts", command: process.execPath,
    args: [fakeServer(root, settingsFile, lensCount, firstCount)], source: "project",
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
    "1 references", "2 references", "3 references", "4 references", "5 references",
  ], "the titles came from codeLens/resolve");
  assert.deepEqual(lenses.map((lens) => lens.lineIndex), [0, 1, 2, 3, 4], "each on its own declaration's line");
  });
});

test("one file's Code Vision is bounded", async () => {
  await withClient(420, async ({ client }) => {
  const { lenses } = await client.codeLenses("one.ts");
  assert.equal(lenses.length, 300, "capped rather than unbounded — a resolve is a references lookup each");
  });
});

test("a lens that asserts nothing is not drawn", async () => {
  await withClient(3, async ({ client }) => {
    const { supported, lenses } = await client.codeLenses("one.ts");
    assert.equal(supported, true, "the provider is still there — this is not a capability question");
    assert.deepEqual(lenses.map((lens) => lens.title), ["1 references", "2 references"],
      "the zero is gone and the counts that say something are kept");
    assert.deepEqual(lenses.map((lens) => lens.lineIndex), [1, 2],
      "each surviving lens still sits on its own declaration's line");
  }, 0);
});

test("only a count of nothing is suppressed", async () => {
  const { assertsNothing } = await import("../dist/lsp.js");
  for (const title of ["0 references", "0 implementations", "0 references | 0 implementations", "0 overrides"]) {
    assert.equal(assertsNothing(title), true, `${JSON.stringify(title)} says nothing is there`);
  }
  for (const title of ["1 reference", "10 references", "100 references", "20 implementations",
    "Run | Debug", "Generate equals()", "override", "1 reference | 0 implementations"]) {
    assert.equal(assertsNothing(title), false, `${JSON.stringify(title)} still says something`);
  }
});
