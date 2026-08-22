// The vocabulary file. It is the knowledge base now: notes on a diff explain one change and are retired by
// the next explanation, but a word the reviewer has taken up outlives every change — so it lives beside the
// repository, shared by every worktree, in a file of its own.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerms, writeTerms, termKey, termsFilePath, mergeTerms } from "../dist/terms-file.js";

const dirs = [];
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-terms-"));
  dirs.push(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@kakapo.test"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  return dir;
}
after(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

// A workspace is made for a task and deleted when the task is done. Knowledge that died with it would have
// to be learned again every time, so the vocabulary sits one level up, in the dir every worktree shares.
test("the vocabulary is shared by every worktree of the repository", () => {
  const dir = repo();
  const wt = join(dir, "..", "wt-" + Math.random().toString(36).slice(2, 8));
  dirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: dir, stdio: "pipe" });

  const a = termsFilePath(dir);
  const b = termsFilePath(wt);
  assert.ok(a && b, "both roots resolve a path");
  assert.equal(a, b, "and it is the same file — the worktree does not get its own copy");
});

test("a word is read back with its meaning, its code names and where it came from", () => {
  const dir = repo();
  const file = termsFilePath(dir);
  writeTerms(file, [
    { w: "브리핑", gloss: "이 변경이 왜 필요했는지 보여주는 첫 설명. 말풍선에 담겨 뜬다.",
      code: [{ name: 'role:"problem"', at: "src/comments-file.ts:30" }], from: [12, 14] },
    { w: "앵커", parent: "말풍선", gloss: "뾰족한 끝이 붙는 자리." },
  ]);
  const terms = readTerms(file);
  assert.equal(terms.length, 2);
  assert.equal(terms[0].gloss.includes("말풍선"), true, "the gloss is kept verbatim — it is where the links come from");
  assert.deepEqual(terms[0].from, [12, 14], "and the turns it was extracted from are kept");
  assert.equal(terms[0].seen, undefined, "a word that has just arrived has not been read");

  // The same word under two concepts is two words. Merging them would put an edge between the two concepts
  // that nothing in the review ever claimed.
  assert.equal(termKey(terms[0]), "브리핑");
  assert.equal(termKey(terms[1]), "말풍선·앵커");
});

test("the file teaches its own format, and a half-written line costs one word", () => {
  const dir = repo();
  const file = termsFilePath(dir);
  writeTerms(file, [{ w: "걷기", gloss: "F8로 카드를 순서대로 지나가는 것." }]);
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /^# kakapo vocabulary/, "the header says what this file is");
  assert.match(raw, /"w":"단어"/, "and shows the shape");

  writeFileSync(file, raw + '{"w":"반쪽\n' + JSON.stringify({ w: "코멘트", gloss: "줄에 남기는 말." }) + "\n");
  const terms = readTerms(file);
  assert.deepEqual(terms.map((t) => t.w), ["걷기", "코멘트"], "the broken line is skipped, the rest survives");
});

// Appending is the write an agent is least likely to get wrong, so correcting a word must not require
// rewriting the file: the last line for a key wins.
test("a later line corrects an earlier one for the same word", () => {
  const dir = repo();
  const file = termsFilePath(dir);
  writeTerms(file, [{ w: "지식 베이스", gloss: "처음 쓴 뜻." }]);
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw + JSON.stringify({ w: "지식 베이스", gloss: "고쳐 쓴 뜻.", seen: true }) + "\n");

  const terms = readTerms(file);
  assert.equal(terms.length, 1, "still one word, not two");
  assert.equal(terms[0].gloss, "고쳐 쓴 뜻.");
  assert.equal(terms[0].seen, true);
});

// `at` is a cache and the name is the truth, so a record with a rotten address still reads back — the point
// is that the reader can be told, not that the file refuses it.
test("a code entry keeps its name even when it has no address", () => {
  const dir = repo();
  const file = termsFilePath(dir);
  writeTerms(file, [{ w: "폴백", gloss: "브리지에서 못 읽으면 다른 곳을 보는 것.",
    code: [{ name: "persistRead", at: "src/viewer/01-core.js:582" }, { name: "사라진이름" }] }]);
  const [term] = readTerms(file);
  assert.equal(term.code.length, 2);
  assert.equal(term.code[0].at, "src/viewer/01-core.js:582");
  assert.equal("at" in term.code[1], false, "a name with nowhere to point is still a name");
});

// Two writers, one file: the renderer holds the whole vocabulary while the map is open and writes it back
// entire, and the agent appends a line at a time from a session that may predate the map being opened. The
// renderer's copy must not become an eraser.
test("a write merges onto whatever the file says now, so an agent's line is not lost", () => {
  const dir = repo();
  const file = termsFilePath(dir);
  writeTerms(file, [{ w: "코멘트", gloss: "줄에 남기는 말." }]);

  // The renderer read the file here, and is about to write its copy back — but in between, the agent that
  // answered a thread appended a word of its own.
  const inRenderer = readTerms(file).map((t) => ({ ...t }));
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ w: "지연 로딩", gloss: "알림을 기다리는 것." }) + "\n");

  inRenderer[0].seen = true; // the reader opened 코멘트 on the map
  const merged = mergeTerms(readTerms(file), inRenderer);
  writeTerms(file, merged);

  const after = readTerms(file);
  assert.deepEqual(after.map((t) => t.w).sort(), ["지연 로딩", "코멘트"], "the agent's word survived the write");
  assert.equal(after.find((t) => t.w === "코멘트").seen, true, "and the renderer's change landed");
});
