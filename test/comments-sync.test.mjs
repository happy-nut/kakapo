import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentsFilePath, knowledgeFilePath, syncCommentsFile, writeThread } from "../dist/comments-file.js";

test("a note written while the workspace was away arrives when it comes back", () => {
  const root = mkdtempSync(join(tmpdir(), "kakapo-sync-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "main.py"), "print(1)\n");

  const sent = [];
  const state = {
    win: { isDestroyed: () => false, webContents: { send: (_ch, payload) => sent.push(payload.records.length) } },
    options: { root },
    commentsFile: commentsFilePath(root),
    knowledgeFile: knowledgeFilePath(root),
  };
  mkdirSync(join(root, ".git", "kakapo"), { recursive: true });
  writeThread(state.commentsFile, [], 1);
  syncCommentsFile(state);

  writeThread(state.knowledgeFile, [{ id: 9, by: "agent", kind: "note", path: "main.py", text: "## what this repo is" }], 10);
  const before = sent.length;
  syncCommentsFile(state);
  assert.equal(sent.length, before + 1, "the write is sent once");

  syncCommentsFile(state);
  assert.equal(sent.length, before + 1, "an unforced re-sync still believes it already delivered");
  syncCommentsFile(state, true);
  assert.equal(sent.length, before + 2, "activation re-sends what the away view could not take");
  assert.equal(sent[sent.length - 1], 1, "and the note is in it");

  rmSync(root, { recursive: true, force: true });
});
