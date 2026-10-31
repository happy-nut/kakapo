// A server's settings reach it by two roads and most servers only walk one. typescript-language-server reads
// the `settings` payload kakapo PUSHES with workspace/didChangeConfiguration; gopls, clangd and
// rust-analyzer ignore that notification and PULL what they want with a workspace/configuration request.
// That pull used to be answered with `{}` for every section, so gopls's inspections — staticcheck and the
// analyses it leaves off by default — could not be turned on from this app at all: the setting sat in the
// source looking enabled and never arrived. This is the wire test for the road that was dead.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, configurationSection } from "../dist/lsp.js";

const roots = [];
after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} } });

function project(file, text) {
  const root = mkdtempSync(join(tmpdir(), "kakapo-config-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, file), text);
  return root;
}

/** A server that pulls the sections it cares about and reports what it was handed, as a diagnostic message. */
function pullingServer(root, sections) {
  const fake = join(root, "fake-lsp.mjs");
  writeFileSync(fake, `
const SECTIONS = ${JSON.stringify(sections)};
let buffer = Buffer.alloc(0);
let uri = null;
let answer = null;
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
function publishWhenReady() {
  if (!uri || !answer) return;
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: JSON.stringify(answer) },
  ] } });
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
    if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items: SECTIONS.map((s) => (s === null ? {} : { section: s })) } });
      continue;
    }
    if (message.method === 'textDocument/didOpen') { uri = message.params.textDocument.uri; publishWhenReady(); continue; }
    if (message.id === 9001) { answer = message.result; publishWhenReady(); continue; }
    if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, result: null });
  }
});
`);
  return fake;
}

async function pulled(family, file, sections) {
  const root = project(file, "x\n");
  const client = new LspClient(root, {
    family, name: "fake-lsp", command: process.execPath, args: [pullingServer(root, sections)],
  });
  try {
    const diagnostics = await client.diagnosticsFor(file);
    assert.equal(diagnostics.length, 1, "the fake server reports its answer as one diagnostic");
    return JSON.parse(diagnostics[0].message);
  } finally {
    client.dispose();
  }
}

test("a pulled section is answered out of the family's real settings, not with an empty object", async () => {
  const [gopls] = await pulled("go", "src/main.go", ["gopls"]);
  assert.equal(gopls.staticcheck, true,
    "gopls asked what it should check and was told — this is the line that was returning {}");
  assert.equal(gopls.analyses.nilness, true, "and the analyses its own default leaves off came with it");
});

test("a dotted section walks into the settings, and an unknown one is answered with nothing", async () => {
  const [analyses, missing, whole] = await pulled("go", "src/main.go", ["gopls.analyses", "gopls.nonsense", null]);
  assert.equal(analyses.unusedwrite, true, "the dotted path resolved to the sub-object, not the whole family");
  assert.deepEqual(missing, {}, "a section this client has nothing to say about is {}, never undefined");
  assert.ok(whole.gopls, "an item with no section at all gets the family's whole object");
});

test("a family with no settings of its own is still answered, with nothing", async () => {
  const [section] = await pulled("clang", "src/a.c", ["clangd"]);
  assert.deepEqual(section, {}, "clangd needs no settings from this app and must not be left waiting");
});

test("configurationSection resolves paths without a server in the loop", () => {
  const settings = { gopls: { staticcheck: true, analyses: { nilness: true } } };
  assert.deepEqual(configurationSection(settings, "gopls.analyses"), { nilness: true });
  assert.equal(configurationSection(settings, "gopls.staticcheck"), true);
  assert.deepEqual(configurationSection(settings, "gopls.analyses.nope"), {});
  assert.deepEqual(configurationSection(settings, ""), settings, "no section means all of it");
  assert.deepEqual(configurationSection(settings, undefined), settings);
  // A section naming a path THROUGH a non-object must not read a string's own properties.
  assert.deepEqual(configurationSection({ a: "text" }, "a.length"), {});
});
