import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeCommandForInput } from "../dist/agent-resume.js";

test("terminal input recognizes resumable Claude and Codex sessions", () => {
  assert.equal(resumeCommandForInput("claude\r"), "claude --continue");
  assert.equal(resumeCommandForInput("codex --model gpt-5\r"), "codex resume --last");
  assert.equal(resumeCommandForInput("\u001b[32mclaude\u001b[0m\n"), "claude --continue");
  assert.equal(resumeCommandForInput("npm test\r"), undefined);
});
