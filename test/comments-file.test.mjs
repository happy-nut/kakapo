// comments.jsonl — the whole review conversation in one file (issue #10). A reviewer's question, an agent's
// answer and an agent's Explain note are the same kind of thing, so they are one list of records here rather
// than three stores with three shapes. kakapo writes what it knows; an agent replies by APPENDING a line.
//
// What this has to get right: the app saving a comment must never swallow a line the agent appended a moment
// earlier, and a half-written trailing line must cost one record rather than the conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentsFilePath, knowledgeFilePath, registerCommentsIpc, syncCommentsFile, readThread, writeThread } from "../dist/comments-file.js";

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

    // The agent answers the way the file's own header tells it to: one appended line.
    appendFileSync(h.state.commentsFile, JSON.stringify({ id: 3, re: 1, by: "agent", text: "It ships as one binary." }) + "\n");

    // …and the reviewer edits an unrelated comment before that line has been read back.
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

// Nothing is lost by unifying the stores: a workspace that was annotated before this existed still has its
// notes in annotations.json, and the renderer folds them in the first time it reads a thread file that is
// not there yet.
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

// Knowledge outlives the worktree it was learned in. A workspace is created for a task and deleted when the
// task is done, so a note written beside that workspace's conversation died with it and the next Explain
// started from nothing. The notes go to the git dir the repository SHARES with its worktrees; the
// conversation about one particular diff stays where it was.
test("what the agent learned goes to the repository, the conversation stays with the workspace", () => {
  const h = harness();
  try {
    h.state.knowledgeFile = knowledgeFilePath(h.root);
    // The note below is anchored to this file, and a shared note only reaches a workspace that HAS its file.
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

    // One list again on the way back in, with the id space intact across both files.
    const back = h.read();
    assert.deepEqual(back.records.map((r) => r.id).sort(), [1, 2, 3]);
    assert.equal(back.notesPath, h.state.knowledgeFile, "and that shared file is what {{NOTES_PATH}} means");
  } finally {
    h.cleanup();
  }
});

// Knowledge is shared by every worktree of a repository, but a note is ANCHORED to a file and a line. A note
// about a file this workspace does not have has nothing to attach to here — the card cannot render, yet the
// count on the tree counted it and F8 walked to it, sending the caret to a file it could not open.
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

    // It is not deleted — another worktree still has that file, and the knowledge belongs to the repository.
    const knowledge = readFileSync(h.state.knowledgeFile, "utf8");
    assert.match(knowledge, /only\/in\/another\/worktree\.ts/, "it is still on disk for the workspace it is about");
  } finally {
    h.cleanup();
  }
});

// The two files are ONE id space — a reply in the conversation can answer a note in the shared file, so an id
// has to mean one thing across both. But they number themselves independently and an agent is only ever
// pointed at the file it is writing to, so "highest id in this file + 1" was the only rule it could follow:
// comments reached 20 while notes reached 18, and the next answer and the next note both claimed 19. Two
// records, one id, and everything that resolves a parent by id picks whichever it happens to find first.
// Neither file can answer this on its own; the process that holds both writes the answer into each of them.
test("both thread files carry the same next free id, so an agent seeing one cannot collide with the other", () => {
  const h = harness();
  try {
    h.state.knowledgeFile = knowledgeFilePath(h.root);
    mkdirSync(join(h.root, "src"), { recursive: true });
    writeFileSync(join(h.root, "src", "a.ts"), "export const a = 1;\n");

    // The conversation runs ahead of the notes, which is the case that used to collide.
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

    // And it is the number an agent is told to use, not a decoration: taking it produces a free id.
    const used = h.read().records.map((r) => r.id);
    assert.ok(!used.includes(8), "8 is free in the merged list the renderer works from");
  } finally {
    h.cleanup();
  }
});
