# Bug bounty 2026-10-26 — gates

Five bugs fixed, one claim retracted. Every one was confirmed by running something before it was written
down: the search bugs against the bundled ripgrep, the layout bugs against `readProjectLayout`, and the
citation bug by drag-selecting in a real Chromium. Each gate below fails on the code as it shipped in
v0.6.37 — checked by putting the bug back, not by reading the diff.

## G1 (RETRACTED — not a correctness bug)
Claimed: ripgrep's positive globs are an OR, so a scope switched the file-type filter off. The OR is real
and measured (`--glob '*.ts' --glob 'sub/**'` returns `sub/b.md`), but `projectSearchMatchAllowed`
re-applies the extension filter to the results, so the ANSWER was always right. The negative control said
so: the test passed against the shipped code, and a test that cannot fail is furniture, so it was
deleted. What the OR actually cost was the walk — a scope narrowed nothing, and ripgrep read every file
in the repository. The fix stands on that and on G2, which needed it anyway.
    ABANDON: G1 the post-filter already made the answer right; kept as a performance change, no gate

## G2 Find in Files: a scope directory whose name is also a glob is still searched
`--glob 'app/[slug]/**'` matched NOTHING — `[slug]` is a character class — so scoping to a Next.js
module returned zero results and said so as if it were the answer.
    CHECK: node --test test/search-scope.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G3 A Cargo workspace is found however its `[workspace]` keys are ordered
`exclude` or `default-members` before `members` lost every module: `[^[]*?` cannot cross their `[`.
    CHECK: node --test test/project-layout.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G4 Only `packages:` in pnpm-workspace.yaml names a module
`onlyBuiltDependencies: - esbuild` produced a phantom module named esbuild. Same test file.
    CHECK: node --test test/project-layout.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G5 A reviewed repo cannot make kakapo read a file outside itself
`.idea/modules.xml` with `filepath="$PROJECT_DIR$/../../OUTSIDE.iml"` read that file two directories
above the review root and took its source folders into the layout. Same test file; the workspace-member
half needs the escape target to EXIST or the directory check already drops it and the test passes against
the bug.
    CHECK: node --test test/project-layout.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G6 A citation quotes the code that was selected
Real Chromium selected `3 4 5`; the citation carried `4 5` under "line 3". The same greedy `\s+` ate the
line's own indentation whenever the gutter was present.
    CHECK: node --test test/source-citation.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G7 A library file is a library file as soon as its record exists
The scope cache outlived the one input that changes under it.
    CHECK: node --test test/project-layout-island.test.mjs 2>&1 | tail -6
    EXPECT: # fail 0

## G8 Nothing else regressed
    CHECK: npm test 2>&1 | tail -8
    EXPECT: # fail 0

## G9 The real app still passes its own checks
    CHECK: npm run nav:smoke 2>&1 | tail -4
    EXPECT: checks passed in the real app
