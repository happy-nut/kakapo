# Bug bounty 2026-10-26, round 3 — the .http runner

One finding, and it is a credential leak. Several clean negatives alongside it, recorded because "I
looked and it holds" is worth as much here as a finding.

## G1 Credentials do not follow a redirect to another origin
The runner follows redirects manually so that every hop's destination can be checked — and in doing so it
took over the one thing `redirect: "follow"` was doing correctly. fetch drops Authorization when a
redirect crosses origins; nothing here did, so a server named in a .http file could answer `302 Location:
http://elsewhere/` and be handed the reviewer's password in cleartext. Measured against a local pair of
servers before it was written down: the other host received `Basic cmV2aWV3ZXI6aHVudGVyMg==`.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G2 A same-origin redirect still carries them
The ordinary case — a trailing slash, a login hop — and stripping there would break every one of them.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G3 Nothing else regressed
    CHECK: npm test 2>&1 | tail -8
    EXPECT: # fail 0

## G4 The real app still passes its own checks
    CHECK: npm run nav:smoke 2>&1 | tail -4
    EXPECT: checks passed in the real app

## Checked and clean (no gate — nothing to fix)
- **Argument injection into `git`.** Every call uses spawn with an argv array, so no shell is involved,
  and a ref that begins with `-` is rejected by `validateReviewBase`'s `rev-parse --verify` round trip
  before it can be read as an option.
- **`>>` response saves.** `writableTarget` rejects absolute paths and `..` segments, resolves the parent
  through `containedRealPath` so a symlink cannot step out, and re-checks containment against the real
  root after joining.
- **A malicious response body rendered into `innerHTML`.** `formatHttpBody` routes every branch (JSON,
  markup-sniffed, plain) through the highlighter, which escapes; four payloads were run through the real
  bundle and all four came back escaped.
- **Shape C swept repo-wide.** Every other optional field read by the handlers (`compareScope`,
  `compareRef`, `reviewBase`, `reviewTarget`, `ensureFullIndex`) is assigned in production code.
  `knowledgeFile` (round 2) was the only one of its kind.
