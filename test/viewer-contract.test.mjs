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
  for (const id of [REVIEW_ISLAND.meta, REVIEW_ISLAND.i18n, REVIEW_ISLAND.sourceFiles, REVIEW_ISLAND.fileStates, REVIEW_ISLAND.httpEnv]) {
    assert.ok(
      viewerSource.includes(`getElementById('${id}')`) || viewerSource.includes(`getElementById("${id}")`),
      `viewer never reads island id "${id}" — producer/consumer drift`,
    );
  }
});
