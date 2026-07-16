// Reproducible large-project startup benchmark. It creates a disposable git repository, changes a
// configurable subset of files, runs the same lazy review build used by Electron, and preserves the
// result as plain JSON in the caller workspace's application-data mirror.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildDiffReview } from "../dist/build.js";
import { defaultKakapoUserDataDirectory, workspacePerformanceDirectory } from "../dist/workspace-data.js";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const fileCount = option("--files", 3000);
const changedCount = Math.min(fileCount, option("--changed", 120));
const linesPerFile = option("--lines", 80);
const outputRoot = resolve(process.cwd());
const fixture = mkdtempSync(join(tmpdir(), "kakapo-benchmark-"));
const started = performance.now();

function git(args) {
  return execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
}

function source(index, changed) {
  const lines = [
    `export interface Record${index} { id: number; name: string }`,
    `export function compute${index}(input: Record${index}) {`,
    `  return input.id + ${changed ? 2 : 1};`,
    "}",
  ];
  while (lines.length < linesPerFile) lines.push(`export const value${index}_${lines.length} = ${index + lines.length};`);
  return lines.join("\n") + "\n";
}

try {
  git(["init", "-q"]);
  git(["config", "user.email", "benchmark@kakapo.local"]);
  git(["config", "user.name", "kakapo benchmark"]);
  git(["config", "commit.gpgsign", "false"]);
  for (let index = 0; index < fileCount; index += 1) {
    const path = join(fixture, "src", `module-${String(index).padStart(5, "0")}.ts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source(index, false));
  }
  writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  git(["add", "-A"]);
  git(["commit", "-qm", "benchmark baseline"]);
  const fixtureReadyMs = performance.now() - started;

  for (let index = 0; index < changedCount; index += 1) {
    const path = join(fixture, "src", `module-${String(index).padStart(5, "0")}.ts`);
    writeFileSync(path, source(index, true));
  }
  const buildStarted = performance.now();
  const build = buildDiffReview({
    staged: false,
    includeUntracked: true,
    context: 12,
    title: "kakapo benchmark",
    lazyLoad: true,
    app: true,
    root: fixture,
  });
  const buildMs = performance.now() - buildStarted;
  const indexedSourceFiles = build.lazySourceFiles?.length ?? 0;
  const projectIndexMetadata = (build.lazySourceFiles ?? []).map(({ content: _content, image: _image, ...metadata }) => metadata);
  const projectIndexBytes = Buffer.byteLength(JSON.stringify(projectIndexMetadata));
  const projectTreeBytes = Buffer.byteLength(build.update?.filesTree ?? "");
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: { files: fileCount, changedFiles: changedCount, linesPerFile },
    result: {
      fixtureReadyMs: Math.round(fixtureReadyMs * 10) / 10,
      reviewBuildMs: Math.round(buildMs * 10) / 10,
      htmlBytes: Buffer.byteLength(build.html),
      projectIndexBytes,
      projectTreeBytes,
      diffBodies: build.lazyBodyDiffs?.length ?? 0,
      indexedSourceFiles,
      hunks: build.hunks,
    },
  };
  const outputDir = workspacePerformanceDirectory(defaultKakapoUserDataDirectory(), outputRoot);
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, "benchmark.json");
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
