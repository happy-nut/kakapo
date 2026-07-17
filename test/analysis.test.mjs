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
  const root = mkdtempSync(join(tmpdir(), "kakapo-analysis-"));
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
    { path: "src/commented.ts", content: "// export function ignoredLine() {}\n/*\nexport function ignoredBlock() {}\n*/\n" },
    { path: "src/worker.py", content: "class Worker:\n    def execute(self):\n        return True\n" },
    { path: "docs/generated.ts", content: "export function ignoredDocument() {}\n" },
  ]);
  assert.equal(index.definitions.get("Store")?.[0].symbolKind, "interface");
  assert.equal(index.definitions.get("load")?.[0].path, "src/app.ts");
  assert.equal(index.definitions.get("Start")?.[0].path, "pkg/main.go");
  assert.equal(index.definitions.has("ignoredLine"), false, "line comments never become symbols");
  assert.equal(index.definitions.has("ignoredBlock"), false, "block comments never become symbols");
  assert.equal(index.definitions.has("ignoredDocument"), false, "code-shaped files under docs are not indexed");
  assert.equal(index.definitions.get("execute")?.[0].container, "Worker", "Python methods retain their owning class");
  assert.equal(index.definitions.get("execute")?.[0].symbolKind, "method");
});

test("Python heuristic navigation resolves class methods conservatively instead of matching every same-named method", async () => {
  const root = tempProject();
  const files = [
    { path: "src/alpha.py", content: "class Alpha:\n    def execute(self, value):\n        return value\n" },
    { path: "src/beta.py", content: "class Beta:\n    def execute(self, value):\n        return value * 2\n" },
    {
      path: "src/use.py",
      content: [
        "from .alpha import Alpha",
        "from .beta import Beta",
        "alpha = Alpha()",
        "beta = Beta()",
        "alpha.execute(1)",
        "beta.execute(2)",
        "unknown.execute(3)",
        "",
      ].join("\n"),
    },
    { path: "tests/test_alpha.py", content: "from src.alpha import Alpha\nsubject = Alpha()\nassert subject.execute(1) == 1\n" },
  ];
  for (const file of files) write(root, file.path, file.content);
  const analysis = new ProjectAnalysis(root, { files, resolveServer: () => undefined });

  const declaration = await analysis.query({ kind: "definition", path: "src/alpha.py", line: 1, column: 9, symbol: "execute" });
  assert.deepEqual(declaration.locations.map((item) => [item.path, item.lineIndex]), [["src/alpha.py", 1]], "the declaration itself has one qualified definition");

  const alphaCall = await analysis.query({ kind: "definition", path: "src/use.py", line: 4, column: 8, symbol: "execute" });
  assert.deepEqual(alphaCall.locations.map((item) => [item.path, item.lineIndex]), [["src/alpha.py", 1]], "a receiver constructed as Alpha resolves only Alpha.execute");

  const ambiguousCall = await analysis.query({ kind: "definition", path: "src/use.py", line: 6, column: 10, symbol: "execute" });
  assert.equal(ambiguousCall.locations.length, 0, "an unknown receiver fails closed instead of returning every execute method");

  const references = await analysis.query({ kind: "references", path: "src/alpha.py", line: 1, column: 9, symbol: "execute" });
  assert.deepEqual(
    references.locations.map((item) => `${item.path}:${item.lineIndex}`).sort(),
    ["src/alpha.py:1", "src/use.py:4", "tests/test_alpha.py:2"],
    "references retain the declaration and receivers bound to Alpha while excluding Beta/unknown.execute",
  );
  analysis.dispose();
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
    { path: "src/caller.ts", content: "import { process } from './service';\n// process({ read: () => 'disabled' });\nexport const label = 'process';\nexport const result = process({ read: () => 'x' });\n" },
    { path: "test/service.test.ts", content: "import { process } from '../src/service';\ntest('process', () => process({ read: () => 'x' }));\n" },
    { path: "schemas/process.schema.json", content: "{ \"title\": \"process\" }\n" },
    { path: "docs/process.md", content: "The process migration is reviewed separately.\n" },
    { path: "docs/generated.ts", content: "export const oldExample = process({ read: () => 'docs' });\n" },
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
  assert.ok(references.locations.every((item) => !item.path.startsWith("docs/")), "navigation omits documentation paths");
  assert.ok(references.locations.every((item) => !(item.path === "src/caller.ts" && item.lineIndex === 1)), "navigation omits comment-only matches");
  assert.ok(references.locations.every((item) => !(item.path === "src/caller.ts" && item.lineIndex === 2)), "navigation omits string-only matches");

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
  assert.ok(impact.impact?.mentions.some((item) => item.path === "docs/process.md"), "plain documentation matches stay review candidates");
  assert.ok(impact.impact?.callers.every((item) => item.path !== "docs/process.md"), "plain text is not mislabeled as a caller");
  assert.ok([
    ...impact.impact.callers,
    ...impact.impact.dependencies,
    ...impact.impact.tests,
    ...impact.impact.contracts,
    ...impact.impact.mentions,
  ].every((item) => item.evidence === "heuristic"), "fallback provenance is retained on every impact item");
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

test("project navigation filters documentation and comment-only locations returned by an LSP", { timeout: 10_000 }, async () => {
  const root = tempProject();
  const files = [
    { path: "src/app.ts", content: "export const value = target();\n" },
    { path: "src/target.ts", content: "export function target() {}\n" },
    { path: "src/comment.ts", content: "// target is discussed here\n" },
    { path: "docs/target.md", content: "target is documented here\n" },
  ];
  for (const file of files) write(root, file.path, file.content);
  const fake = join(root, "noisy-lsp.mjs");
  writeFileSync(fake, `
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let buffer = Buffer.alloc(0);
const location = (path, character) => ({ uri: pathToFileURL(resolve(process.cwd(), path)).href, range: { start: { line: 0, character }, end: { line: 0, character: character + 6 } } });
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
    const result = message.method === 'initialize' ? { capabilities: {} } : [
      location('src/target.ts', 16),
      location('src/comment.ts', 3),
      location('docs/target.md', 0),
    ];
    send({ jsonrpc: '2.0', id: message.id, result });
  }
});
`);
  const analysis = new ProjectAnalysis(root, {
    files,
    resolveServer: () => ({ family: "typescript", name: "noisy-lsp", command: process.execPath, args: [fake] }),
  });
  try {
    const references = await analysis.query({ kind: "references", path: "src/app.ts", line: 0, column: 24, symbol: "target" });
    assert.equal(references.engine, "lsp");
    assert.deepEqual(references.locations.map((item) => item.path), ["src/target.ts"]);
  } finally {
    analysis.dispose();
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
