import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedArchiveNames, pruneDownloadCache } from "../scripts/install-language-servers.mjs";

const script = fileURLToPath(new URL("../scripts/install-language-servers.mjs", import.meta.url));

function scratch() {
  return mkdtempSync(join(tmpdir(), "kakapo-lsp-cache-test-"));
}

test("every archive table the installer declares is one the pinned set reads", () => {
  const source = readFileSync(script, "utf8");
  const declared = [...source.matchAll(/^const (\w+_ARCHIVES) = /gm)].map((m) => m[1]).sort();
  const registered = source
    .match(/const ARCHIVE_TABLES = Object\.freeze\(\[([^\]]*)\]/)[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(registered, declared,
    "a table left out of ARCHIVE_TABLES has its archive deleted from the cache on every install");
  assert.ok(declared.length >= 7, `the installer still declares a table per family: ${declared.join(", ")}`);
});

test("the pinned set names an archive for every family and both targets", () => {
  const names = pinnedArchiveNames();
  assert.ok(names.has("rustup-init"), "rustup's installer binary is a cache entry too");
  assert.ok([...names].some((name) => name.startsWith("jdt-language-server-")), "jdtls is cached by its versioned name");
  assert.ok(names.has("phpactor.phar"), "phpactor is cached under an unversioned name");
  for (const marker of ["go1", "rust-analyzer-", "clangd-mac-", "kotlin-server-", "OpenJDK21U-", ".sorbet", "php-"]) {
    assert.ok([...names].some((name) => name.includes(marker)), `${marker} has a pinned archive name`);
  }
});

test("pruning removes the archives no pin names and keeps the ones that do", () => {
  const cache = scratch();
  try {
    const pinned = [...pinnedArchiveNames()];
    for (const name of pinned) writeFileSync(join(cache, name), "x");
    writeFileSync(join(cache, "kotlin-server-263.7084.0-aarch64.sit"), "y".repeat(1024));
    writeFileSync(join(cache, "go1.21.0.darwin-arm64.tar.gz"), "z".repeat(512));
    mkdirSync(join(cache, "a-directory"));

    const result = pruneDownloadCache(cache);

    assert.deepEqual(result.removed.map((item) => item.name).sort(),
      ["go1.21.0.darwin-arm64.tar.gz", "kotlin-server-263.7084.0-aarch64.sit"]);
    assert.equal(result.bytes, 1536);
    assert.deepEqual(readdirSync(cache).sort(), ["a-directory", ...pinned].sort(),
      "a directory in the cache and every pinned archive survive");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("pruning a cache that was never created is a no-op", () => {
  const cache = scratch();
  rmSync(cache, { recursive: true, force: true });
  assert.deepEqual(pruneDownloadCache(cache), { removed: [], bytes: 0 });
});
