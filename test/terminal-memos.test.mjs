// The terminal session memo store (terminal-memos.ts): one line per tmux session, written from the pane
// head, cleaned up with the same sweeps that end the sessions themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerminalMemos, sweepTerminalMemos, writeTerminalMemo } from "../dist/terminal-memos.js";

test("a memo round-trips, an empty write deletes, and a sweep follows the reaper", () => {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-term-memo-"));
  const file = join(dir, "nested", "terminal-memos.json"); // the parent dir does not exist yet — first write creates it
  try {
    assert.deepEqual(readTerminalMemos(file), {}, "no file is no memos, not an error");

    writeTerminalMemo(file, "kakapo-abc123-1", "  패키징 세션 — 끝나면 설치  ");
    writeTerminalMemo(file, "kakapo-abc123-2", "issue #17 작업 중");
    assert.deepEqual(readTerminalMemos(file), {
      "kakapo-abc123-1": "패키징 세션 — 끝나면 설치", // stored trimmed
      "kakapo-abc123-2": "issue #17 작업 중",
    });

    writeTerminalMemo(file, "kakapo-abc123-1", "   "); // an empty memo is a deletion, not a blank line
    assert.deepEqual(Object.keys(readTerminalMemos(file)), ["kakapo-abc123-2"]);

    writeTerminalMemo(file, "kakapo-abc123-3", "x".repeat(900));
    assert.equal(readTerminalMemos(file)["kakapo-abc123-3"].length, 500, "a memo is a caption, capped");

    // The reaper killed session 2; its memo goes with it, and unknown names are a no-op.
    sweepTerminalMemos(file, ["kakapo-abc123-2", "kakapo-never-existed-9"]);
    assert.deepEqual(Object.keys(readTerminalMemos(file)), ["kakapo-abc123-3"]);

    // A corrupt file reads as empty rather than throwing into the IPC handler.
    writeFileSync(file, "{not json");
    assert.deepEqual(readTerminalMemos(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
