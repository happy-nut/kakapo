// kakapo's MCP server: the vocabulary offered to whatever agent the reviewer is talking to.
//
// The point of a tool rather than a note in a file is that its DESCRIPTION rides along in the agent's context
// on every turn — so the description is part of the contract and is tested as one. The rest is the same rule
// the rest of the vocabulary keeps: the words are the reader's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRpc, keepWord, listWords, repoRootFrom, KEEP_WORD_TOOL, WORDS_TOOL } from "../dist/mcp-server.js";
import { readTerms, termsFilePath, writeTerms } from "../dist/terms-file.js";

const dirs = [];
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-mcp-"));
  dirs.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@kakapo.test"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  return dir;
}
after(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

test("the handshake lists both tools, and the rules ride in their descriptions", () => {
  const init = handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, process.cwd());
  assert.equal(init.result.serverInfo.name, "kakapo");
  assert.ok(init.result.capabilities.tools, "it offers tools");

  const list = handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, process.cwd());
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["kakapo_words", "kakapo_keep_word"]);

  // These sentences are the whole reason a tool beats a note left in a file: they are in front of the agent
  // every turn, so they are the contract.
  assert.match(KEEP_WORD_TOOL.description, /the words are the USER's/i);
  assert.match(KEEP_WORD_TOOL.description, /Never record a name you coined/i);
  assert.match(KEEP_WORD_TOOL.description, /still asking about is a misunderstanding/i);
  assert.match(KEEP_WORD_TOOL.description, /do not call this|nothing to record/i);
  assert.match(WORDS_TOOL.description, /Read this before explaining/i);
});

// A notification has no id, and answering one is a protocol error.
test("a notification is answered with silence", () => {
  assert.equal(handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, process.cwd()), undefined);
});

test("the repository is worked out from where the agent is running, not from an argument", () => {
  const dir = repo();
  assert.ok(repoRootFrom(dir), "inside a repo it resolves");
  assert.equal(repoRootFrom(tmpdir()), undefined, "outside one it does not guess");

  const out = listWords(dir);
  assert.match(out, /has not built up any words yet/, "an empty vocabulary says so, and says what to do instead");
});

test("keeping a word appends it where the reviewer's map will read it", () => {
  const dir = repo();
  const result = keepWord(dir, {
    w: "지연 로딩",
    gloss: "파일이 도착했다는 알림을 기다리는 것.",
    code: [{ name: "loadSourceFile", at: "src/viewer/07-comments.js:100" }],
  });
  assert.equal(result.ok, true, result.message);

  const [term] = readTerms(termsFilePath(dir));
  assert.equal(term.w, "지연 로딩");
  assert.equal(term.code[0].name, "loadSourceFile");
  assert.equal(term.seen, undefined, "it arrives unread — the reader has not read it back as a word yet");

  assert.match(listWords(dir), /지연 로딩 — 파일이 도착/, "and reading the words back shows it");
});

// The description says "concepts, not identifiers", and a model will still hand over an identifier. Saying no
// with the reason is what keeps the file worth reading — and tells the agent where the name does belong.
test("an identifier offered as a word is refused, with the reason", () => {
  const dir = repo();
  for (const bad of ["loadSourceFile", "terms_file", "src/x.ts", "readTerms()"]) {
    const result = keepWord(dir, { w: bad, gloss: "…" });
    assert.equal(result.ok, false, `${bad} should be refused`);
    assert.match(result.message, /identifier/i);
  }
  assert.deepEqual(readTerms(termsFilePath(dir)), []);
});

test("a word already in the vocabulary is not added a second time", () => {
  const dir = repo();
  writeTerms(termsFilePath(dir), [{ w: "코멘트", gloss: "줄에 남기는 말." }]);
  const result = keepWord(dir, { w: "코멘트", gloss: "다른 설명." });
  assert.equal(result.ok, false);
  assert.match(result.message, /already/i);
  assert.equal(readTerms(termsFilePath(dir)).length, 1);
  assert.equal(readTerms(termsFilePath(dir))[0].gloss, "줄에 남기는 말.", "and the reader's own line is untouched");
});

// The agent's own offerings are in the same file. Handing them over as if they were the reader's words would
// undo the whole distinction.
test("an offered word is read back marked as offered", () => {
  const dir = repo();
  writeTerms(termsFilePath(dir), [{ w: "패치셋", gloss: "리뷰의 기준이 되는 커밋 쌍.", proposed: true }]);
  assert.match(listWords(dir), /offered, not yet theirs/);
});

test("tools/call routes to the right tool and reports failure as an error", () => {
  const dir = repo();
  const call = (name, args) => handleRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, dir);
  const kept = call("kakapo_keep_word", { w: "걷기", gloss: "F8로 카드를 지나가는 것." });
  assert.equal(kept.result.isError, false);
  assert.match(kept.result.content[0].text, /걷기/);

  const refused = call("kakapo_keep_word", { w: "loadSourceFile", gloss: "…" });
  assert.equal(refused.result.isError, true);

  const unknown = call("kakapo_nope", {});
  assert.equal(unknown.result.isError, true);
});
