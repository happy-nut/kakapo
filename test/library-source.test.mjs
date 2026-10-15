// Library navigation: ⌘↓ on a symbol from a dependency used to go nowhere. Two separate things stopped it —
// a definition outside the review root was dropped on the way out of the language server, and one inside
// node_modules survived that but had no record to paint, because the project index skips node_modules on
// purpose. These pin both halves, plus the boundary: the renderer may follow a definition anywhere a server
// points, and may not name a file of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerReviewIpc } from "../dist/app-review-ipc.js";
import { normalizeLocationResult, isKnownLibraryPath, resetKnownLibraryPaths } from "../dist/lsp.js";

function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
  };
}

function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kakapo-library-")));
  const ipc = fakeIpc();
  const state = {
    options: { root, staged: false },
    signature: "sig",
    bodyDiffs: [],
    bodyCache: new Map(),
    sourceFiles: new Map(),
    analysis: {},
    perf: { mark() {} },
  };
  registerReviewIpc(ipc, () => state);
  return { root, ipc, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function locationFor(absolutePath, root) {
  return normalizeLocationResult(
    { uri: pathToFileURL(absolutePath).href, range: { start: { line: 4, character: 2 }, end: { line: 5, character: 0 } } },
    root,
  );
}

test("a definition in node_modules opens even though the index skips node_modules", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(h.root, "node_modules", "left-pad", "index.d.ts"), "export default function leftPad(): string;\n");

    const [location] = locationFor(join(h.root, "node_modules", "left-pad", "index.d.ts"), h.root);
    assert.equal(location.path, "node_modules/left-pad/index.d.ts", "a path under the root stays relative to it");
    assert.equal(location.library, undefined, "it is not a library location — it is inside the review root");

    assert.equal(h.state.sourceFiles.has(location.path), false, "the project index does not hold it");
    const record = await h.ipc.invoke("kakapo:get-source", { path: location.path });
    assert.ok(record, "get-source serves it anyway");
    assert.equal(record.library, true, "as a read-only library record");
    assert.match(record.content, /leftPad/, "with its real contents");
    assert.equal(h.state.sourceFiles.has(location.path), false, "and it still does not join the index");
  } finally {
    h.cleanup();
  }
});

test("a definition outside the review root opens by absolute path", async () => {
  const h = harness();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "kakapo-stdlib-")));
  try {
    resetKnownLibraryPaths();
    const stub = join(outside, "lib.es2022.d.ts");
    writeFileSync(stub, "interface Array<T> { at(index: number): T | undefined; }\n");

    const [location] = locationFor(stub, h.root);
    assert.equal(location.library, true, "it is reported as a library location");
    assert.equal(location.path, stub, "addressed absolutely, because no relative path can name it");
    assert.equal(location.endColumn, 0, "a range ending at character 0 keeps that 0");
    assert.equal(isKnownLibraryPath(stub), true, "and the path is remembered as one a server reported");

    const record = await h.ipc.invoke("kakapo:get-source", { path: stub });
    assert.ok(record, "get-source serves it");
    assert.equal(record.library, true);
    assert.match(record.content, /interface Array/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    h.cleanup();
  }
});

test("an absolute path no language server reported is refused", async () => {
  const h = harness();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "kakapo-secret-")));
  try {
    resetKnownLibraryPaths();
    const secret = join(outside, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY MATERIAL\n");

    assert.equal(await h.ipc.invoke("kakapo:get-source", { path: secret }), null, "the renderer cannot name a file itself");

    // Positive control: the same path, once a server has actually pointed at it, does open — so the refusal
    // above is the allow-list working and not the file being unreadable for some other reason.
    locationFor(secret, h.root);
    const record = await h.ipc.invoke("kakapo:get-source", { path: secret });
    assert.ok(record && record.library, "a path a server reported is served");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    h.cleanup();
  }
});

test("a relative path still cannot escape the review root", async () => {
  const h = harness();
  try {
    assert.equal(await h.ipc.invoke("kakapo:get-source", { path: "../../../etc/passwd" }), null);
    assert.equal(await h.ipc.invoke("kakapo:get-source", { path: "node_modules/../../etc/passwd" }), null);
  } finally {
    h.cleanup();
  }
});
