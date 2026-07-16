import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  canonicalWorkspacePath,
  migrateLegacyProjectData,
  workspaceDataDirectory,
  workspaceMemoFile,
  workspacePerformanceDirectory,
  workspaceReviewFile,
} from "../dist/workspace-data.js";

test("application data mirrors absolute workspace folders and isolates nested monorepo packages", () => {
  const base = mkdtempSync(join(tmpdir(), "monacori-workspace-data-"));
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

test("legacy generated project state is archived without touching tracked project data", () => {
  const base = mkdtempSync(join(tmpdir(), "monacori-workspace-migration-"));
  try {
    const userData = join(base, "app-data");
    const root = join(base, "repo");
    mkdirSync(join(root, ".monacori", "perf"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".monacori", "plan.md"), "# preserved\n");
    writeFileSync(join(root, ".monacori", "perf", "latest.json"), "{}\n");

    const migrated = migrateLegacyProjectData(userData, root);
    assert.ok(migrated);
    assert.equal(existsSync(join(root, ".monacori")), false);
    assert.equal(readFileSync(join(migrated.archive, "plan.md"), "utf8"), "# preserved\n");
    assert.equal(readFileSync(join(migrated.archive, "perf", "latest.json"), "utf8"), "{}\n");

    mkdirSync(join(root, ".monacori"), { recursive: true });
    writeFileSync(join(root, ".monacori", "owned.md"), "tracked\n");
    execFileSync("git", ["add", "-f", ".monacori/owned.md"], { cwd: root });
    assert.equal(migrateLegacyProjectData(userData, root), undefined);
    assert.equal(readFileSync(join(root, ".monacori", "owned.md"), "utf8"), "tracked\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("desktop and CLI code contain no project-local persistence path", () => {
  const commands = readFileSync(new URL("../dist/commands.js", import.meta.url), "utf8");
  const appMain = readFileSync(new URL("../dist/app-main.js", import.meta.url), "utf8");
  assert.doesNotMatch(commands, /ensureWritableFlowState|initFlow|ensureMonacoriGitignore|\.monacori/);
  assert.match(appMain, /workspaceReviewFile/);
  assert.match(appMain, /migrateLegacyProjectData/);
  assert.doesNotMatch(appMain, /join\(state\.options\.root,\s*["']\.monacori/);
});
