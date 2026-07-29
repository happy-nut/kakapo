// The build->viewer JSON islands are the one untyped seam between the TS producer (render.ts) and the
// plain-JS viewer. render.ts now emits ids from the typed REVIEW_ISLAND contract; the viewer still reads
// them as literal strings. Assert those literals still match the contract so the two sides can't drift —
// e.g. renaming an island id in the contract without updating the viewer would fail here, not silently in
// production (where getElementById would just return null and the payload would read as empty).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_ISLAND } from "../dist/viewer-contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = join(HERE, "..", "src", "viewer");
const viewerSource = readdirSync(VIEWER_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join(VIEWER_DIR, f), "utf8"))
  .join("\n");

test("every review island id the viewer reads matches the typed contract", () => {
  // The data islands the viewer parses on boot (01-core.js). xterm is injected differently (terminal slice),
  // so assert the five JSON islands here; a drift on any of them silently empties that payload in production.
  for (const id of [REVIEW_ISLAND.meta, REVIEW_ISLAND.i18n, REVIEW_ISLAND.sourceFiles, REVIEW_ISLAND.fileStates, REVIEW_ISLAND.httpEnv]) {
    assert.ok(
      viewerSource.includes(`getElementById('${id}')`) || viewerSource.includes(`getElementById("${id}")`),
      `viewer never reads island id "${id}" — producer/consumer drift`,
    );
  }
});
