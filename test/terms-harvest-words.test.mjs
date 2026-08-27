// The harvest dialog offered "이 함수" and "캐시를 안" as vocabulary — a determiner glued to a generic
// noun, and a phrase cut mid-syntax. termCandidates now requires every phrase-interior chunk to be a bare
// noun (no josa, more than one syllable) and stops generic programming nouns from standing alone. The
// functions are extracted from the slice source and run against a stubbed terms state — the same pattern
// ime-overlay.test.mjs uses, since xterm-free viewer logic doesn't need a whole jsdom boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/26-terms.js", import.meta.url), "utf8");

function extract(re) {
  const m = client.match(re)?.[0];
  assert.ok(m, `${re} found in 26-terms.js`);
  return m;
}
const source = [
  extract(/var TERM_JOSA = \[[\s\S]*?\];/),
  extract(/var TERM_STOP = \[[\s\S]*?\];/),
  extract(/function termStrip\([\s\S]*?\n\}/),
  extract(/function termLooksLikeConcept\([\s\S]*?\n\}/),
  extract(/function termGlossFor\([\s\S]*?\n\}/),
  extract(/function termCodeFor\([\s\S]*?\n\}/),
  extract(/function termCandidates\([\s\S]*?\n\}/),
].join("\n");
const termCandidates = new Function("termsState", `${source}; return termCandidates;`)({ terms: [] });

const words = (batch) => termCandidates(batch).map((c) => c.w);

test("a determiner phrase and a mid-syntax fragment never become words — the noun inside them does", () => {
  const out = words([
    { by: "user", text: "이 함수 왜 캐시를 안 써?" },
    { by: "agent", text: "이 함수의 존재 이유 자체가 GUI로 실행된 앱은 PATH가 최소화돼 있어서예요. 매번 다시 훑는 비용은 몇 번 호출이라, 캐시를 안 하는 쪽이 맞는 선택이에요." },
  ]);
  assert.ok(!out.includes("이 함수"), "'이 함수' is a determiner + generic noun, not a concept");
  assert.ok(!out.includes("캐시를 안"), "a chunk still wearing its josa is syntax, not a name");
  assert.ok(!out.includes("함수"), "generic programming nouns teach nothing alone");
  assert.deepEqual(out, ["캐시"], "the bare noun the reviewer actually used is what survives");
});

test("real spaced concepts still come through, including ones containing a generic noun", () => {
  const lazy = words([
    { by: "user", text: "지연 로딩이 뭔가요" },
    { by: "agent", text: "지연 로딩은 파일을 필요할 때까지 읽지 않는 방식이에요." },
  ]);
  assert.ok(lazy.includes("지연 로딩"), "a noun-compound phrase the answer also used is a word");

  const core = words([
    { by: "user", text: "핵심 파일이 어떻게 정해져?" },
    { by: "agent", text: "핵심 파일은 브리핑 3단계에서 소개하고 사이드 패널에서 하이라이팅해요." },
  ]);
  assert.ok(core.includes("핵심 파일"), "'파일' is stopped alone, but '핵심 파일' is this repo's own word");
});
