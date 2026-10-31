// A range request is asked in terms of the document, and a server may refuse one that names a line the
// document does not have. rust-analyzer does: asked for lines 0–2000 of a seventeen-line file it answers
// `Invalid offset LineCol { line: 2000, col: 0 }` and the whole request fails, which is why inlay hints —
// drawn everywhere else — were missing from every Rust file in the app while nothing reported an error.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../dist/lsp.js";

const roots = [];
after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} } });

/** A server that refuses a range past the end of the document, and otherwise reports the range it got. */
function strictRangeServer(root) {
  const fake = join(root, "fake-strict.mjs");
  writeFileSync(fake, `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let buffer = Buffer.alloc(0);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString();
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)?.[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { inlayHintProvider: true } } }); continue; }
    if (message.method === 'textDocument/inlayHint') {
      const text = readFileSync(fileURLToPath(message.params.textDocument.uri), 'utf8');
      const lines = text.split('\\n');
      const wanted = message.params.range.end;
      if (wanted.line > lines.length - 1 || (wanted.line === lines.length - 1 && wanted.character > lines[lines.length - 1].length)) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid offset LineCol { line: ' + wanted.line + ', col: ' + wanted.character + ' }' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: message.id, result: [
        { position: { line: 0, character: 0 }, label: JSON.stringify(message.params.range), kind: 1 },
      ] });
      continue;
    }
    if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, result: null });
  }
});
`);
  return fake;
}

test("an inlay-hint window is cut down to the document, so a strict server still answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-range-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const text = "fn main() {\n    let n = 1;\n}\n";
  writeFileSync(join(root, "src", "main.rs"), text);
  const client = new LspClient(root, {
    family: "rust", name: "fake-strict", command: process.execPath, args: [strictRangeServer(root)],
  });
  try {
    // What the viewer asks for: this file's hints, with a window far longer than the file.
    const answer = await client.inlayHints("src/main.rs", 0, 2000);
    assert.equal(answer.supported, true);
    assert.equal(answer.hints.length, 1, "the request was answered instead of refused");
    const range = JSON.parse(answer.hints[0].label);
    const lines = text.split("\n");
    assert.deepEqual(range.end, { line: lines.length - 1, character: lines[lines.length - 1].length },
      "the window stopped at the end of the document rather than at the line the caller guessed");
  } finally {
    client.dispose();
  }
});

test("a window that fits inside the document is left alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-range-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.rs"), Array.from({ length: 40 }, (_, i) => `// line ${i}`).join("\n") + "\n");
  const client = new LspClient(root, {
    family: "rust", name: "fake-strict", command: process.execPath, args: [strictRangeServer(root)],
  });
  try {
    const answer = await client.inlayHints("src/main.rs", 5, 12);
    const range = JSON.parse(answer.hints[0].label);
    assert.deepEqual(range.start, { line: 5, character: 0 });
    assert.deepEqual(range.end, { line: 12, character: 0 }, "a caller asking for less than the file gets what it asked for");
  } finally {
    client.dispose();
  }
});
