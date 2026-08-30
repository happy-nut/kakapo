// CORE USER FLOW: the codebase map. The explain-codebase agent calls the kakapo_map MCP tool with an
// archify architecture IR; the tool validates, renders, injects the click-to-navigate bridge, and drops
// map.html next to the shared knowledge file where the briefing panel's iframe picks it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMap, mapFilePath, MAP_TOOL, handleRpc } from "../dist/mcp-server.js";

const ir = JSON.parse(readFileSync(new URL("./fixtures/map.architecture.json", import.meta.url), "utf8"));
const sources = {
  viewer: "src/viewer/01-core.js:1",
  main: "src/app-main.ts:1",
  lsp: "src/lsp.ts:1",
  knowledge: "src/mcp-server.ts:1",
  agent: "src/ask-session.ts:1",
};

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-map-test-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("a valid IR lands as map.html carrying every source and the nav bridge", () => {
  const root = tempRepo();
  try {
    const outcome = renderMap(root, { ir, sources });
    assert.equal(outcome.ok, true, outcome.message);
    const html = readFileSync(mapFilePath(root), "utf8");
    assert.match(html, /data-node-id/); // archify's nodes are there to click
    assert.match(html, /KAKAPO_MAP_SOURCES/); // …and the bridge script rode along
    for (const at of Object.values(sources)) assert.ok(html.includes(at), `missing source ${at}`);
    assert.match(html, /kakapoMapReady/);
    assert.match(html, /kakapoNav/);
    // The tool answers over RPC exactly like the two word tools do.
    const listed = handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, root);
    assert.ok(listed.result.tools.some((t) => t.name === MAP_TOOL.name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken IR renders nothing and comes back as repair diagnostics", () => {
  const root = tempRepo();
  try {
    // Remove the overlap fix the fixture carries — archify's layout validator must reject it again.
    const broken = structuredClone(ir);
    delete broken.connections[1].labelDy;
    const outcome = renderMap(root, { ir: broken, sources });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /overlaps/); // the diagnostic names the actual problem…
    assert.doesNotMatch(outcome.message, /^\s+at /m); // …without the stack-trace noise
    assert.throws(() => readFileSync(mapFilePath(root)), /ENOENT/);

    // And a component with no source entry is refused before archify even runs.
    const missing = renderMap(root, { ir, sources: { ...sources, main: undefined } });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /missing: main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
