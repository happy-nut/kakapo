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

A branch that carries a `chore(release): vX [skip ci]` commit mutes the release once it lands. GitHub
reads `[skip ci]` out of the squashed merge message, and a squash merge collects every commit subject on
the branch into that message, so `auto-release.yml` never runs: the fix is on `main`, no version follows,
and nothing reports it. Merging `main` into a feature branch is how that commit gets there — rebase onto
`main` instead, or open a fresh branch. The `no-skip-ci-on-the-branch` job in `.github/workflows/test.yml`
refuses such a pull request, reading the commit list from the same place GitHub builds the message from.

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

`fixed: "menu"` is the one marker that exempts a row from the collision check, so the same test asks the
opposite question of it: every key such a row spells must be a chord some menu item actually holds. The
menu keeps its own hardcoded accelerator — the row is what the Settings sheet renders — and without that
assertion the two can drift until the sheet advertises a key that does nothing. The zoom rows are the
reason: four accelerators lived on the View submenu with no row at all, so there was no way to zoom
listed anywhere in the app.

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

A method that writes its return type before its name — `void Run(int which) {`, and every C# and Java
method — was never in either table, because the name group took `void` and the parenthesis never
arrived. Reading it costs a second row whose prefix is one or more type expressions, and the prefix is
what makes a leading token safe: `return foo(a);`, `new Foo(a) {` and `throw new Error(m);` are calls of
exactly that shape, so the words that can only be an operator, a statement or a macro header
(`typedef NS_ENUM(NSInteger, X) {`, `co_await flush(b);`, `emit valueChanged(n);`) are refused in the
prefix, not in the name. That list is the whole guard, so grow it by feeding candidate lines through the
real index rather than by reasoning about them — four of its words were found that way after the row was
written, and none of the four appear in any tree this change was measured on. The terminator `;` is allowed only on that row, because a bare `Register(handlers);` has
no prefix to match. The row is scoped to the extensions whose languages write a return type there — a
TypeScript line `void bootWindow(state, theme);` is the `void` operator applied to a call, and the only
record the widened pattern added to this repository's own tree was that one. The scoping is a row field
in the index (`extensions`) and a path test in the renderer, and the two lists have to say the same thing.

The row beside it — a plain `name(args) {` with no return type — reads a statement keyword the same way,
because `synchronized (lock) {`, `lock (gate) {`, `fixed (…) {`, `using (…) {` and `foreach (…) {` are a
name, a parenthesised expression and a brace. `NOT_A_DECLARED_NAME` is the obvious place to refuse them
and the wrong one: it is read for the name every row produces in every language, so `lock` there would
throw away `const lock = new Mutex()`. The refusal is `STATEMENT_HEADS`, scoped to the extensions whose
languages those statements belong to, and that scoping is what makes it free — a method in Java or C#
carries a return type and is read by the row above, so the only plain `name(args) {` left in a `.java` or
`.cs` file is a constructor, while a TypeScript `lock(resource) {` keeps its record. Measured over
174,655 records in two mixed-language trees it removed nothing at all, and over the C# and Java files of
a Unity checkout it removed two `foreach` loops and nothing else.

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

A sweep that cannot fire is indistinguishable from no sweep, and this one could not fire for four
separate reasons at once. It asked for thirty days unused, and macOS clears the temporary directory at
boot, so a directory only reaches that age if the machine stays up a month — measured on an 11.8-day
uptime, 836 keys and 5.59 GB, none of them reclaimable, and `dirhelper`'s own three-day policy does not
descend into these subdirectories. Its removal could not remove Go's cache at all: Go writes every
extracted module read-only, the measured store held 1470 such directories, `fs.rm` with `force` fails
EACCES partway through one, and the entries it did remove refresh the directory's mtime, so the
half-deleted tree is never stale again and the leak is permanent — `removeServerCache` makes the tree
writable and retries, as `go clean` does. A shared key was skipped on the reasoning that it has no
worktree to outlive, which is true and beside the point: `start()` touches that directory, so its mtime
is a true last-used time and the same age rule reads it. And the per-launch bound was spent in
declaration order, so php, declared last and holding the largest store at 4.9 GB, was never offered a
single key; candidates are now gathered across every family and the oldest go first. Each of the four
has a test that fails when only that one is reverted, which is the only way to tell them apart.

`npm run cache:bench <corpus> <worktree-a> <worktree-b>` is where those reasons come from. It opens a real
repository and a sibling worktree of it through `ProjectAnalysis`, and prints time to the first semantic
answer against a cache of its own (cold), the cache it filled itself (warm) and a cache the sibling filled;
the bytes the sibling adds to that cache; a declaration planted in one worktree only, looked up through the
shared cache in both directions; and two servers live at once on one cache against one each. The planted
declaration is the check that matters — a server whose cache is keyed by content answers from the text in
front of it, and one that is keyed by path does not — so the bench exits non-zero when it goes missing.
Speed alone cannot see that: sharing `CARGO_TARGET_DIR` was faster and wrong. The corpora a row was
measured on are named in `CORPORA` at the top of the script, with the file and column each probe asks
about, so a re-measurement asks the same question. The bench runs against a `TMPDIR` of its own so a
measurement never touches the real Kakapo caches, and `scripts/lib/scratch-dir.mjs` removes that directory
again — on a crash and on `SIGTERM` too, since a long corpus run is interrupted more often than it
finishes. Six runs had already left 1.7 GB behind before it did. `CACHE_BENCH_TMPDIR` names a directory
the bench must not remove, `CACHE_BENCH_KEEP=1` keeps its own, and `test/scratch-dir.test.mjs` holds both
plus the child process that is killed mid-run.

clangd is the one server kakapo cannot place: it writes `.cache/clangd/index/*.idx` into the root of the
repository being read, `--background-index` is on by default in the bundled build and nothing in
`--help-list` moves the directory. So the path it writes is declared in the same file, in
`SERVER_CACHE_INSIDE_PROJECT`, and `readUntrackedDiff` refuses it — `.cache/` was already refused by
`isSourceCandidate` and by the non-git tree walk, but untracked paths never went through either, and a
path that reaches the diff is added to the project list unconditionally. A sibling worktree still indexes
C/C++ from nothing, and nothing in clangd's options can change that.

Those directories are reclaimed by their own mtime, which is why `start()` touches
`server.cacheDirectory` before it spawns. The key is a one-way hash of the worktree path, so nothing can
ask which checkout a directory belonged to; a sweep that could not see it opened would delete a live one.
Before the table there were hundreds of them and gigabytes, with nothing able to tell which were dead.

The installer's download cache is a different directory with a different rule. `scripts/install-language-servers.mjs`
keeps every archive it fetches so a reinstall — a wiped `vendor/`, a fresh worktree — does not download a
gigabyte again, and `pruneDownloadCache` keeps exactly the archives the current pins name. No clock: an
age window is what kept the runtime sweep from ever firing, and what goes stale here is not an old file
but a dead generation, which a pin bump creates the moment it lands. The keep set is derived from the
same tables the installers read, never written out a second time, and `test/install-cache-prune.test.mjs`
fails when a `*_ARCHIVES` table is declared that `ARCHIVE_TABLES` does not read — a table left out has its
archive deleted and re-downloaded on every install. `RUSTUP_TARGETS` is named for what it holds, target
triples rather than filenames, because a table that must be exempt from that rule is a table waiting to
be mis-read.

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
`node_modules`, and taking the app down takes that with it and invalidates the run silently. An
`npm install` during a run does the same from the other side, so a suite that was already running when
the tree's dependencies changed proves nothing and has to be started again.

A pull request is opened from one function, `openPullRequestIn`, which the ⌥L prompt and the
`kakapo <pr link>` argument both call. Three things about it are easy to get wrong. The diff is
`git diff <base> <target>`, two dots, so the base has to be made the merge base by hand or the review
shows what landed on the base branch after the pull request was cut — which GitHub's own Files changed
tab does not. `refs/pull/<n>/head` is asked for rather than a branch because a pull request from a fork
has no branch in the checkout at all, and that is the whole case the fetch exists for; both sides land
under `refs/kakapo/pull/…` so they survive a rebuild and a gc without appearing as branches. And
`baseLabel` is not written: it means "a branch name stands behind this base", a merge base has none, and
a set label makes the compare menu tick "all changes" over the pull request's diff once the target is
cleared — `formal-compare-mode` finds that in four steps, and `label' = TRUE` in its `OpenPullRequest`
action is the negative control.

What the launch asked for and only the first window may have — `openPath`, `pullRequest` — is assigned
to that window beside `createWindow`, because `makeOptions` spreads the launch options into every new
window and has to blank both. Blanking one without assigning it is silent: the argument parses, the
option exists, and nothing happens.

`formal-compare-mode` model-checks the compare controls against one promise: the compare menu always
ticks the row describing the diff the window is actually built from. Six fields, five handlers and one
derivation, and nothing presses two of those controls in a row anywhere in the suite — which is the only
way the fields can disagree. Run it before and after changing anything that writes `options.base`,
`options.baseLabel`, `options.target`, `options.staged`, `state.compareScope` or `state.compareTip`, or
the `mode` derivation in `kakapo:compare-menu`. It holds today, and its SKILL.md records the two
findings it was written for — including the wider fix the model refuted.
