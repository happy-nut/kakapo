# find-intellij-port — gates

The in-file find bar: the reported focus-out, and IntelliJ's find-toolbar options it never had.

Run with:
  node ~/.claude/skills/unlazy/scripts/gate-check.mjs --root /Users/happynut/repos/kakapo \
    --cwd /Users/happynut/repos/kakapo --timeout 1800 .unlazy/find-intellij-port-GATES.md

## Gates

EXPECT is matched as a LITERAL SUBSTRING unless it is written `/…/flags` — `parseRegex` in
`scripts/lib/gates.mjs` only treats it as a regex in that form. A bare `^2$` therefore never matches the
output `2`, and the first run of this ledger reported nine gates unmet while every one of their commands
returned exactly the expected number. The count gates below are written `/^N$/m` for that reason.

- [x] G1: typing never moves the editor caret or records navigation history
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - typing in the find field"
  EXPECT: /^2$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=2
- [x] G2: the find field keeps the keyboard across a refresh that steals focus
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - the find field keeps"
  EXPECT: /^2$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=2
- [x] G3: moving to another file hands the keyboard to the content, not to nothing
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - closing the bar"
  EXPECT: /^1$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=1
- [x] G4: Match Case / Words / Regex each change which matches are found, on the chord too
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - find in file with"
  EXPECT: /^6$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=6
- [x] G5: an invalid regex says so instead of reporting no matches
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - an invalid regex"
  EXPECT: /^1$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=1
- [x] G6: In Selection searches the selection only
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - In Selection"
  EXPECT: /^2$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=2
- [x] G7: the field remembers recent searches and the chord walks them
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - the find field remembers"
  EXPECT: /^1$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=1
- [x] G8: the real app types five characters into the bar and the bar still owns the keyboard
  CHECK: npm run nav:smoke 2>&1 | tail -4
  EXPECT: 35/35 checks passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=PASS  ⌥M and ⌥X reach the find bar, and an unclosed group is named a bad pattern  — {"matchCase":true,"regex":true,"patternError":true,"count":"잘못된 패턴","pressed":"true"} | 35/35 checks passed in the real app
- [x] G13: the Find in Files file mask takes globs and exclusions
  CHECK: node --test test/search.test.mjs test/quick-open.test.mjs 2>&1 | grep -c "^ok [0-9]* - \(the Find in Files file mask\|project search normalizes\)"
  EXPECT: /^2$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=2
- [x] G9: positive control — the searches a reviewer already ran still work
  CHECK: node --test test/file-find.test.mjs 2>&1 | grep -c "^ok [0-9]* - \(Cmd+F searches only\|diff search stays inside\|search reveals matches inside\)"
  EXPECT: /^3$/m
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=3
- [x] G10: nothing else regressed
  CHECK: npm test 2>&1 | tail -6
  EXPECT: # fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=# todo 0 | # duration_ms 693482.109958
- [x] G11: types still check
  CHECK: npx tsc --noEmit && echo TSC-CLEAN
  EXPECT: TSC-CLEAN
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=TSC-CLEAN
- [x] G12: every new chord is a row in the one table, with a label in both locales
  CHECK: node --test test/shortcut-registry.test.mjs test/shortcut-settings.test.mjs test/shortcut-platforms.test.mjs 2>&1 | tail -6
  EXPECT: # fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=239fa3ddae56/18 entries; output=# todo 0 | # duration_ms 2055.875167

## Recorded negative — IntelliJ's search-context filter

`ShowFilterPopup` (⌃⌥F) offers Anywhere / In Comments / In String Literals / Except Comments / Except
String Literals / Except Comments and String Literals. NOT ported, and not an oversight:

IntelliJ answers "is this occurrence inside a comment" from a real lexer with block state. kakapo's
source painter is `highlightLine(text, language)` in `src/viewer/11-render-http.js` — line-local by
design, so that it can paint a window of a 30k-line file without reading the lines above it (its own
comment says so, and marks the limitation `ponytail: line-local`). The diff view does not even use that
painter; it runs highlight.js. Building the filter on either would classify every `/* ... */` block and
every multi-line string wrongly, in a toggle whose whole promise is precision.

Find in Files keeps its existing approximation (⌥P, exclude comments and tests), which is honest about
being a heuristic.
