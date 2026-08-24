#!/usr/bin/env node
// Measure the Kakapo GPU helper honestly.
//
// Two mistakes were already made measuring this by hand, and both are guarded here rather than remembered:
//
//   1. UNITS. `footprint` prints "7761 KB" and "1062 MB" in the same column. Reading the number without its
//      unit turned a 7.6 MB network service into a claimed 7.8 GB.
//   2. THE WRONG PROCESS. `pgrep -f gpu-process` matches every Electron app on the machine. A reading of
//      "1187 MB / 185 tiles" was Slack's.
//
// A third is guarded because it is the same shape: `vmmap` prints IOSurface twice — once per mapped surface
// (with an address range) and once as a region-type TOTAL (without one). Counting both together turned a
// 631 MB total into a claimed single 606 MB surface.
//
// `selftest` exercises all three against fixtures, including positive controls, so an absence proved here is
// a real absence.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const APP = "/Applications/Kakapo.app";
const APP_BIN_MARK = "Kakapo.app/Contents/Frameworks/Kakapo Helper";

// ---------------------------------------------------------------- units

const UNIT = { B: 1, K: 1024, KB: 1024, M: 1024 ** 2, MB: 1024 ** 2, G: 1024 ** 3, GB: 1024 ** 3 };

/** "941 MB" / "7761 KB" / "1.2G" / "7344K" -> bytes. Returns null when there is no unit to trust. */
export function parseSize(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^([\d.]+)\s*(B|KB|K|MB|M|GB|G)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = UNIT[m[2].toUpperCase()];
  return unit ? Math.round(n * unit) : null;
}

const mb = (bytes) => (bytes == null ? null : +(bytes / 1024 ** 2).toFixed(1));

// ---------------------------------------------------------------- process selection

function psLines() {
  return execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Only helpers living inside THIS app bundle. A bare "gpu-process" match is every Electron app on the Mac. */
export function selectKakapoHelpers(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, args] = m;
    if (!args.includes(APP_BIN_MARK)) continue;
    const type = args.match(/--type=([a-z-]+)/)?.[1] ?? "";
    out.push({ pid: Number(pid), type, args });
  }
  return out;
}

export function selectKakapoMain(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, args] = m;
    // The main process runs the app binary itself with no --type. The language servers run the SAME binary
    // under ELECTRON_RUN_AS_NODE with a script path after it — which is how tsserver was first mistaken for a
    // second main process. A trailing script argument, not a substring anywhere in the line, is the tell.
    if (!/\/Applications\/Kakapo\.app\/Contents\/MacOS\/Kakapo(\s|$)/.test(args)) continue;
    if (/--type=/.test(args)) continue;
    const trailing = args.split(/\s+/).slice(1);
    if (trailing.some((t) => /\.(?:c|m)?js$/.test(t) || t.includes("node_modules"))) continue;
    out.push({ pid: Number(pid), args });
  }
  return out;
}

function gpuPid() {
  const gpu = selectKakapoHelpers(psLines()).filter((p) => p.type === "gpu-process");
  if (gpu.length !== 1) return { pid: null, count: gpu.length };
  return { pid: gpu[0].pid, count: 1 };
}

// ---------------------------------------------------------------- footprint

/** Parse `footprint -p <pid>`: the header total plus the per-category dirty column, all unit-aware. */
export function parseFootprint(text) {
  const total = parseSize(text.match(/Footprint:\s*([\d.]+\s*[KMGB]+)/)?.[1] ?? "");
  const categories = {};
  for (const line of text.split("\n")) {
    // "  490 MB        0 B          0 B        225    Owned physical footprint (unmapped) (graphics)"
    const m = line.match(/^\s*([\d.]+\s*[KMGB]+)\s+[\d.]+\s*[KMGB]+\s+[\d.]+\s*[KMGB]+\s+(\d+)\s{2,}(\S.*?)\s*$/);
    if (!m) continue;
    const bytes = parseSize(m[1]);
    if (bytes == null) continue;
    categories[m[3]] = { bytes, regions: Number(m[2]) };
  }
  return { total, categories };
}

function footprintOf(pid) {
  try {
    return parseFootprint(execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return { total: null, categories: {} };
  }
}

// ---------------------------------------------------------------- vmmap surfaces

/**
 * Individual mapped IOSurfaces only. A detail line carries an address range and (usually) a SurfaceID; the
 * region-type summary line at the end of vmmap carries neither, and adding it to the details double-counts
 * the whole category.
 */
export function parseSurfaces(text) {
  const surfaces = [];
  for (const line of text.split("\n")) {
    if (!/^IOSurface\b/.test(line)) continue;
    if (!/\b[0-9a-f]{6,}-[0-9a-f]{6,}\b/.test(line)) continue; // summary row: no address range
    const bytes = parseSize(line.match(/\[\s*([\d.]+\s*[KMGB]+)/)?.[1] ?? "");
    const dim = line.match(/(\d+)x(\d+)\s*\(([A-Za-z0-9]+)\)/);
    surfaces.push({
      bytes,
      w: dim ? Number(dim[1]) : null,
      h: dim ? Number(dim[2]) : null,
      format: dim ? dim[3] : null,
    });
  }
  return surfaces;
}

function surfacesOf(pid) {
  try {
    return parseSurfaces(execFileSync("vmmap", [String(pid)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- sampling

function sampleOnce() {
  const lines = psLines();
  const helpers = selectKakapoHelpers(lines);
  const main = selectKakapoMain(lines);
  const gpu = helpers.filter((p) => p.type === "gpu-process");
  const renderers = helpers.filter((p) => p.type === "renderer");
  const at = Date.now();
  if (gpu.length !== 1) return { at, gpuPid: null, gpuCount: gpu.length, renderers: renderers.length };
  const fp = footprintOf(gpu[0].pid);
  return {
    at,
    gpuPid: gpu[0].pid,
    gpuCount: 1,
    gpuFootprint: fp.total,
    ioSurface: fp.categories.IOSurface?.bytes ?? 0,
    ioSurfaceRegions: fp.categories.IOSurface?.regions ?? 0,
    unmappedGraphics: fp.categories["Owned physical footprint (unmapped) (graphics)"]?.bytes ?? 0,
    ioAccelerator: fp.categories["IOAccelerator (graphics)"]?.bytes ?? 0,
    mainPid: main[0]?.pid ?? null,
    mainFootprint: main[0] ? footprintOf(main[0].pid).total : null,
    renderers: renderers.length,
    rendererFootprints: renderers.map((r) => footprintOf(r.pid).total),
  };
}

async function sample(outPath, seconds, intervalMs) {
  const samples = [];
  const until = Date.now() + seconds * 1000;
  process.stderr.write(`sampling for ${seconds}s -> ${outPath}\n`);
  while (Date.now() < until) {
    const s = sampleOnce();
    samples.push(s);
    process.stderr.write(
      `  t=${String(Math.round((s.at - samples[0].at) / 1000)).padStart(4)}s renderers=${s.renderers} ` +
        `gpu=${mb(s.gpuFootprint) ?? "-"}MB io=${mb(s.ioSurface) ?? "-"}MB unmapped=${mb(s.unmappedGraphics) ?? "-"}MB\n`,
    );
    const wait = intervalMs - (Date.now() - s.at);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  writeFileSync(outPath, JSON.stringify({ kind: "series", samples }, null, 1));
  process.stderr.write(`wrote ${samples.length} samples\n`);
}

function snapshot(outPath) {
  const { pid, count } = gpuPid();
  if (!pid) {
    console.log(`no single Kakapo gpu-process (found ${count})`);
    process.exit(1);
  }
  const raw = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const fp = parseFootprint(raw);
  const surfaces = surfacesOf(pid);
  const byDim = {};
  for (const s of surfaces) {
    const key = s.w ? `${s.w}x${s.h} ${s.format}` : "unsized";
    byDim[key] = byDim[key] || { count: 0, bytes: 0 };
    byDim[key].count += 1;
    byDim[key].bytes += s.bytes ?? 0;
  }
  const out = {
    kind: "attribution",
    at: Date.now(),
    gpuPid: pid,
    footprintTotal: fp.total,
    categories: fp.categories,
    surfaceCount: surfaces.length,
    surfaceBytes: surfaces.reduce((a, s) => a + (s.bytes ?? 0), 0),
    byDim,
    renderers: selectKakapoHelpers(psLines()).filter((p) => p.type === "renderer").length,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`gpu ${pid}: footprint ${mb(out.footprintTotal)}MB, ${out.surfaceCount} surfaces = ${mb(out.surfaceBytes)}MB`);
  for (const [k, v] of Object.entries(byDim).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10)) {
    console.log(`  ${String(v.count).padStart(4)} x ${k.padEnd(20)} ${mb(v.bytes)}MB`);
  }
}

// ---------------------------------------------------------------- gate oracles

function readJson(p) {
  if (!existsSync(p)) fail(`missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}

function verifyInstall() {
  const bundle = `${APP}/Contents/Resources/app/dist/viewer.client.js`;
  const css = `${APP}/Contents/Resources/app/dist/viewer.css`;
  if (!existsSync(bundle)) fail(`no installed bundle at ${bundle}`);
  const js = readFileSync(bundle, "utf8");
  const style = readFileSync(css, "utf8");
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim();

  const required = [
    ["matchCompositionDim", js, "composing glyph matches its cell's dimness"],
    ["setCursorHiddenForComposition", js, "caret stands down for a composition"],
    ["rail-pinning", js, "terminal holds its fit through the rail animation"],
    ["--terminal-bg", js, "terminal palette published for the overlay"],
    ["composition-view", style, "composition overlay restyled"],
    ["is-dim", style, "dim variant of the overlay"],
  ];
  const missing = required.filter(([needle, hay]) => !hay.includes(needle)).map(([n]) => n);
  // The reverted GPU release must NOT be there — this is the blank-pane regression.
  const forbidden = ["releasePaneWebgl", "restorePaneWebgl", "webglReleased"].filter((n) => js.includes(n));

  console.log(`HEAD ${head}, src dirty: ${dirty ? "yes" : "no"}`);
  console.log(`missing: ${missing.length ? missing.join(",") : "none"}`);
  console.log(`forbidden present: ${forbidden.length ? forbidden.join(",") : "none"}`);
  if (dirty) fail("src/ has uncommitted changes; install would not match HEAD");
  if (missing.length) fail(`installed bundle is missing: ${missing.join(", ")}`);
  if (forbidden.length) fail(`installed bundle still contains the reverted GPU release: ${forbidden.join(", ")}`);
  console.log("INSTALL_OK");
}

function seriesCheck(p) {
  const { samples } = readJson(p);
  if (!Array.isArray(samples) || samples.length < 20) fail(`need >= 20 samples, got ${samples?.length}`);
  const good = samples.filter((s) => s.gpuPid && s.gpuFootprint != null);
  if (good.length < 15) fail(`need >= 15 samples with a resolved gpu footprint, got ${good.length}`);
  const counts = new Set(good.map((s) => s.renderers));
  if (counts.size < 2) fail(`the controlled variable never moved: renderer counts seen = ${[...counts]}`);
  const span = (good.at(-1).at - good[0].at) / 1000;
  console.log(`${good.length} usable samples over ${span.toFixed(0)}s, renderer counts ${[...counts].sort((a, b) => a - b)}`);
  console.log("SERIES_OK");
}

function marginal(p) {
  const { samples } = readJson(p);
  const good = samples.filter((s) => s.gpuPid && s.gpuFootprint != null);
  // Median footprint at each renderer count, so a mid-paint spike cannot set the slope.
  const byCount = new Map();
  for (const s of good) {
    if (!byCount.has(s.renderers)) byCount.set(s.renderers, []);
    byCount.get(s.renderers).push(s);
  }
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const rows = [...byCount.entries()]
    .map(([n, ss]) => ({
      renderers: n,
      n: ss.length,
      gpuMB: mb(median(ss.map((s) => s.gpuFootprint))),
      ioMB: mb(median(ss.map((s) => s.ioSurface))),
      unmappedMB: mb(median(ss.map((s) => s.unmappedGraphics))),
    }))
    .sort((a, b) => a.renderers - b.renderers);
  console.log("renderers  n   gpuMB    ioMB  unmappedMB");
  for (const r of rows) {
    console.log(
      `${String(r.renderers).padStart(9)} ${String(r.n).padStart(3)} ${String(r.gpuMB).padStart(7)} ${String(r.ioMB).padStart(7)} ${String(r.unmappedMB).padStart(11)}`,
    );
  }
  const usable = rows.filter((r) => r.n >= 2);
  if (usable.length < 2) fail(`need >= 2 renderer counts with >= 2 samples each, got ${usable.length}`);
  const lo = usable[0], hi = usable.at(-1);
  const dRend = hi.renderers - lo.renderers;
  if (dRend <= 0) fail("renderer count did not increase across the series");
  const perRenderer = (hi.gpuMB - lo.gpuMB) / dRend;
  const ioPer = (hi.ioMB - lo.ioMB) / dRend;
  console.log(`marginal: ${perRenderer.toFixed(1)} MB per renderer (IOSurface ${ioPer.toFixed(1)} MB of it)`);
  console.log(`baseline at ${lo.renderers} renderers: ${lo.gpuMB} MB`);
  console.log("MARGINAL_OK");
}

function attribute(p) {
  const a = readJson(p);
  if (!a.footprintTotal) fail("no footprint total captured");
  const cats = Object.entries(a.categories)
    .map(([name, v]) => ({ name, ...v }))
    .sort((x, y) => y.bytes - x.bytes);
  console.log(`gpu footprint ${mb(a.footprintTotal)}MB across ${a.renderers} renderers`);
  for (const c of cats.slice(0, 6)) console.log(`  ${mb(c.bytes).toString().padStart(7)}MB  ${String(c.regions).padStart(5)} regions  ${c.name}`);
  const io = a.categories.IOSurface?.bytes ?? 0;
  if (!io) fail("no IOSurface category in the footprint output");
  // The reconciliation that catches the summary-vs-detail double count: individually mapped surfaces must
  // account for the category, not exceed it and not fall far short of it.
  const ratio = a.surfaceBytes / io;
  console.log(`IOSurface category ${mb(io)}MB vs ${a.surfaceCount} mapped surfaces totalling ${mb(a.surfaceBytes)}MB (ratio ${ratio.toFixed(2)})`);
  if (!(ratio > 0.6 && ratio < 1.4)) fail(`surfaces do not reconcile with the category (ratio ${ratio.toFixed(2)}) — parsing is wrong`);
  const top = cats[0];
  const share = top.bytes / a.footprintTotal;
  console.log(`dominant category: ${top.name} at ${(share * 100).toFixed(0)}% of the footprint`);
  if (share < 0.25) fail(`no category dominates (largest is ${(share * 100).toFixed(0)}%) — attribution is inconclusive`);
  console.log("ATTRIBUTION_OK");
}

function trend(p) {
  const { samples } = readJson(p);
  const good = samples.filter((s) => s.gpuPid && s.gpuFootprint != null);
  if (good.length < 20) fail(`need >= 20 samples, got ${good.length}`);
  const counts = new Set(good.map((s) => s.renderers));
  if (counts.size !== 1) fail(`the workspace count must be FIXED for a trend; saw ${[...counts]}`);
  const span = (good.at(-1).at - good[0].at) / 1000;
  if (span < 120) fail(`need >= 120s of samples at a fixed count, got ${span.toFixed(0)}s`);
  const first = good.slice(0, Math.max(3, Math.floor(good.length / 4)));
  const last = good.slice(-Math.max(3, Math.floor(good.length / 4)));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a0 = avg(first.map((s) => s.gpuFootprint));
  const a1 = avg(last.map((s) => s.gpuFootprint));
  const deltaMB = mb(a1 - a0);
  const perMin = deltaMB / (span / 60);
  const verdict = Math.abs(perMin) < 5 ? "STEADY" : perMin > 0 ? "GROWING" : "SHRINKING";
  console.log(`${good.length} samples over ${span.toFixed(0)}s at ${[...counts][0]} renderers`);
  console.log(`first quarter ${mb(a0)}MB -> last quarter ${mb(a1)}MB (${deltaMB > 0 ? "+" : ""}${deltaMB}MB, ${perMin.toFixed(1)}MB/min)`);
  console.log(`verdict: ${verdict}`);
  console.log("TREND_OK");
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  // 1. units — the 7761 KB / 7.8 GB mistake
  eq("KB stays KB", parseSize("7761 KB"), 7761 * 1024);
  eq("MB is MB", parseSize("1062 MB"), 1062 * 1024 ** 2);
  eq("K suffix", parseSize("7344K"), 7344 * 1024);
  eq("decimal MB", parseSize("606.3M"), Math.round(606.3 * 1024 ** 2));
  eq("no unit is not a number", parseSize("7761"), null);
  checks.push({ name: "KB is not read as MB", ok: parseSize("7761 KB") < parseSize("8 MB"), got: parseSize("7761 KB"), want: "< 8MB" });

  // 2. process selection — the Slack mistake. Positive control included, so the rejection is meaningful.
  const psFixture = [
    "1179 /Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=gpu-process",
    "31532 /Applications/Kakapo.app/Contents/Frameworks/Kakapo Helper.app/Contents/MacOS/Kakapo Helper --type=gpu-process --x",
    "31543 /Applications/Kakapo.app/Contents/Frameworks/Kakapo Helper (Renderer).app/Contents/MacOS/Kakapo Helper (Renderer) --type=renderer",
    "94405 /Applications/Kakapo.app/Contents/MacOS/Kakapo",
    "18496 /Applications/Kakapo.app/Contents/MacOS/Kakapo /Users/x/node_modules/typescript/lib/tsserver.js",
  ];
  const helpers = selectKakapoHelpers(psFixture);
  eq("slack gpu rejected", helpers.filter((h) => h.pid === 1179).length, 0);
  eq("kakapo gpu found (positive control)", helpers.filter((h) => h.type === "gpu-process").map((h) => h.pid), [31532]);
  eq("kakapo renderer found", helpers.filter((h) => h.type === "renderer").map((h) => h.pid), [31543]);
  eq("main found", selectKakapoMain(psFixture).map((m) => m.pid), [94405]);
  eq("language server is not the main process", selectKakapoMain(psFixture).filter((m) => m.pid === 18496).length, 0);

  // 3. vmmap summary vs detail — the "single 606 MB surface" mistake
  const vmFixture = [
    "IOSurface                   13e980000-13f0ac000    [ 7344K  7344K  7344K     0K] rw-/rw- SM=SHM PURGE=N  SurfaceID: 0x206  3456x544 (BGRA) 7344K  'Electron Framework'",
    "IOSurface                   1350bc000-1357e8000    [ 7216K  7216K  7216K     0K] rw-/rw- SM=SHM PURGE=N  SurfaceID: 0x217  3392x544 (BGRA) 7208K  'Electron Framework'",
    "IOSurface                          606.3M   606.3M   606.3M       0K",
  ].join("\n");
  const surfaces = parseSurfaces(vmFixture);
  eq("summary row excluded", surfaces.length, 2);
  eq("detail sizes parsed", surfaces.map((s) => s.bytes), [7344 * 1024, 7216 * 1024]);
  eq("dimensions parsed", surfaces.map((s) => `${s.w}x${s.h}`), ["3456x544", "3392x544"]);
  checks.push({
    name: "total is not inflated by the summary row",
    ok: surfaces.reduce((a, s) => a + s.bytes, 0) < parseSize("606.3M"),
    got: surfaces.reduce((a, s) => a + s.bytes, 0),
    want: "< 606.3M",
  });

  // 4. footprint parsing, header and categories
  const fpFixture = [
    "======================================================================",
    "Kakapo Helper [31532]: 64-bit    Footprint: 1062 MB (16384 bytes per page)",
    "======================================================================",
    "",
    "  Dirty      Clean  Reclaimable    Regions    Category",
    "    ---        ---          ---        ---    ---",
    " 490 MB        0 B          0 B        225    Owned physical footprint (unmapped) (graphics)",
    " 631 MB        0 B          0 B        114    IOSurface",
    "3200 KB        0 B      3616 KB        543    app-specific tag 14",
  ].join("\n");
  const fp = parseFootprint(fpFixture);
  eq("footprint total", fp.total, 1062 * 1024 ** 2);
  eq("IOSurface category", fp.categories.IOSurface?.bytes, 631 * 1024 ** 2);
  eq("IOSurface regions", fp.categories.IOSurface?.regions, 114);
  eq("KB category stays KB", fp.categories["app-specific tag 14"]?.bytes, 3200 * 1024);

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad += 1;
    console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.ok ? "" : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
  }
  if (bad) fail(`${bad} selftest check(s) failed`);
  console.log(`${checks.length} checks passed`);
  console.log("SELFTEST_OK");
}

// ---------------------------------------------------------------- cli

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "selftest": selftest(); break;
  case "verify-install": verifyInstall(); break;
  case "sample": await sample(rest[0], Number(rest[1] ?? 60), Number(rest[2] ?? 1000)); break;
  case "snapshot": snapshot(rest[0]); break;
  case "series-check": seriesCheck(rest[0]); break;
  case "marginal": marginal(rest[0]); break;
  case "attribute": attribute(rest[0]); break;
  case "trend": trend(rest[0]); break;
  default:
    console.log("usage: gpu-probe.mjs <selftest|verify-install|sample OUT SECS MS|snapshot OUT|series-check F|marginal F|attribute F|trend F>");
    process.exit(2);
}
