import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectAnalysis, buildRegexSymbolIndex } from "../dist/analysis.js";
import { LspClient, normalizeLocationResult, resolveLanguageServer } from "../dist/lsp.js";

const dirs = [];
function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "monacori-analysis-"));
  dirs.push(root);
  return root;
}
function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test("regex symbol index recognizes cross-language declarations without a renderer worker", () => {
  const index = buildRegexSymbolIndex([
    { path: "src/app.ts", content: "export interface Store {}\nexport function load() {}\n" },
    { path: "pkg/main.go", content: "func Start() { }\n" },
  ]);
  assert.equal(index.definitions.get("Store")?.[0].symbolKind, "interface");
  assert.equal(index.definitions.get("load")?.[0].path, "src/app.ts");
  assert.equal(index.definitions.get("Start")?.[0].path, "pkg/main.go");
});

test("main-process fallback answers definition, references, implementation, symbols, and change impact", async () => {
  const root = tempProject();
  const files = [
    {
      path: "src/service.ts",
      content: [
        "export interface Store { read(): string }",
        "export class MemoryStore implements Store { read() { return 'ok'; } }",
        "export function helper(store: Store) { return store.read(); }",
        "export function process(store: Store) { return helper(store); }",
        "",
      ].join("\n"),
    },
    { path: "src/caller.ts", content: "import { process } from './service';\nexport const result = process({ read: () => 'x' });\n" },
    { path: "test/service.test.ts", content: "import { process } from '../src/service';\ntest('process', () => process({ read: () => 'x' }));\n" },
    { path: "schemas/process.schema.json", content: "{ \"title\": \"process\" }\n" },
  ];
  for (const file of files) write(root, file.path, file.content);
  const statuses = [];
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined, onStatus: (status) => statuses.push(status) });
  analysis.invalidate();

  const definition = await analysis.query({ kind: "definition", path: "src/caller.ts", line: 1, column: 23, symbol: "process" });
  assert.equal(definition.engine, "index");
  assert.equal(definition.generation, 1, "responses identify the repository generation they analyzed");
  assert.ok(definition.durationMs >= 0, "responses expose analysis latency");
  assert.match(definition.fallbackReason, /No language server/);
  assert.equal(statuses.at(-1)?.phase, "fallback");
  assert.equal(statuses.at(-1)?.generation, 1);
  assert.deepEqual(definition.locations[0] && [definition.locations[0].path, definition.locations[0].lineIndex], ["src/service.ts", 3]);

  const references = await analysis.query({ kind: "references", path: "src/service.ts", line: 3, column: 16, symbol: "process" });
  assert.ok(references.locations.some((item) => item.path === "src/caller.ts"));
  assert.ok(references.locations.some((item) => item.path === "test/service.test.ts"));

  const implementation = await analysis.query({ kind: "implementation", path: "src/service.ts", line: 0, column: 17, symbol: "Store" });
  assert.ok(implementation.locations.some((item) => item.name === "MemoryStore"));

  const symbols = await analysis.query({ kind: "workspaceSymbol", path: "src/service.ts", query: "Memory" });
  assert.deepEqual(symbols.locations.map((item) => item.name), ["MemoryStore"]);

  const impact = await analysis.query({ kind: "impact", path: "src/service.ts", line: 3, column: 20, symbol: "process" });
  assert.equal(impact.impact?.symbol, "process");
  assert.ok(impact.impact?.callers.some((item) => item.path === "src/caller.ts"), "caller/importer is classified");
  assert.ok(impact.impact?.dependencies.some((item) => item.name === "helper"), "outgoing call is classified");
  assert.ok(impact.impact?.tests.some((item) => item.path === "test/service.test.ts"), "related test is classified");
  assert.ok(impact.impact?.contracts.some((item) => item.name === "Store"), "signature type is classified");
  analysis.dispose();
});

test("LSP adapter speaks stdio JSON-RPC and normalizes project-relative locations", async () => {
  const root = tempProject();
  write(root, "src/app.ts", "export const app = target();\n");
  write(root, "src/target.ts", "export function target() {}\n");
  const fake = join(root, "fake-lsp.mjs");
  writeFileSync(fake, `
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let buffer = Buffer.alloc(0);
const uri = pathToFileURL(resolve(process.cwd(), 'src/target.ts')).href;
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
    if (typeof message.id !== 'number') continue;
    let result = null;
    if (message.method === 'initialize') result = { capabilities: {} };
    else if (message.method === 'workspace/symbol') result = [{ name: 'target', kind: 12, location: { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } } }];
    else result = [{ uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } }];
    send({ jsonrpc: '2.0', id: message.id, result });
  }
});
`);
  const client = new LspClient(root, { family: "typescript", name: "fake-lsp", command: process.execPath, args: [fake] });
  try {
    const [definitions, references, implementations] = await Promise.all([
      client.locations("textDocument/definition", "src/app.ts", 0, 19),
      client.locations("textDocument/references", "src/app.ts", 0, 19),
      client.locations("textDocument/implementation", "src/app.ts", 0, 19),
    ]);
    assert.deepEqual(definitions[0] && [definitions[0].path, definitions[0].lineIndex, definitions[0].column], ["src/target.ts", 0, 16]);
    assert.equal(references[0]?.path, "src/target.ts");
    assert.equal(implementations[0]?.path, "src/target.ts");
    const symbols = await client.workspaceSymbols("tar");
    assert.equal(symbols[0]?.name, "target");
    assert.equal(symbols[0]?.kind, 12);
  } finally {
    client.dispose();
  }
});

test("language-server resolution prefers a project-local executable and rejects outside locations", () => {
  const root = tempProject();
  const executable = join(root, "node_modules", ".bin", "typescript-language-server");
  write(root, "node_modules/.bin/typescript-language-server", "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const resolved = resolveLanguageServer(root, "src/app.ts", { PATH: "" }, process.platform);
  assert.equal(resolved?.command, executable);
  assert.equal(resolved?.source, "project");

  const outside = normalizeLocationResult({
    uri: pathToFileURL(join(root, "..", "outside.ts")).href,
    range: { start: { line: 1, character: 2 } },
  }, root);
  assert.deepEqual(outside, []);
});

test("TypeScript resolution uses the packaged sidecar before PATH", () => {
  const root = tempProject();
  write(root, "src/app.ts", "export const app = 1;\n");
  const pathServer = join(root, "path-bin", "typescript-language-server");
  write(root, "path-bin/typescript-language-server", "#!/bin/sh\nexit 0\n");
  chmodSync(pathServer, 0o755);

  const resolved = resolveLanguageServer(root, "src/app.ts", { PATH: dirname(pathServer) }, process.platform);
  assert.equal(resolved?.source, "bundled");
  assert.equal(resolved?.command, process.execPath);
  assert.match(resolved?.args[0] ?? "", /typescript-language-server[/\\]lib[/\\]cli\.mjs$/);
  assert.deepEqual(resolved?.args.slice(1), ["--stdio"]);
  assert.equal(resolved?.env?.ELECTRON_RUN_AS_NODE, "1");
});

test("packaged TypeScript sidecar resolves a cross-file definition semantically", { timeout: 20_000 }, async () => {
  const root = tempProject();
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2022" }, include: ["src"] }));
  write(root, "src/target.ts", "export function target() { return 42; }\n");
  write(root, "src/app.ts", "import { target } from './target';\nexport const value = target();\n");
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm(["src/app.ts"]);
    const definition = await analysis.query({ kind: "definition", path: "src/app.ts", line: 1, column: 23, symbol: "target" });
    assert.equal(definition.engine, "lsp");
    assert.equal(definition.confidence, "semantic");
    assert.equal(definition.server, "typescript-language-server");
    assert.equal(definition.serverSource, "bundled");
    assert.deepEqual(
      definition.locations[0] && [definition.locations[0].path, definition.locations[0].lineIndex, definition.locations[0].column],
      ["src/target.ts", 0, 16],
    );
  } finally {
    analysis.dispose();
  }
});

test("a broken project TypeScript server falls through to the packaged sidecar", {
  timeout: 20_000,
  skip: process.platform === "win32",
}, async () => {
  const root = tempProject();
  const broken = join(root, "node_modules", ".bin", "typescript-language-server");
  write(root, "node_modules/.bin/typescript-language-server", "#!/bin/sh\nexit 1\n");
  chmodSync(broken, 0o755);
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2022" }, include: ["src"] }));
  write(root, "src/target.ts", "export function target() { return 42; }\n");
  write(root, "src/app.ts", "import { target } from './target';\nexport const value = target();\n");
  const analysis = new ProjectAnalysis(root);
  try {
    await analysis.prewarm(["src/app.ts"]);
    const definition = await analysis.query({ kind: "definition", path: "src/app.ts", line: 1, column: 23, symbol: "target" });
    assert.equal(definition.engine, "lsp");
    assert.equal(definition.serverSource, "bundled");
    assert.equal(definition.locations[0]?.path, "src/target.ts");
  } finally {
    analysis.dispose();
  }
});
