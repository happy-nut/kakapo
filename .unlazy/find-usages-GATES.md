# Find Usages — gates

Porting the part of IntelliJ's code exploration that ec3e34e left out: the usage view with usage
TYPES (⌥F7), the in-file highlight (⌃F7 / ⌃⇧F7), and occurrence stepping (⌃⌥↓/↑). Labels and chords
are taken from intellij-community itself — `UsageViewBundle.properties` and `$default.xml`/
`Mac OS X 10.5+.xml` — not from memory.

- [x] G1 usage types are decided from the line, and the table covers IntelliJ's label set
      CHECK: node --test test/find-usages.test.mjs
      EXPECT: # fail 0
- [x] G2 ⌥F7 opens a grouped list: "N usages in M files", a header per usage type, calls ungrouped
      CHECK: node --test test/find-usages.test.mjs
      EXPECT: # fail 0
- [x] G3 comment and string usages are KEPT, under a non-code section, and ⌥P hides them with tests
      CHECK: node --test test/find-usages.test.mjs
      EXPECT: # fail 0
- [x] G4 ⌘F7/⌘⇧F7 highlights this file's occurrences, write ranges separately from read ranges
      CHECK: node --test test/find-usages.test.mjs
      EXPECT: # fail 0
- [x] G5 ⌘⌥↓/⌘⌥↑ step the occurrences of the symbol under the caret and move the caret
      CHECK: node --test test/find-usages.test.mjs
      EXPECT: # fail 0
- [x] G6 the shortcut table still has no conflict, and the Settings sheet lists every new row
      CHECK: node --test test/shortcut-platforms.test.mjs test/shortcut-rebind.test.mjs test/shortcut-registry.test.mjs test/shortcut-settings.test.mjs test/i18n-parity.test.mjs test/viewer-globals.test.mjs test/viewer-slices.test.mjs
      EXPECT: # fail 0
- [ ] G7 the whole suite passes
      CHECK: npm test
      EXPECT: # fail 0
- [x] G8 in the real app: ⌥F7 paints grouped rows, and the highlight paints ranges jsdom cannot report
      CHECK: npm run nav:smoke
      EXPECT: checks passed in the real app
- [x] G10 Find in Files' three modifiers reach ripgrep and the page's own searcher, and a bad pattern says so
      CHECK: node --test test/search.test.mjs test/search-modifiers.test.mjs
      EXPECT: # fail 0
- [x] G9 both READMEs document the new chords
      CHECK: node -e "const a=require('fs').readFileSync('README.md','utf8'),b=require('fs').readFileSync('README_KR.md','utf8');const k=['⌥F7','⌘F7','⌘⌥↓','⌥M','⌥W','⌥X'];const m=k.filter(x=>!a.includes(x)||!b.includes(x));console.log(m.length?'MISSING '+m.join(' '):'DOCUMENTED')"
      EXPECT: DOCUMENTED

## Evidence — measured 2026-10-26, zsh, /Users/happynut/repos/kakapo

- G1–G5  `node --test test/find-usages.test.mjs` → `# pass 14 / # fail 0`
- G6     `node --test test/shortcut-*.test.mjs test/i18n-parity test/viewer-globals test/viewer-slices`
         → `# pass 24 / # fail 0`, after two real clashes it caught: `⌥C: compareRef vs searchMatchCase`
         (match case moved to ⌥M) and the two-chord `defUsages` row the rebind test asserted as one.
- G7     `npm test` → `# tests 859 / # pass 859 / # fail 0` (re-run after the declaration group; see below)
- G8     `KAKAPO_SMOKE_PORT=9411 node scripts/navigation-smoke.mjs` → `23/23 checks passed in the real app`,
         against a real typescript-language-server. Its usage groups came back
         `["declaration","import","new","read"]`, its highlight registered 1 read + 2 write ranges, and
         both `::highlight()` names resolved to a rule.
- G9/G10 `DOCUMENTED`; `node --test test/search.test.mjs test/search-modifiers.test.mjs` → `# fail 0`

Three defects the checks found that the code review did not:
  - `x => x * 2` classified as a write (`=` then `>` is an arrow);
  - `count < 3` classified as a call (a generic call looks the same for one character);
  - **found only by looking at the real app's screenshot**: `export class Store {` came back from tsserver
    as a reference and was labelled "Value read". A declaration is not a usage; it has its own group now,
    first, and the in-file highlight still counts `let count = 0` as a write because it is one.

The smoke harness itself cost a run: port 9333 was held by a Chrome started with --remote-debugging-port,
and the failure read "the review page never became ready". It names the holder now and takes
KAKAPO_SMOKE_PORT.
