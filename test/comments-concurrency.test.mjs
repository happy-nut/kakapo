import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentsFilePath, knowledgeFilePath, readThread, registerCommentsIpc } from "../dist/comments-file.js";

// Two writers share one conversation file: this renderer, and an agent appending answers to it from the
// reader's own terminal. Both allocate ids from the same counter the file header advertises, so they pick the
// same number as a matter of course — and whatever main does on write has to keep both records. These tests
// drive the real IPC handlers, because the bug they cover lived entirely in the write handler's idea of
// "what has the renderer already seen".
function harness() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-thread-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const state = {
    win: { isDestroyed: () => false, webContents: { send: () => {} } },
    options: { root },
    commentsFile: commentsFilePath(root),
    knowledgeFile: knowledgeFilePath(root),
  };
  let write;
  let read;
  registerCommentsIpc({
    handle: (channel, fn) => {
      if (channel === "kakapo:comments-write") write = fn;
      if (channel === "kakapo:comments-read") read = fn;
    },
  }, () => state);
  return {
    root,
    state,
    write: (records) => write({}, { records }),
    read: () => read({}),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("an agent's answer survives a comment that claimed the same id", () => {
  const h = harness();
  try {
    h.write([{ id: 1, path: "src/a.ts", line: 1, text: "why a CLI?" }]);
    // The header now advertises NEXT FREE ID: 2 and the agent follows it.
    appendFileSync(h.state.commentsFile, `${JSON.stringify({ id: 2, re: 1, by: "agent", text: "It ships as one binary." })}\n`);
    // Before the next poll the reviewer writes a second comment; the renderer allocates 2 as well.
    const result = h.write([
      { id: 1, path: "src/a.ts", line: 1, text: "why a CLI?" },
      { id: 2, path: "src/a.ts", line: 9, text: "and this?" },
    ]);
    const onDisk = readThread(h.state.commentsFile);
    const answer = onDisk.find((record) => record.by === "agent");
    assert.ok(answer, "the agent's answer is still in the file");
    assert.equal(answer.text, "It ships as one binary.");
    assert.equal(answer.re, 1, "it still points at the comment it answered");
    assert.notEqual(answer.id, 2, "and it was renumbered off the id the renderer had taken");
    assert.deepEqual(
      result.arrived.map((record) => record.text),
      ["It ships as one binary."],
      "the write tells the renderer about it, so it appears without waiting for a poll",
    );
    assert.equal(onDisk.filter((record) => !record.by || record.by === "me").length, 2, "both comments are kept");
  } finally {
    h.cleanup();
  }
});

test("a save in one worktree keeps shared notes about another worktree's files", () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, "here.ts"), "export const a = 1;\n");
    h.write([
      { id: 1, by: "agent", kind: "note", path: "here.ts", line: 1, text: "about a file this workspace has" },
      { id: 2, by: "agent", kind: "note", path: "only/in/another/worktree.ts", line: 9, text: "about one it does not" },
    ]);
    // A fresh renderer in this workspace: the read filters note 2 out, so it never learns that id.
    const fresh = harness();
    fresh.state.commentsFile = h.state.commentsFile;
    fresh.state.knowledgeFile = h.state.knowledgeFile;
    fresh.state.options.root = h.root;
    const shown = fresh.read();
    assert.deepEqual(shown.records.map((record) => record.id), [1], "the note about another worktree is not shown here");
    fresh.write(shown.records.concat([{ id: 3, path: "here.ts", line: 1, text: "an unrelated question" }]));
    const notes = readThread(h.state.knowledgeFile);
    assert.deepEqual(
      notes.map((record) => record.path).sort(),
      ["here.ts", "only/in/another/worktree.ts"],
      "the other worktree's note is still on disk",
    );
    fresh.cleanup();
  } finally {
    h.cleanup();
  }
});

test("a comment the renderer deleted stays deleted", () => {
  const h = harness();
  try {
    h.write([
      { id: 1, path: "src/a.ts", line: 1, text: "first" },
      { id: 2, path: "src/a.ts", line: 2, text: "second" },
    ]);
    h.write([{ id: 1, path: "src/a.ts", line: 1, text: "first" }]);
    assert.deepEqual(
      readThread(h.state.commentsFile).map((record) => record.id),
      [1],
      "preserving what was never seen must not resurrect what was deleted",
    );
  } finally {
    h.cleanup();
  }
});

test("saving twice in a row does not duplicate the conversation", () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, "here.ts"), "export const a = 1;\n");
    const records = [
      { id: 1, path: "here.ts", line: 1, text: "first" },
      { id: 2, by: "agent", kind: "note", path: "here.ts", line: 1, text: "a note" },
    ];
    h.write(records);
    h.write(records);
    h.write(records);
    assert.deepEqual(readThread(h.state.commentsFile).map((record) => record.id), [1], "the comment is written once");
    assert.deepEqual(readThread(h.state.knowledgeFile).map((record) => record.id), [2], "and so is the note");
  } finally {
    h.cleanup();
  }
});
