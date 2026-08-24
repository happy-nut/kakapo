// A note written while the workspace was OFF SCREEN has to arrive when the reviewer comes back.
// The signature is consumed by SENDING, not by the renderer receiving — so the push that went out to a view
// nobody was looking at also marked the file delivered, and activation then found "nothing changed".
// This is the Explain-codebase report: the map sat complete on disk and never appeared.
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
  syncCommentsFile(state); // the reviewer is here; baseline delivered

  // …they switch away, and the hidden session finishes its codebase map.
  writeThread(state.knowledgeFile, [{ id: 9, by: "agent", kind: "note", path: "main.py", text: "## what this repo is" }], 10);
  const before = sent.length;
  syncCommentsFile(state); // pushed at a view that is not on screen — and marked delivered
  assert.equal(sent.length, before + 1, "the write is sent once");

  // …they come back. Unforced this is silence; forced it is the map.
  syncCommentsFile(state);
  assert.equal(sent.length, before + 1, "an unforced re-sync still believes it already delivered");
  syncCommentsFile(state, true);
  assert.equal(sent.length, before + 2, "activation re-sends what the away view could not take");
  assert.equal(sent[sent.length - 1], 1, "and the note is in it");

  rmSync(root, { recursive: true, force: true });
});
