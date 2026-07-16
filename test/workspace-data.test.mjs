import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  canonicalWorkspacePath,
  workspaceDataDirectory,
  workspaceMemoFile,
  workspacePerformanceDirectory,
  workspaceReviewFile,
} from "../dist/workspace-data.js";

test("application data mirrors absolute workspace folders and isolates nested monorepo packages", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-workspace-data-"));
  try {
    const userData = join(base, "app-data");
    const root = join(base, "repos", "zoobox");
    const nested = join(root, "turtle");
    mkdirSync(nested, { recursive: true });
    const expected = join(userData, "workspaces", ...canonicalWorkspacePath(nested).split(sep).filter(Boolean));

    assert.equal(workspaceDataDirectory(userData, nested), expected);
    assert.equal(workspaceReviewFile(userData, nested), join(expected, "review", "app-review.html"));
    assert.equal(workspacePerformanceDirectory(userData, nested), join(expected, "perf"));
    assert.equal(workspaceMemoFile(userData, nested), join(expected, "memo.json"));
    assert.notEqual(workspaceDataDirectory(userData, root), expected, "a monorepo root and its opened package keep separate state");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("desktop and CLI code contain no project-local persistence path", () => {
  const commands = readFileSync(new URL("../dist/commands.js", import.meta.url), "utf8");
  const appMain = readFileSync(new URL("../dist/app-main.js", import.meta.url), "utf8");
  assert.doesNotMatch(commands, /ensureWritableFlowState|initFlow|ensureKakapoGitignore/);
  assert.match(appMain, /workspaceReviewFile/);
  assert.doesNotMatch(appMain, /migrateLegacyProjectData|legacy-project-state/);
});
