// Following a symbol into compiled code.
//
// A JDK class and a class inside a dependency jar are not files: Eclipse JDT answers them as
// `jdt://contents/…` or `jrt:/…`, and until now that was where the jump ended — a one-line "it is
// somewhere in rt.jar", because nothing could produce the text behind such a URI. The server that named
// one can: `java/classFileContents` hands back the library's own source when a sources jar is attached and
// a decompilation when it is not, which is IntelliJ's pair of answers to the same question.
//
// This is the wire test for that chain. A fake server answers a definition with a `jdt://` URI and answers
// the content request for it; the assertions are that the URI is remembered as one this session may read,
// that the right server is chosen for it with no path to classify, and that the text comes back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectAnalysis } from "../dist/analysis.js";
import { isKnownExternalUri, externalUriSampleFile, resetKnownLibraryPaths } from "../dist/lsp.js";
import { externalSourceFile } from "../dist/library-source.js";

const CLASS_URI = "jdt://contents/rt.jar/java.util/List.class?=javalib/%5C/jre%5C/lib%5C/rt.jar";
const DECOMPILED = [
  "package java.util;",
  "",
  "public interface List<E> extends Collection<E> {",
  "  int size();",
  "}",
].join("\n");

const roots = [];
const analyses = [];
after(async () => {
  for (const analysis of analyses) { try { await analysis.dispose?.(); } catch {} }
  for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  resetKnownLibraryPaths();
});

// A server that answers one definition with a non-file URI, and the JDT content request for that URI.
function fakeJdt(root) {
  const file = join(root, "fake-jdt.mjs");
  writeFileSync(file, `
const CLASS_URI = ${JSON.stringify(CLASS_URI)};
const DECOMPILED = ${JSON.stringify(DECOMPILED)};
let buffer = Buffer.alloc(0);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf('\\r\\n\\r\\n');
    if (header < 0) return;
    const length = Number(/content-length: *(\\d+)/i.exec(buffer.slice(0, header).toString())?.[1] ?? 0);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.slice(header + 4, header + 4 + length).toString());
    buffer = buffer.slice(header + 4 + length);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true, textDocumentSync: 1 } } });
    } else if (message.method === 'textDocument/definition') {
      send({ jsonrpc: '2.0', id: message.id, result: [{
        uri: CLASS_URI,
        range: { start: { line: 2, character: 17 }, end: { line: 2, character: 21 } },
      }] });
    } else if (message.method === 'java/classFileContents') {
      send({ jsonrpc: '2.0', id: message.id, result: message.params && message.params.uri === CLASS_URI ? DECOMPILED : null });
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }
});
`);
  return file;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-external-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const content = "package app;\n\npublic class Main {\n  java.util.List<String> names;\n}\n";
  writeFileSync(join(root, "src/Main.java"), content);
  const server = { family: "java", name: "fake-jdt", command: process.execPath, args: [fakeJdt(root)] };
  const analysis = new ProjectAnalysis(root, {
    files: [{ path: "src/Main.java", content }],
    resolveServer: () => server,
    coldQueryBudgetMs: 5000,
  });
  analyses.push(analysis);
  return { root, analysis };
}

test("a scheme the JDT server can read names the sample file that picks that server", () => {
  // A `jdt://` URI carries no path for the language-server resolver to classify, so the scheme itself has
  // to say which language owns it. Anything else is left alone rather than guessed at.
  assert.equal(externalUriSampleFile(CLASS_URI), "Library.java");
  assert.equal(externalUriSampleFile("jrt:/java.base/java/time/Instant.class"), "Library.java");
  assert.equal(externalUriSampleFile("file:///tmp/x.ts"), undefined);
  assert.equal(externalUriSampleFile("not-a-uri"), undefined);
});

test("a URI nobody has answered with is not readable, however well-formed it looks", async () => {
  // The reader is otherwise a "decompile any archive on this disk" channel into a language server.
  resetKnownLibraryPaths();
  const { analysis } = project();
  assert.equal(isKnownExternalUri(CLASS_URI), false);
  assert.equal(await analysis.externalSourceText(CLASS_URI), "");
});

test("a definition in compiled code is remembered, and its text comes back from the server", async () => {
  resetKnownLibraryPaths();
  const { analysis } = project();
  const definition = await analysis.query({ kind: "definition", path: "src/Main.java", line: 4, column: 14 });
  assert.equal(definition.engine, "lsp", `answered by the server (${definition.fallbackReason ?? ""})`);
  const target = definition.locations[0];
  assert.ok(target, "the server answered with a location");
  assert.equal(target.path, CLASS_URI);
  assert.equal(target.external, true, "a non-file target is marked external rather than turned into a path");
  assert.equal(isKnownExternalUri(CLASS_URI), true, "and is now a URI this session may read");

  const text = await analysis.externalSourceText(CLASS_URI);
  assert.equal(text, DECOMPILED, "the class-file contents request answered");

  // What get-source hands the page for it.
  const record = externalSourceFile(CLASS_URI, text);
  assert.equal(record.path, CLASS_URI, "keyed by what the renderer asked for");
  assert.equal(record.library, true, "and opens read-only, like any other library file");
  assert.equal(record.language, "java");
  assert.equal(record.content, DECOMPILED);
  assert.equal(record.name, "List.class", "the tab is named after the entry, not the whole URI");
});
