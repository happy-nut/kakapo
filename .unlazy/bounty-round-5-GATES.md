# Gates: bug bounty 2026-10-26, round 5 — the last two hand-rolled replacements

OWNS: src/server.ts, test/http-send.test.mjs, .unlazy/bounty-round-5-GATES.md

Scope: Round 4 ended by naming what was left — Digest auth, multipart assembly, diff alignment. Round 4's
lesson applied once more: a hand-assembled structure inherits the validation its library used to do, and
here that validation is simply absent, because the multipart body is built into a Buffer and never passes
through `fetch`. Every finding was reproduced against the shipped code first, with a real multipart parser
(`Response.formData()`) and a real Digest verifier.

- [x] G1: a part's content cannot restructure the request
  `--boundary` inside a part's bytes used to add parts the reviewer never wrote: two fields written,
  three arrived, the injected `role=admin` first. That content can come from a file in the reviewed repo
  or from a value captured out of a server's response, so its author is not the request's author.
  CHECK: node --test test/http-send.test.mjs 2>&1 | grep -c "^ok [0-9]* - a multipart part"
  EXPECT: 3
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=3

- [x] G2: a part header value cannot inject structure
  CRLF in a substituted part-header value closed the header block, injected a part, and swallowed the
  reviewer's own field value — `note` arrived as `injected`. `fetch` rejects CRLF in a real header value;
  nothing checked the hand-assembled ones.
  CHECK: node --test test/http-send.test.mjs 2>&1 | grep -c "^ok [0-9]* - a part header"
  EXPECT: 2
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=2

- [x] G3: Digest hashes with the algorithm it claims
  A `SHA-256` challenge got an MD5 response labelled `algorithm=SHA-256` — 32 hex characters where
  SHA-256 is 64. RFC 7616's three algorithms must each hash with themselves, and one kakapo cannot
  compute must be refused rather than answered wrongly.
  CHECK: node --test test/http-send.test.mjs 2>&1 | grep -c "^ok [0-9]* - digest .*algorithm"
  EXPECT: 5
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=5

- [x] G4: Digest does not silently downgrade
  A challenge offering only `qop="auth-int"` fell back to the RFC 2069 form — no cnonce, no nc, and
  replayable — instead of saying it is unsupported.
  CHECK: node --test test/http-send.test.mjs 2>&1 | grep -c "^ok [0-9]* - digest will not drop"
  EXPECT: 1
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=1

- [x] G9: the uploads and challenges a reviewer actually runs still work
  Positive control. Refusing is only a fix if it refuses the wrong request and nothing else: an upload
  whose content does not contain the boundary (including a near miss — a prefix of it), a part header with
  an ordinary value, and an MD5 challenge answered with MD5, as it always was.
  CHECK: node --test test/http-send.test.mjs 2>&1 | grep -c "^ok [0-9]* - \(a multipart upload\|a part header with an ordinary\|digest with algorithm MD5\)"
  EXPECT: 3
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=3

- [x] G5: every fix was watched failing against the shipped code
  Manual. Each fix reverted in isolation, its own test observed failing, then restored. Six controls, and
  no control produced a failure outside its own fix — the positive-control tests (G9) stayed green through
  all six, so none of them pass merely because the code now refuses more.
  EVIDENCE: C1 delimiter check returns false      -> not ok 36, 37, 39
            C2 part header loop disabled          -> not ok 40
            C3 hashName forced to md5             -> not ok 43, 44, 46
            C4 algorithm echoed upper-cased       -> not ok 45
            C5 auth-int refusal disabled          -> not ok 47
            C6 part name regex without `[;\s]`    -> not ok 39 (named the filename, not the field)

- [x] G6: nothing else regressed
  CHECK: npm test --silent 2>&1 | tail -6
  EXPECT: # fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=# todo 0 | # duration_ms 708114.271667

- [x] G7: the real app still passes the suite it ships
  CHECK: npm run nav:smoke 2>&1 | tail -4
  EXPECT: 33/33
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=PASS  ⌥S cycles the Find in Files scope, and the module scope is named  — {"value":"production","options":["all","production","tests","module","changed"],"shown":true,"label":"프로젝트 전체 | 프로덕션 파일 | 테스트 파일 | 모듈: @smoke/root | 변경된 파일"} | 33/33 

- [x] G8: types still check
  CHECK: npx tsc --noEmit && echo TSC-CLEAN
  EXPECT: TSC-CLEAN
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=TSC-CLEAN

## Recorded negative — diff alignment

`semanticDiffAlignmentAnchors` builds its anchors with a patience-LIS carrying parent pointers: the same
algorithm React's `getSequence` uses, reconstructing from `tailIndices[len-1]`, which is a valid longest
subsequence end. Anchors are unique-text-only and strictly monotonic in both panes. No finding.

Read and deliberately not changed: `state.connectorRenderKey` is computed, stored, and then tested only
for truthiness — never compared against a fresh key. Both invalidation paths clear it (the window resize
listener, and the per-table ResizeObserver that covers the sidebar's width animation), so it is dead
weight rather than a stale-render bug. Deleting it is its own change, not a bounty fix.
