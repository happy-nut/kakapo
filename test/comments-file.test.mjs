import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachThreadFiles, commentsFilePath, knowledgeFilePath, registerCommentsIpc, syncCommentsFile, readThread, writeThread } from "../dist/comments-file.js";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-thread-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const sent = [];
  const state = {
    win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } },
    options: { root },
    commentsFile: commentsFilePath(root),
  };
  let write, read;
  registerCommentsIpc({
    handle: (channel, fn) => {
      if (channel === "kakapo:comments-write") write = fn;
      if (channel === "kakapo:comments-read") read = fn;
    },
  }, () => state);
  return {
    root, state, sent,
    write: (records, knownMaxId) => write({}, { records, knownMaxId: knownMaxId ?? records.reduce((m, r) => Math.max(m, r.id), 0) }),
    read: () => read({}),
    file: () => readFileSync(state.commentsFile, "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ask = (id, text, extra = {}) => ({ id, path: "src/a.ts", line: id, text, ...extra });

test("an agent's appended reply survives the app saving the comments around it", () => {
  const h = harness();
  try {
    assert.ok(h.state.commentsFile, "a git repository yields a thread path");
    h.write([ask(1, "why a CLI?"), ask(2, "why not a library?")]);
    assert.deepEqual(readThread(h.state.commentsFile).map((r) => r.id), [1, 2]);

    appendFileSync(h.state.commentsFile, JSON.stringify({ id: 3, re: 1, by: "agent", text: "It ships as one binary." }) + "\n");

    const result = h.write([ask(1, "why a CLI?"), ask(2, "why not a library, really?")], 2);
    assert.deepEqual(result.arrived.map((r) => r.id), [3], "main reports what it found and kept");

    const after = readThread(h.state.commentsFile);
    assert.deepEqual(after.map((r) => r.id), [1, 2, 3], "the answer is still there");
    assert.equal(after[2].text, "It ships as one binary.");
    assert.equal(after[1].text, "why not a library, really?", "and the edit landed");
  } finally {
    h.cleanup();
  }
});

test("a half-written trailing line costs one record, not the conversation", () => {
  const h = harness();
  try {
    h.write([ask(1, "why a CLI?")]);
    appendFileSync(h.state.commentsFile, '{"id":2,"re":1,"by":"agent","te');
    const records = readThread(h.state.commentsFile);
    assert.deepEqual(records.map((r) => r.id), [1], "the complete line is still readable");
  } finally {
    h.cleanup();
  }
});

test("the file teaches its own format, and only the agent's edits come back to the renderer", () => {
  const h = harness();
  try {
    h.write([ask(1, "why a CLI?")]);
    const raw = h.file();
    assert.match(raw, /^# kakapo review thread/, "a header explains the format to whoever opens it");
    assert.match(raw, /"re":<id you are answering>/, "including how to reply");
    assert.match(raw, /APPEND only/, "and what not to do");
    assert.equal(raw.split("\n").filter((line) => line && !line.startsWith("#")).length, 1, "one line per record");

    syncCommentsFile(h.state);
    assert.equal(h.sent.length, 0, "kakapo's own write is not reported back as if the agent made it");

    appendFileSync(h.state.commentsFile, JSON.stringify({ id: 2, re: 1, by: "agent", text: "because." }) + "\n");
    syncCommentsFile(h.state);
    assert.equal(h.sent.length, 1, "the agent's line is pushed");
    assert.equal(h.sent[0].channel, "kakapo:comments-update");
    assert.deepEqual(h.sent[0].payload.records.map((r) => r.id), [1, 2], "as the whole list, which cannot drift");

    syncCommentsFile(h.state);
    assert.equal(h.sent.length, 1, "an unchanged file is not re-pushed");
  } finally {
    h.cleanup();
  }
});

test("a pre-unification annotations.json is handed over once, then never again", () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, ".git", "kakapo"), { recursive: true });
    writeFileSync(join(h.root, ".git", "kakapo", "annotations.json"),
      JSON.stringify({ version: 1, notes: [{ path: "src/a.ts", line: 3, title: "why", text: "because." }] }));

    const first = h.read();
    assert.equal(first.exists, false, "no thread file yet");
    assert.deepEqual(first.legacyNotes.map((n) => n.text), ["because."], "so the old notes come along");

    h.write([{ id: 1, by: "agent", kind: "note", path: "src/a.ts", line: 3, title: "why", text: "because." }]);
    const second = h.read();
    assert.equal(second.exists, true);
    assert.deepEqual(second.legacyNotes, [], "once the thread file exists it is the only source");
    assert.deepEqual(second.records.map((r) => r.text), ["because."]);
  } finally {
    h.cleanup();
  }
});

test("what the agent learned goes to the repository, the conversation stays with the workspace", () => {
  const h = harness();
  try {
    h.state.knowledgeFile = knowledgeFilePath(h.root);
    mkdirSync(join(h.root, "src"), { recursive: true });
    writeFileSync(join(h.root, "src", "a.ts"), "export const a = 1;\n");

    h.write([
      { id: 1, kind: "q", path: "src/a.ts", line: 1, text: "why here?" },
      { id: 2, by: "agent", kind: "note", path: "src/a.ts", line: 3, text: "the trunk" },
      { id: 3, re: 1, by: "agent", text: "because of X" },
    ]);

    const conversation = readFileSync(h.state.commentsFile, "utf8");
    const knowledge = readFileSync(h.state.knowledgeFile, "utf8");
    assert.match(conversation, /why here\?/, "the question stays with this workspace");
    assert.match(conversation, /because of X/, "and so does its answer — a reply belongs to the thread it is in");
    assert.doesNotMatch(conversation, /the trunk/, "the note is not duplicated into the workspace file");
    assert.match(knowledge, /the trunk/, "it is in the repository's own file");

    const back = h.read();
    assert.deepEqual(back.records.map((r) => r.id).sort(), [1, 2, 3]);
    assert.equal(back.notesPath, h.state.knowledgeFile, "and that shared file is what {{NOTES_PATH}} means");
  } finally {
    h.cleanup();
  }
});

test("a shared note arrives only in a workspace that has its file", () => {
  const h = harness();
  try {
    h.state.knowledgeFile = knowledgeFilePath(h.root);
    writeFileSync(join(h.root, "here.ts"), "export const a = 1;\n");

    h.write([
      { id: 1, by: "agent", kind: "note", path: "here.ts", line: 1, text: "about a file this workspace has" },
      { id: 2, by: "agent", kind: "note", path: "only/in/another/worktree.ts", line: 9, text: "about one it does not" },
      { id: 3, by: "agent", kind: "note", text: "about the repository itself, anchored to nothing" },
    ]);

    const back = h.read().records.map((r) => r.id).sort();
    assert.deepEqual(back, [1, 3], "the note whose file is missing here stays out of this workspace's list");

    const knowledge = readFileSync(h.state.knowledgeFile, "utf8");
    assert.match(knowledge, /only\/in\/another\/worktree\.ts/, "it is still on disk for the workspace it is about");
  } finally {
    h.cleanup();
  }
});

test("both thread files carry the same next free id, so an agent seeing one cannot collide with the other", () => {
  const h = harness();
  try {
    h.state.knowledgeFile = knowledgeFilePath(h.root);
    mkdirSync(join(h.root, "src"), { recursive: true });
    writeFileSync(join(h.root, "src", "a.ts"), "export const a = 1;\n");

    h.write([
      { id: 1, kind: "c", path: "src/a.ts", line: 1, text: "why here?" },
      { id: 2, by: "agent", kind: "note", path: "src/a.ts", line: 3, text: "the trunk" },
      { id: 7, re: 1, by: "agent", text: "because of X" },
    ]);

    const nextIdIn = (file) => {
      const line = readFileSync(file, "utf8").split("\n").find((l) => l.includes("NEXT FREE ID"));
      assert.ok(line, `${file} states its next free id`);
      return Number(/NEXT FREE ID: (\d+)/.exec(line)[1]);
    };
    assert.equal(nextIdIn(h.state.commentsFile), 8, "the conversation counts past every id in BOTH files");
    assert.equal(nextIdIn(h.state.knowledgeFile), 8,
      "and the shared notes say the same 8 — its own highest is 2, which is exactly the trap");

    const used = h.read().records.map((r) => r.id);
    assert.ok(!used.includes(8), "8 is free in the merged list the renderer works from");
  } finally {
    h.cleanup();
  }
});

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-wire-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("opening a repository points the window at BOTH of its thread files", () => {
  const root = gitRepo();
  const state = {};
  attachThreadFiles(state, root);
  assert.equal(state.commentsFile, commentsFilePath(root));
  assert.equal(state.knowledgeFile, knowledgeFilePath(root), "the shared notes file, not undefined");
  assert.notEqual(state.commentsFile, state.knowledgeFile, "and they are two different files");
});

test("switching a window to another repository takes nothing of the old one with it", () => {
  const first = gitRepo();
  const second = gitRepo();
  const state = {};
  attachThreadFiles(state, first);
  state.delivered = new Set(['{"id":1,"text":"from the first repo"}']);
  state.commentsSig = "stale";
  state.knowledgeSig = "stale";

  attachThreadFiles(state, second);
  assert.equal(state.commentsFile, commentsFilePath(second));
  assert.equal(state.knowledgeFile, knowledgeFilePath(second));
  assert.equal(state.delivered, undefined,
    "what this window was handed belonged to the other repository; the write handler reads it as 'has the renderer seen this'");
  assert.equal(state.commentsSig, undefined);
  assert.equal(state.knowledgeSig, undefined);
});

test("the app wires its thread files in one place, so the two call sites cannot drift apart", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const direct = main.match(/state\.(commentsFile|knowledgeFile|delivered)\s*=/g) ?? [];
  assert.deepEqual(direct, [],
    `a window's thread files are set by attachThreadFiles(), not field by field — found ${direct.join(", ")}`);
  assert.equal((main.match(/attachThreadFiles\(/g) ?? []).length, 2,
    "both the open path and the repo-switch path go through it");
});

test("a workspace with no conversation of its own still folds in its legacy stores, and keeps the shared notes", () => {
  const root = gitRepo();
  const state = { win: { isDestroyed: () => false, webContents: { send: () => {} } }, options: { root } };
  attachThreadFiles(state, root);
  writeFileSync(join(root, "README.md"), "hi\n");
  writeThread(state.knowledgeFile, [{ id: 1, by: "agent", kind: "note", path: "README.md", line: 1, text: "a shared note" }]);

  let read;
  registerCommentsIpc({ handle: (channel, fn) => { if (channel === "kakapo:comments-read") read = fn; } }, () => state);
  const result = read({});
  assert.equal(result.conversationExists, false, "this workspace has no conversation file");
  assert.equal(result.exists, true, "but there IS something to show");
  assert.equal(result.records.length, 1, "and the shared note is in it, so a save cannot drop it");
});
