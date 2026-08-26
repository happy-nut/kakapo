// The knowledge-graph harvest reads the terminal agents' transcript files instead of borrowing their
// conversation — and reads each file only from where the last harvest stopped. This covers the finding
// (claude by cwd slug, codex by the cwd stamped in a rollout's first line) and the offsets.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// Both directories are read through env so the test never touches the real home.
const claudeHome = tmp("kakapo-harvest-claude-");
const codexHome = tmp("kakapo-harvest-codex-");
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.CODEX_HOME = codexHome;
const { harvestTranscripts, markHarvested } = await import("../dist/ask-session.js");

const root = tmp("kakapo-harvest-repo-");
execFileSync("git", ["init", "-q", root]);

const slug = root.replace(/[^A-Za-z0-9]/g, "-");
const claudeDir = join(claudeHome, "projects", slug);
mkdirSync(claudeDir, { recursive: true });
const claudeFile = join(claudeDir, "11111111-1111-1111-1111-111111111111.jsonl");
writeFileSync(claudeFile, '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');

const codexDay = join(codexHome, "sessions", "2026", "08", "26");
mkdirSync(codexDay, { recursive: true });
const codexFile = join(codexDay, "rollout-2026-08-26-abc.jsonl");
writeFileSync(codexFile, JSON.stringify({ type: "session_meta", payload: { cwd: root } }) + '\n{"type":"message"}\n');
// A rollout from another workspace must not be offered, however new it is.
writeFileSync(join(codexDay, "rollout-2026-08-26-zzz.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/somewhere/else" } }) + "\n");

test("finds both agents' transcripts, whole file on first harvest", () => {
  const { files, found } = harvestTranscripts(root);
  assert.equal(found, true);
  assert.deepEqual(
    files.map((f) => [f.path, f.fromLine, f.lines]).sort(),
    [[claudeFile, 1, 3], [codexFile, 1, 2]].sort(),
  );
});

test("a harvested transcript is not offered again until it grows", () => {
  markHarvested(root, harvestTranscripts(root).files);
  const again = harvestTranscripts(root);
  assert.equal(again.found, true); // transcripts exist — this is "nothing new", not "no transcript"
  assert.deepEqual(again.files, []);

  appendFileSync(claudeFile, '{"type":"assistant"}\n{"type":"user"}\n');
  const grown = harvestTranscripts(root);
  assert.deepEqual(grown.files.map((f) => [f.path, f.fromLine, f.lines]), [[claudeFile, 4, 5]]);
});

test("a workspace with no transcripts at all reports not-found", () => {
  const bare = tmp("kakapo-harvest-bare-");
  execFileSync("git", ["init", "-q", bare]);
  const { files, found } = harvestTranscripts(bare);
  assert.equal(found, false);
  assert.deepEqual(files, []);
});
