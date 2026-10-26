# Bug bounty 2026-10-26, round 4 — the hand-written cookie jar

Round 3 ended with a hypothesis: hunt the places that replaced a library behaviour by hand, not areas.
The cookie jar is the biggest of those — IntelliJ's file format, no dependency — and it was missing four
of RFC 6265's rules, every one of which is a rule about when NOT to send a cookie. All four measured
against the real jar before they were written down.

## G1 A response cannot set a cookie for a host it has nothing to do with
`Set-Cookie: injected=1; Domain=github.com` from attacker.test was stored and then sent to
api.github.com. RFC 6265 §5.3.6: a `Domain=` that is not a parent of the host that sent it is rejected.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G2 A response cannot claim an entire public suffix
`Domain=com` passed the suffix test for every host ending in `.com`. Same test file. The single-label
rule is the cheap 90% of the Public Suffix List; a multi-label suffix (`co.uk`) is still claimable by a
server already under it, and that is recorded in the code rather than papered over.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G3 A Secure cookie does not go out over plain http
`Secure` was not parsed at all. Loopback counts as secure, as in every browser — a .http file against
your own dev server over http is the feature.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G4 A cookie with no Domain= belongs to that host, not to everything under it
Every cookie was treated as a domain cookie, so a session set by example.org went to sub.example.org.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G5 The flows a reviewer actually runs are untouched
Not a bug guard — it passes against the shipped code too, deliberately. Refusing to send a cookie is the
easy half; the hard half is still sending the ones that should go. Same host, a legitimate parent
`Domain=`, Secure over localhost, a `Path=` scope, and `Max-Age=0` deleting.
    CHECK: node --test test/http-send.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G6 Nothing else regressed
    CHECK: npm test 2>&1 | tail -8
    EXPECT: # fail 0

## G7 The real app still passes its own checks
    CHECK: npm run nav:smoke 2>&1 | tail -4
    EXPECT: checks passed in the real app

## Checked and clean
- **Header injection through a `{{variable}}`.** Substitution runs AFTER the file is parsed into
  name/value pairs, so a newline lands inside one value rather than starting a header line — and fetch
  then rejects the value outright with a readable error. The interesting part is that this is the
  opposite of the bugs above: a duty correctly left WITH the library instead of taken from it.
- **The default `Path=`.** A cookie with no Path is stored at `/` rather than the request's directory,
  which over-sends WITHIN the host that set it. Left alone: it is a same-origin nit, and narrowing it
  could break a .http file that works today. Noted, not fixed.
