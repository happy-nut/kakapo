# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`kakapo` is a small TypeScript CLI that opens a desktop diff reader for the repository it is run in. Its job
is to let a human read AI-generated changes: a real diff, language-server navigation, and review comments
that live beside the code.

It is not an agent, an orchestration layer, a terminal or a workspace manager. Run it from your own terminal,
in the repository you are working in. Keep the core simple, local, and reading-oriented.

## Development

```bash
npm install
npm run build
npm run smoke
```

## Conventions

- Runtime code lives in `src/`.
- The CLI should have no runtime dependencies unless there is a strong validation or review reason.
- Keep generated validation artifacts under the application's canonical workspace-path mirror in its
  user-data directory; never create or write application state inside a reviewed project.
- Prefer plain Markdown and JSON artifacts so users can inspect and edit everything.
- Do not introduce git worktree, terminal multiplexer, editor, or agent-specific requirements. kakapo does
  not run agents, embed a terminal, or manage workspaces — those were deliberately removed.
- Treat AI tools as producers of changes; kakapo is where a human reads those changes.

## Quality Bar

Every behavior change should include:

- a focused implementation
- a smoke test or command-level verification
- documentation updates when CLI behavior changes

When adding a command, update `printHelp` in `src/commands.ts` and both READMEs.

A keyboard shortcut is a row in `src/shortcuts.ts` and nothing else — the Settings sheet renders that
table, the viewer dispatches from it, and a control advertises one with `data-keyhint-id`, so a chord
written anywhere else is a copy that will drift. Give the row its label in `src/i18n.ts` (both locales)
and, if it is dispatched, an entry in `SHORTCUT_ACTIONS` (`src/viewer/05-keymap.js`); a handler returning
false declines the key. Mark a row `fixed` only when the page genuinely cannot rebind it — a menu
accelerator, or a standard key of the surface. Mention it in the READMEs when it is worth knowing about.

A chord the application menu holds never reaches the page: Electron consumes a menu accelerator before any
renderer keydown runs, so such a row is advertised everywhere and fires nowhere, and jsdom tests stay green
because they dispatch keydown straight at the page. `test/menu-accelerators.test.mjs` builds the real menu
and checks the table against it; a row may collide only when it says `fixed: "menu"` or when the menu item
forwards the key on with `sendToFocused`. That guard runs on macOS only — the menu it checks is macOS's —
so run the suite there before trusting a chord change; Linux CI skips it.

Semantic highlighting is a pipeline with four places to lose a token, and losing one is silent: the
capability declaration decides what a server may send, `legend.tokenTypes`/`tokenModifiers` decide what
`src/lsp.ts` can name, the paint table in `semanticTokenClasses()` decides what gets a span, and the
theme's `--token-*` slots decide whether two spans look different. `member` — typescript-language-server's
name for a method — was dropped at the third for as long as the table existed, and the default dark theme
gave `--token-number` and `--token-literal` the same hex, so a distinction the table did make could not be
seen. `test/semantic-tokens.test.mjs` holds all four: every name in a captured legend has a row, a row left
plain names its reason, every class has a colour rule, every slot in each of the twelve theme blocks has a
colour no other slot there has, and no two classes resolve to the same colour, weight, slant and
decoration. The legends are real, captured from the bundled servers by `npm run lsp:legends`
(`test/fixtures/semantic-legends.json`); refresh them when a server is upgraded, because a legend that
grew a name is how the first row went missing. `.tok-*` classes are shared with the source view's own
hand-written lexer — `.tok-type` paints YAML keys and CSS properties — so a slant added for a semantic
kind lands on those too; give the semantic kind its own class instead.

Two painters reach every line — the spelling-only tokenizer (`highlightLine`, and highlight.js for the
diff) and the server's semantic tokens — and a view that picks one of them throws the other's answer away.
typescript-language-server's legend is twelve names and not one of them is `keyword`, `string`, `comment`
or `number`, so a source view that treated semantic tokens as the whole answer painted `const`, `export`
and every string literal plain on every line that had an identifier in it. Both views now layer instead:
`semanticLineHtml` runs the tokenizer over the gaps between tokens, and `paintDiffSemanticTokens` splits
the diff's existing text nodes so the semantic span sits inside whatever highlight.js and diff2html already
put there. Keep it that way — the word-level `<ins>`/`<del>` marks and the trailing-whitespace marks are in
that markup, and `test/semantic-diff.test.mjs` counts them before and after against a run with no tokens.

The diff's left side is the base revision and no server can be pointed at it, so it is painted only where
its text equals its twin on the right; `analysis.ts` already declines `semanticTokens` outright when the
whole comparison is a revision. Painting is driven from `annotateDiffHunkRows` (a wrapper that materialises
after the tokens arrived) and from the token-arrival callback (tokens that arrive after the wrapper), and
both are needed — a test that calls the repaint by hand proves neither.

`test/intellij-parity.test.mjs` holds the other half of the measurement: IntelliJ's two shipped schemes,
read out of the installed IDE into `test/fixtures/intellij-schemes.json`, with every platform colour key
either mapped to a class the table hands out or refused in writing. It exists because the reasons written
down for three of them were wrong — the two schemes disagree about commas, semicolons and doc comments,
and prose about "what IntelliJ does" had been standing in for reading the file. `docs/intellij/README.md`
has the re-extraction command.

Navigation is measured against IntelliJ, not against itself. `npm run nav:smoke` asks whether a key
still works; `npm run nav:matrix` asks whether it still does what IntelliJ does, and prints the two
answers side by side. The second exists because the first cannot see the defect this repo paid for: ⌘B
worked for a year and showed the usages popup on a reference, which IntelliJ never does. Change anything
about go-to-declaration, usages, implementations, the type hierarchy or library targets and run the
matrix — and when a row's expectation changes, re-read it out of the installed IDE (the header of
`scripts/navigation-matrix.mjs` has the decompile command) rather than editing the expectation to match
what the code now does.

When no language server answers — one is still starting, or the file's language has none at all — ⌘B is
answered by a regex guess, and that guess is made twice from two tables that are copies of each other
across the process boundary: `DECLARATION_PATTERNS` in `src/analysis-index.ts`, for the index the main
process builds, and `definitionMatchers` in `src/viewer/15-semantic-navigation.js`, which
`findSymbolDefinition` runs over the viewer's own copy of each file when the index declines. Tighten one
and the other still answers; the renderer's turn arrives as a silent jump rather than a list, which looks
less like a bug and is worse. `test/heuristic-declarations.test.mjs` holds the index's table and
`test/guessed-peek-refresh.test.mjs` the renderer's, and both must move together.

What those tables cannot do is tell a declaration from a call: `name(args) {` is a method, and it is also
a call whose last argument is a function or an object literal, which is why every
`test("…", async () => {` in this suite was read as a declaration of `test`, and they outnumbered every
real method the table held. The signal is the captured argument text — the pattern's own
`[^)]*` cannot hold a `)`, so a call leaves an unbalanced paren behind — and a parameter may hold a
parenthesis only straight after a `:`, where a function type lives. A brace is not a signal: `= {}` and a
generic are parameter lists. Count the table's rows before and after any change to it, with the old
pattern and the new one run over the same working tree: the index scans the tree, so a count taken on one
checkout does not compare with a count taken on another.

A guessed answer must be withdrawn once there is a real one. `queryProjectAnalysis` records the question
behind any non-LSP answer that arrives while the analysis is still starting, `openSemanticPeek` keeps it
only when the response that opened the peek is the one that produced it — `16-structure.js` opens peeks
with no response of its own — and `refreshAnalysisPaints` re-asks it when the phase turns ready. A peek
built from a guess that nothing revisits is a list of wrong answers sitting under a "ready" toast.

The viewer is one concatenated script with no module boundaries, so nothing stops a second copy of an
answer from growing beside the first — and when one does, a fix reaches one copy and the two surfaces
drift. `test/viewer-slices.test.mjs` therefore holds a one-fact-one-reader rule: the file the source view
is showing is read only by `sourceOpenPath()`, Quick Open's active-row clamp / empty state / loading state
/ filter chip only by `clampQuickActive()` / `showQuickEmpty()` / `showQuickLoading()` /
`setQuickFilterChip()`, a selected comment box's keys only by `handleSelectedCommentRowKey()`, a symbol's
occurrences only by `scanUsageLine()`, and a typed query's match only by `matchesQueryVariants()`. Reach
for the accessor rather than the DOM or the formula; if you genuinely need a second reader, change the
rule in that test and say why there.

An analysis that survives a worktree switch is two caches, keyed differently on purpose. The symbol
index's store is keyed by `(extension, content)` and lives once per repository: `commonGitDir` resolves a
worktree to the checkout it came from, and that is the only reason a sibling is served rather than
re-scanned. `repositorySymbolCacheFile` is the one place that resolution happens and
`test/symbol-cache-worktrees.test.mjs` holds it. A language server's cache is keyed by what that server
stores, and `src/server-cache.ts` declares a scope per family rather than letting each branch of
`bundledNativeCommand` spell a path. `shared` and `worktree` are not a preference: gopls's build and
module caches are content-addressed, and a sibling worktree rebuilt the same tree an order of magnitude
faster against a shared one, while two checkouts sharing `CARGO_TARGET_DIR` made a worktree with a live
type error report zero errors. `test/server-cache.test.mjs` keeps the reason beside every row, and fails
both for a family that builds a cache path of its own and for a scope with no reason written for it.

Those directories are reclaimed by their own mtime, which is why `start()` touches
`server.cacheDirectory` before it spawns. The key is a one-way hash of the worktree path, so nothing can
ask which checkout a directory belonged to; a sweep that could not see it opened would delete a live one.
Before the table there were hundreds of them and gigabytes, with nothing able to tell which were dead.

`npm run index:bench [path…]` is the measurement and the gate. It prints a launch split into walk, read,
hash, scan and flush for cold, warm, sibling-worktree and edited-tree runs, and exits non-zero when a
served index differs from a scanned one, when a run disagrees with its own repeats, or when text a
worktree edited is served from what the cache held for it. That last check is the one that earned its
keep: written against a sibling at `HEAD` it passed with the cache key deliberately broken, because the
fixture and `HEAD` were the same text and a wrong answer had nowhere to show. Compare old against new on
one tree — the index scans the working tree, so a number taken on one checkout does not compare with a
number taken on another.

What the bench measures and nobody has bought: a manifest of `(mtime, size)` so an unchanged file skips
the read and the hash. The read and the hash are most of a warm launch, and `stat` is a fraction of them,
but the index's own consumers need the content and every record's declaration text, so the saving is paid
for by making both lazy and by trusting mtime — whose failure is not a slow launch but a jump to a line
that is not there. Re-measure with the bench before deciding again.

Two checks live outside the suite because the suite cannot reach what they answer, and both are project
skills under `.claude/skills/`.

`verify-kakapo` drives the real app over CDP: launch, a doctor, a feature map of what a user can do, and
screenshots kept under `.kakapo-verify/`. Use it to show a change working rather than asserting that it
does — `npm test` is jsdom against a stubbed main process, so it cannot say whether a chord reaches the
renderer on macOS, whether a mark is painted at all, or what a label looks like in Korean, and each of
those has shipped broken with the suite green. Two things it will cost you otherwise: the smoke scripts
want `KAKAPO_DEV=1` or they write into your real Kakapo state, and nothing may drive the app while
`npm test` runs — `test/menu-accelerators.test.mjs` spawns the real Electron out of this same
`node_modules`, and taking the app down takes that with it and invalidates the run silently.

`formal-compare-mode` model-checks the compare controls against one promise: the compare menu always
ticks the row describing the diff the window is actually built from. Six fields, five handlers and one
derivation, and nothing presses two of those controls in a row anywhere in the suite — which is the only
way the fields can disagree. Run it before and after changing anything that writes `options.base`,
`options.baseLabel`, `options.target`, `options.staged`, `state.compareScope` or `state.compareTip`, or
the `mode` derivation in `kakapo:compare-menu`. It holds today, and its SKILL.md records the two
findings it was written for — including the wider fix the model refuted.
