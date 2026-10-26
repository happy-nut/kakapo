# Modules and test sources — gates

IntelliJ does not show a flat list of results. Every list it has is divided by what the files ARE:
which module they belong to, and whether they are production code, test code or a library. That
division is a rule stack with ranks — `UsageGroupingRulesDefaultRanks` in intellij-community:
NON_CODE(0) → SCOPE(100) → USAGE_TYPE(200) → MODULE(300) → DIRECTORY_STRUCTURE(400) →
FILE_STRUCTURE(500) — and kakapo had two of those six. This ports the rest, and the thing they all
need first: a model of what the reviewed repo's modules and test roots actually are.

Sources (intellij-community, raw): `platform/usageView-impl/src/com/intellij/usages/impl/rules/`
(`ActiveRules`, `UsageScopeGroupingRule`, `ModuleGroupingRule`, `DirectoryGroupingRule`,
`UsageGroupingRulesDefaultRanks`), `platform/usageView/src/com/intellij/usages/UsageViewSettings.kt`
for which groupings are on by default, `UsageViewBundle.properties` for every label, and
`$default.xml` for the chords.

- [x] G1 the layout comes from IntelliJ's own project files when the repo has them
      CHECK: node --test test/project-layout.test.mjs
      EXPECT: # fail 0
- [x] G2 and from the build manifests, or conventions, when it does not
      CHECK: node --test test/project-layout.test.mjs
      EXPECT: # fail 0
- [x] G3 the layout crosses the build→viewer boundary as one typed island
      CHECK: node --test test/viewer-contract.test.mjs test/project-layout-island.test.mjs
      EXPECT: # fail 0
- [x] G4 ⌥F7 nests its groups in IntelliJ's rank order, outermost first
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G5 Production/Test/Library is a grouping with IntelliJ's labels and IntelliJ's default (off)
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G6 module grouping is on by default, names the module, and flattens as IntelliJ's does
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G7 the read/write/import filters hide what they say they hide
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G8 a test file is marked as one wherever this app lists a path
      CHECK: node --test test/test-source-marking.test.mjs
      EXPECT: # fail 0
- [x] G9 Find in Files takes a scope — the project, production, tests, this module, changed files
      CHECK: node --test test/search-scope.test.mjs
      EXPECT: # fail 0
- [x] G10 the shortcut table has no conflict and every new row is labelled in both locales
      CHECK: node --test test/shortcut-platforms.test.mjs test/shortcut-rebind.test.mjs test/shortcut-registry.test.mjs test/shortcut-settings.test.mjs test/i18n-parity.test.mjs test/viewer-globals.test.mjs test/viewer-slices.test.mjs
      EXPECT: # fail 0
- [x] G11 the whole suite passes
      CHECK: npm test
      EXPECT: # fail 0
- [x] G12 in the real app: the groups paint, and a module header is a module that exists
      CHECK: npm run nav:smoke
      EXPECT: checks passed in the real app
- [x] G13 both READMEs document the grouping chords
      CHECK: node -e "const a=require('fs').readFileSync('README.md','utf8'),b=require('fs').readFileSync('README_KR.md','utf8');const k=['⌘⌥T','⌘⌥M','⌘⌥S','⌘⌥P','⌘⌥F','⌘⇧⌥M','⌘⌥R','⌘⌥W','⌘⌥I','⌥S'];const m=k.filter(x=>!a.includes(x)||!b.includes(x));console.log(m.length?'MISSING '+m.join(' '):'DOCUMENTED')"
      EXPECT: DOCUMENTED

## Evidence — measured 2026-10-26, zsh, /Users/happynut/repos/kakapo

- G1, G2 `node --test test/project-layout.test.mjs` → `# pass 9 / # fail 0`. The declared-root case is an
  `.iml` whose test root is `testSrc`, which no convention would find — that is what makes it a test of
  reading rather than of guessing.
- G3 `node --test test/project-layout-island.test.mjs test/viewer-contract.test.mjs` → `# pass 4 / # fail 0`.
- G4..G7 `node --test test/usage-grouping.test.mjs` → `# pass 12 / # fail 0`, against a real two-module
  pnpm workspace built by the fixture (the module names come out of the packages' own manifests).
- G8 `node --test test/test-source-marking.test.mjs` → `# pass 8 / # fail 0`, the last of which is a
  registry-level guard: a viewer slice that prints a row's path and does not call the tagger fails it.
- G9 `node --test test/search-scope.test.mjs` → `# pass 7 / # fail 0`.
- G10 the shortcut/i18n/slice batch → `# pass 24 / # fail 0`.
- G11 `npm test` → `# pass 932 / # fail 0` (893 before this change), run against one tree state
  with `npm run nav:smoke` straight after it.
- G12 `npm run nav:smoke` → `31/31 checks passed in the real app`, including the module division from a
  real tsserver answer (`["@smoke/root","@smoke/ui",…]`), the painted nesting (`indents [14,27,40,…]`),
  ⌘⌥S splitting production from test, the tree's module badge and ⌥S naming the module scope.
- G13 the README check → `DOCUMENTED`.

Two things only the real app caught, both of which every jsdom assertion passed:
- the module badge wrapped onto its own line — `.tree-dir summary` is a two-column grid and a third child
  with no third track drops to the next row. The same trap then applied to `.semantic-peek-item`, which is
  also a two-column grid, and was fixed there before it shipped.
- the test-file tint was being compared against the OPEN file's row in the smoke, which is selected and
  therefore carries the selected colour: the check passed for the wrong reason. It compares against an
  ordinary row now.
