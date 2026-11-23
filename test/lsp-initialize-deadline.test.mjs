import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../dist/lsp.js";

// Restoring a large Eclipse workspace answers `initialize` long after any flat deadline a reader would
// tolerate: a real Spring project left jdtls 395 MB to reopen, and every restart began the same restore, so
// a flat 20-second deadline turned a slow start into a language that never came back. The deadline is
// idleness instead, which is only honest if silence still kills — both halves are asserted here.
const roots = [];
after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch { } } });

function fakeServer(root, { answerAfterMs, chatterEveryMs }) {
  const file = join(root, "fake-initialize.mjs");
  writeFileSync(file, `
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
    if (message.method !== 'initialize') continue;
    ${chatterEveryMs ? `const beat = setInterval(() => send({
      jsonrpc: '2.0', method: 'window/logMessage', params: { type: 4, message: 'restoring the workspace' },
    }), ${chatterEveryMs});
    beat.unref?.();` : ""}
    setTimeout(() => {
      ${chatterEveryMs ? "clearInterval(beat);" : ""}
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    }, ${answerAfterMs});
  }
});
`);
  return file;
}

function clientFor(root, fake, initializeIdleMs) {
  return new LspClient(root, {
    family: "fake",
    name: "fake-initialize",
    command: process.execPath,
    args: [fake],
    initializeIdleMs,
  });
}

test("a server that keeps talking is still waited for past the idle window", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-initialize-"));
  roots.push(root);
  const fake = fakeServer(root, { answerAfterMs: 900, chatterEveryMs: 50 });
  const client = clientFor(root, fake, 200);
  try {
    // 900 ms of work against a 200 ms window: without the re-arming this rejects four windows before the answer.
    await client.start();
  } finally {
    client.stop?.();
    client.dispose?.();
  }
});

test("a server that goes quiet still fails inside the idle window", async () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-initialize-quiet-"));
  roots.push(root);
  const fake = fakeServer(root, { answerAfterMs: 5_000, chatterEveryMs: 0 });
  const client = clientFor(root, fake, 300);
  const started = Date.now();
  await assert.rejects(() => client.start(), /timed out during initialize/);
  const spent = Date.now() - started;
  assert.ok(spent < 3_000, `a silent server should fail in its idle window, took ${spent} ms`);
  client.stop?.();
  client.dispose?.();
});
