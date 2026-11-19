import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openSymbolCache } from "../dist/analysis-cache.js";
import { buildProjectIndex, buildRegexSymbolIndexChunked, indexableContent, indexablePath } from "../dist/analysis-index.js";
import { findRipgrepBinary } from "../dist/search.js";

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(process.argv[at + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} needs a number`);
  return value;
}

const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--") && !/^-?\d/.test(argument));
const repeat = flag("--repeat", 3);
const changedCount = flag("--changed", 25);
const asJson = process.argv.includes("--json");

function walk(root) {
  const rg = findRipgrepBinary();
  if (!rg) throw new Error("ripgrep not found; the app's walk cannot be reproduced");
  return new Promise((done) => {
    const child = spawn(rg, ["--files", "--hidden", "--no-messages", "-g", "!.git/**"], {
      cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => done([]));
    child.once("close", () => done(output.split(/\r?\n/)
      .map((path) => path.trim().replace(/\\/g, "/"))
      .filter((path) => path && indexablePath(path))
      .slice(0, 30_000)));
  });
}

async function readAll(root, paths) {
  const files = [];
  for (let offset = 0; offset < paths.length; offset += 32) {
    const loaded = await Promise.all(paths.slice(offset, offset + 32).map(async (path) => {
      try {
        const content = await readFile(join(root, path), "utf8");
        return indexableContent(content) ? { path, content } : undefined;
      } catch { return undefined; }
    }));
    for (const file of loaded) if (file) files.push(file);
    await new Promise((next) => setImmediate(next));
  }
  return files;
}

function instrument(cache) {
  const spent = { key: 0, get: 0, put: 0, flush: 0 };
  const wrap = (name, fn) => (...args) => {
    const started = performance.now();
    try { return fn(...args); } finally { spent[name] += performance.now() - started; }
  };
  return {
    spent,
    cache: {
      entryKey: wrap("key", (path, content) => cache.entryKey(path, content)),
      get: wrap("get", (key, path, lines) => cache.get(key, path, lines)),
      put: wrap("put", (key, records) => cache.put(key, records)),
      flush: wrap("flush", () => cache.flush()),
      stats: () => cache.stats(),
    },
  };
}

function signature(index) {
  const rows = index.symbols
    .map((record) => `${record.path}:${record.lineIndex}:${record.column}:${record.name}:${record.symbolKind}:${record.container ?? ""}`)
    .sort();
  return `${rows.length}/${createHash("sha1").update(rows.join("\n")).digest("hex").slice(0, 16)}`;
}

async function run(root, cacheFile) {
  const walkStarted = performance.now();
  const paths = await walk(root);
  const walkMs = performance.now() - walkStarted;

  const readStarted = performance.now();
  const files = await readAll(root, paths);
  const readMs = performance.now() - readStarted;

  const { cache, spent } = instrument(openSymbolCache(cacheFile));
  const buildStarted = performance.now();
  const index = await buildRegexSymbolIndexChunked(files, undefined, cache);
  const buildMs = performance.now() - buildStarted;
  const stats = cache.stats();

  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.content.length, 0),
    walkMs, readMs,
    hashMs: spent.key,
    cacheGetMs: spent.get,
    scanMs: buildMs - spent.key - spent.get - spent.put - spent.flush,
    cachePutMs: spent.put,
    flushMs: spent.flush,
    totalMs: walkMs + readMs + buildMs,
    hits: stats.hits, misses: stats.misses,
    signature: signature(index),
  };
}

const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

function summarise(name, runs) {
  const pick = (field) => Math.round(median(runs.map((entry) => entry[field])) * 10) / 10;
  const signatures = new Set(runs.map((entry) => entry.signature));
  return {
    mode: name,
    files: runs[0].files,
    mb: Math.round(runs[0].bytes / 1024 / 1024 * 10) / 10,
    walk: pick("walkMs"), read: pick("readMs"), hash: pick("hashMs"),
    get: pick("cacheGetMs"), scan: pick("scanMs"), put: pick("cachePutMs"), flush: pick("flushMs"),
    total: pick("totalMs"),
    hits: runs[0].hits, misses: runs[0].misses,
    signature: signatures.size === 1 ? runs[0].signature : `UNSTABLE ${[...signatures].join(" ")}`,
  };
}

const results = [];
for (const given of roots) {
  const root = resolve(given);
  const scratch = mkdtempSync(join(tmpdir(), "kakapo-index-bench-"));
  const cacheFile = join(scratch, "symbols.json");
  const sibling = join(scratch, "sibling");
  let siblingMade = false;
  try {
    const cold = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      rmSync(cacheFile, { force: true });
      cold.push(await run(root, cacheFile));
    }
    const warm = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) warm.push(await run(root, cacheFile));

    const rows = [summarise("cold", cold), summarise("warm", warm)];

    try {
      execFileSync("git", ["worktree", "add", "--detach", "-q", sibling, "HEAD"], { cwd: root, stdio: "pipe" });
      siblingMade = true;
    } catch { }
    if (siblingMade) {
      const siblingCold = join(scratch, "sibling-cold.json");
      rows.push(summarise("sibling, own cache", [await run(sibling, siblingCold)]));
      const siblingRuns = [];
      for (let attempt = 0; attempt < repeat; attempt += 1) siblingRuns.push(await run(sibling, cacheFile));
      rows.push(summarise("sibling, shared cache", siblingRuns));

      const targets = (await walk(sibling)).slice(0, changedCount);
      for (const path of targets) {
        const file = join(sibling, path);
        writeFileSync(file, `${await readFile(file, "utf8")}\nconst benchTouched${Math.random().toString(36).slice(2, 8)} = 1;\n`);
      }
      const unaware = readFileSync(cacheFile);
      const changed = [];
      const touched = targets.length;
      for (let attempt = 0; attempt < repeat; attempt += 1) {
        writeFileSync(cacheFile, unaware);
        changed.push(await run(sibling, cacheFile));
      }
      rows.push(summarise(`${touched} changed, shared cache`, changed));
      rows.push(summarise(`${touched} changed, own cache`, [await run(sibling, join(scratch, "changed-cold.json"))]));
    }

    const real = await buildProjectIndex(root, openSymbolCache(cacheFile));
    const faithful = signature(real) === rows[0].signature;
    const find = (mode) => rows.find((row) => row.mode === mode);
    const checks = [
      ["the harness reproduces buildProjectIndex", faithful],
      ["a served index equals a scanned one", find("cold").signature === find("warm").signature],
      ["no run disagreed with its own repeats", rows.every((row) => !row.signature.startsWith("UNSTABLE"))],
    ];
    if (siblingMade) {
      checks.push(["a sibling worktree served from the shared cache equals one that scanned for itself",
        find("sibling, own cache").signature === find("sibling, shared cache").signature]);
      const changedShared = rows.find((row) => row.mode.endsWith("changed, shared cache"));
      const changedOwn = rows.find((row) => row.mode.endsWith("changed, own cache"));
      checks.push(["text a worktree edited is never served from what the cache held for it",
        changedShared.signature === changedOwn.signature]);
    }
    results.push({ root, faithful, realSignature: signature(real), checks, rows });
  } finally {
    if (siblingMade) { try { execFileSync("git", ["worktree", "remove", "--force", sibling], { cwd: root, stdio: "pipe" }); } catch { } }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(`\n${result.root}`);
    for (const [claim, held] of result.checks) console.log(`  ${held ? "ok  " : "FAIL"} ${claim}`);
    const header = ["mode", "files", "MB", "walk", "read", "hash", "get", "scan", "put", "flush", "total", "hit/miss", "symbols"];
    const table = result.rows.map((row) => [
      row.mode, String(row.files), String(row.mb), String(row.walk), String(row.read), String(row.hash),
      String(row.get), String(row.scan), String(row.put), String(row.flush), String(row.total),
      `${row.hits}/${row.misses}`, row.signature,
    ]);
    const widths = header.map((cell, column) => Math.max(cell.length, ...table.map((row) => row[column].length)));
    const line = (cells) => "  " + cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    console.log(line(header));
    for (const row of table) console.log(line(row));
  }
}

const failed = results.flatMap((result) => result.checks.filter(([, held]) => !held).map(([claim]) => `${result.root}: ${claim}`));
if (failed.length) {
  for (const claim of failed) console.error(`index-bench: ${claim}`);
  process.exit(1);
}
