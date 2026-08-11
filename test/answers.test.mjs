// answers.json — the agent's disk copy of the review conversation (issue #10). kakapo writes the checklist,
// the agent fills in each item's answer in place, and main polls the file back to the renderer.
//
// The file has to survive being rewritten: it is now written on every comment change, not once per hand-off,
// because a follow-up typed after the prompt was sent used to exist only inside the app — an agent re-reading
// answers.json found the round it was handed and nothing past it, so the reply could never be answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answersFilePath, registerAnswersIpc, syncAnswersFile } from "../dist/answers-ipc.js";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "kakapo-answers-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const sent = [];
  const state = {
    win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } },
    options: { root },
    answersFile: answersFilePath(root),
  };
  let write;
  registerAnswersIpc({ handle: (channel, fn) => { if (channel === "kakapo:answers-write") write = fn; } }, () => state);
  return {
    root, state, sent,
    write: (items) => write({}, items),
    read: () => JSON.parse(readFileSync(state.answersFile, "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const item = (seq, prompt, extra = {}) => ({ seq, kind: "q", target: `@src/a.ts#L${seq}`, prompt, answer: null, answeredAt: null, ...extra });

test("a follow-up written after the hand-off reaches the file, and earlier answers survive it", () => {
  const h = harness();
  try {
    assert.ok(h.state.answersFile, "a git repository yields an answers path");
    h.write([item(1, "why a CLI?"), item(2, "why not a library?")]);
    assert.equal(h.read().items.length, 2);

    // The agent answers the first one, in place, the way the prompt asks it to.
    const answered = h.read();
    answered.items[0].answer = "It ships as one binary.";
    answered.items[0].answeredAt = "2026-08-11T00:00:00Z";
    writeFileSync(h.state.answersFile, JSON.stringify(answered, null, 2));

    // The reviewer then replies in the thread — a new comment, so a new checklist write.
    h.write([
      item(1, "why a CLI?"),
      item(2, "why not a library?"),
      item(3, "then why not both?", { thread: [{ prompt: "why a CLI?", answer: "It ships as one binary." }] }),
    ]);

    const after = h.read();
    assert.deepEqual(after.items.map((i) => i.seq), [1, 2, 3], "the follow-up is on disk for the agent to find");
    assert.equal(after.items[0].answer, "It ships as one binary.", "the answer already written is not thrown away");
    assert.equal(after.items[0].answeredAt, "2026-08-11T00:00:00Z");
    assert.equal(after.items[2].answer, null, "the new turn reads as pending");
    assert.equal(after.items[2].thread[0].answer, "It ships as one binary.", "…and carries what it follows");
    assert.equal(after.reviewId, h.read().reviewId, "one conversation, not a new round per write");
  } finally {
    h.cleanup();
  }
});

test("an edited question drops the answer it no longer matches", () => {
  const h = harness();
  try {
    h.write([item(1, "why a CLI?")]);
    const answered = h.read();
    answered.items[0].answer = "It ships as one binary.";
    writeFileSync(h.state.answersFile, JSON.stringify(answered, null, 2));

    h.write([item(1, "why a CLI and not a daemon?")]);
    assert.equal(h.read().items[0].answer, null, "the text that answer was written for is gone, so it is pending again");
  } finally {
    h.cleanup();
  }
});

test("only the agent's own edits come back to the renderer", async () => {
  const h = harness();
  try {
    h.write([item(1, "why a CLI?")]);
    await syncAnswersFile(h.state);
    assert.equal(h.sent.length, 0, "kakapo's own checklist is not reported back as if the agent wrote it");

    const answered = h.read();
    answered.items[0].answer = "It ships as one binary.";
    writeFileSync(h.state.answersFile, JSON.stringify(answered, null, 2));
    await syncAnswersFile(h.state);
    assert.equal(h.sent.length, 1, "the agent's answer is pushed");
    assert.equal(h.sent[0].channel, "kakapo:answers-update");
    assert.deepEqual(h.sent[0].payload.map((i) => i.seq), [1]);

    await syncAnswersFile(h.state);
    assert.equal(h.sent.length, 1, "an unchanged file is not re-pushed");
  } finally {
    h.cleanup();
  }
});
