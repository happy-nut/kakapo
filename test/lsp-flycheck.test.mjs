// A server whose diagnostics come from a compiler subprocess publishes an empty set first and the real
// findings later. Measured on rust-analyzer: empty publish at 1.6s, quiescent at 3.3s, the four findings at
// 3.7s — so "the first publish arrived" and "the server is quiescent" both land before the file has been
// compiled, and a Rust review was answered with a confident empty list every time. These are wire tests for
// the two halves of the fix: waiting for the check, and telling the server there is something to check.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../dist/lsp.js";

const roots = [];
after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} } });

/**
 * A server that behaves like rust-analyzer's flycheck: nothing to report until it is told the file is
 * saved, and then an announced run that publishes after a delay. It reports which save it is answering,
 * so a test can tell a fresh check apart from the one that finished before the file changed.
 */
function flycheckServer(root, { publishDelayMs = 0 } = {}) {
  const fake = join(root, "fake-flycheck.mjs");
  writeFileSync(fake, `
let buffer = Buffer.alloc(0);
let saves = 0;
let runs = 0;
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
function publish(uri, diagnostics) {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}
function check(uri) {
  const token = 'rust-analyzer/flycheck/' + (runs++);
  const save = saves;
  send({ jsonrpc: '2.0', method: '$/progress', params: { token, value: { kind: 'begin', title: 'cargo check' } } });
  setTimeout(() => {
    publish(uri, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2, source: 'rustc', message: 'check ' + save,
    }]);
    send({ jsonrpc: '2.0', method: '$/progress', params: { token, value: { kind: 'end' } } });
  }, ${publishDelayMs});
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
    if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }); continue; }
    // The empty publish that used to be mistaken for the answer: the document is known, nothing is compiled.
    if (message.method === 'textDocument/didOpen') { publish(message.params.textDocument.uri, []); continue; }
    if (message.method === 'textDocument/didSave') { saves += 1; check(message.params.textDocument.uri); continue; }
    if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, result: null });
  }
});
`);
  return fake;
}

function rustProject(text) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-flycheck-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.rs"), text);
  return root;
}

function client(root, options) {
  return new LspClient(root, {
    family: "rust", name: "fake-flycheck", command: process.execPath, args: [flycheckServer(root, options)],
  });
}

test("the empty publish that arrives before the check is not taken for the answer", async () => {
  const root = rustProject("fn main() {}\n");
  const lsp = client(root, { publishDelayMs: 150 });
  try {
    const diagnostics = await lsp.diagnosticsFor("src/main.rs");
    // Before this fix the read resolved on the didOpen publish — an empty array, reported to the reader as
    // "no problems" — and the compiler's findings landed in a map nobody asked again.
    assert.equal(diagnostics.length, 1, "the read waited for the check that the empty publish preceded");
    assert.equal(diagnostics[0].message, "check 1", "and the findings are the ones the save ran");
    assert.equal(diagnostics[0].severity, "warning");
  } finally {
    lsp.dispose();
  }
});

test("a file that changed waits for its own check, not the one that finished before the edit", async () => {
  const root = rustProject("fn main() {}\n");
  // Longer than the 2s first-publish budget, so a read that does not wait for the new check answers empty.
  const lsp = client(root, { publishDelayMs: 2_500 });
  try {
    const first = await lsp.diagnosticsFor("src/main.rs");
    assert.equal(first[0]?.message, "check 1");
    const file = join(root, "src", "main.rs");
    writeFileSync(file, "fn main() { let x = 1; }\n");
    const future = new Date(Date.now() + 2_000);
    utimesSync(file, future, future); // the mtime is what tells the client the document changed
    const second = await lsp.diagnosticsFor("src/main.rs");
    assert.equal(second[0]?.message, "check 2",
      "the second read waited for the save it caused, instead of returning on the completed first run");
  } finally {
    lsp.dispose();
  }
});
