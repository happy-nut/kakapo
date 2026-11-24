# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`kakapo` is a small TypeScript CLI that opens a desktop diff reader for the repository it is run in. Its job
is to let a human read AI-generated changes: a real diff, language-server navigation, and review comments
that live beside the code.

It is not an agent, an orchestration layer, a terminal or a workspace manager. Run it from your own terminal,
in the repository you are working in. Keep the core simple, local, and reading-oriented. Treat AI tools as
producers of changes; kakapo is where a human reads those changes.

## Development

```bash
npm install
npm run build
npm run smoke
npm test
```

Runtime code lives in `src/`. Prefer plain Markdown and JSON artifacts so users can inspect and edit
everything. Do not introduce git worktree, terminal multiplexer, editor, or agent-specific requirements —
kakapo does not run agents, embed a terminal, or manage workspaces, and those were deliberately removed.

Two things invalidate a test run silently, because `test/menu-accelerators.test.mjs` spawns the real
Electron out of this same `node_modules`: driving the app while the suite runs (taking the app down takes
that test's app with it), and an `npm install` or a rebuild during a run. Suite first, then drive, or the
other way round — never at once, and a suite that was already running when the tree's dependencies changed
proves nothing.

## Scope

A request for a mockup is a request for a mockup. "시안", "mock this up", "show me what it would look like"
asks for a picture to judge, and the judging is the deliverable — building the thing, opening a pull request
and merging it answers a question nobody asked and spends the decision before the user makes it. Agreeing
with a direction is not agreeing to build it: "그래프 시안으로 가자" picked one of three sketches and was read
as approval to implement, which is the same mistake made twice on one feature. A mockup round narrows to a
direction; the next round is more mockups inside it. Nothing but the user saying to build it is approval to
build it.

One picture is not a mockup round. A round is several, because judging means choosing, and a single sketch
leaves nothing to choose between — the ask that followed the first round was "한 4개 정도 보고서 선택하고
싶은데". Offer alternatives that differ in what they cost the reader, not in their styling, and say what each
gives up.

Nothing in this repository can check any of that. It is read off the user's words, not off the tree, which
is why it is written here.

## Quality bar

Every behaviour change should include a focused implementation, a smoke test or command-level verification,
and documentation updates when CLI behaviour changes.

A revert is a behaviour change too, and the READMEs are where it gets forgotten. `usageFiltering.imports`
was flipped to `false`, both READMEs were taught to say "imports start hidden", the default was put back to
`true` when it broke twelve usage tests, and the sentences shipped anyway — describing, for a release, a
default the code does not have. Whatever a change taught the docs to say, the revert unteaches in the same
commit. A claim about a default is prose; `test/doc-citations.test.mjs` can tell you a name has rotted but
not that a sentence about behaviour has.

## A probe that reports an absence has to show a presence first

Six times the app was blamed for a probe's own bug: `answer.targets` is always `[]` because the field is
`locations`; `findSymbolDefinition` only scans files the renderer has materialised, so an unopened file has
no symbols at all; `pgrep -f dist/app-main` matched the probe's own shell; a caret left on prose makes ⌘B,
F1 and ⌘U all decline silently; and a reader written as `keys:\s*\[([^\]]*)\]` cannot hold the `]` inside
`"⌥]"`, so two real chords were reported missing from both READMEs. Every one would have died instantly
against a case whose answer was already known, and none was given one.

So state the known-present case in the probe and check it before believing any absence, and when the fact
has an owner in `src/`, import that owner rather than parsing it. Every checking test added since is built
that way, and reverting the reader's own eyes is what caught two bugs in `test/doc-citations.test.mjs` while
it was being written.

## Measured against IntelliJ, not against itself

`npm run nav:smoke` asks whether a key still works; `npm run nav:matrix` asks whether it still does what
IntelliJ does, and prints the two answers side by side. The second exists because the first cannot see the
defect this repo paid for: ⌘B worked for a year and showed the usages popup on a reference, which IntelliJ
never does. Change anything about go-to-declaration, usages, implementations, the type hierarchy or library
targets and run the matrix — and when a row's expectation changes, re-read it out of the installed IDE (the
header of `scripts/navigation-matrix.mjs` has the decompile command) rather than editing the expectation to
match what the code now does. The same holds for the stack-trace oracle and the shipped colour schemes:
`npm run stack:oracle` and `docs/intellij/README.md` re-extract from the installed IDE, and a fixture is
never hand-edited.

## Rules, and what enforces them

Nothing below needs to be remembered. Each row fails by name when it is broken, so the rule is the check.

| Rule | Enforced by |
| --- | --- |
| No `[skip ci]` commit reaches a branch — a squash merge collects every subject and mutes the release | `no-skip-ci-on-the-branch` in `.github/workflows/test.yml` |
| A keyboard shortcut is a row in `src/shortcuts.ts` and nothing else — it resolves to an action, the keypress runs it, the Settings sheet renders it, a control's key hint comes from it, and both locales label it | `test/shortcut-registry.test.mjs`, `test/i18n-parity.test.mjs` |
| A chord the application menu holds never reaches the page, and a `fixed` row names a chord the menu really has | `test/menu-accelerators.test.mjs` (macOS only; Linux CI skips it) |
| A panel declares that it is up and never holds the menu's accelerators itself; the one holder hands them back while a caret is in a field, because ⌘V belongs to the Edit menu and to nothing in the page | `test/menu-chord-claims.test.mjs`, `.claude/skills/verify-kakapo/dock-paste.mjs` |
| A chord in a README table is one `src/shortcuts.ts` declares | `test/readme-chords.test.mjs` |
| The CLI's commands and options are one table, advertised and read in both directions | `test/cli-surface.test.mjs`, `test/cli-args.test.mjs` |
| What only the first window may have is blanked for later windows and assigned to the first | `test/launch-options.test.mjs` |
| The regex guess behind ⌘B is spelled once, not once per process | `test/declaration-heuristics.test.mjs` |
| That guess tells a declaration from a call, and the renderer's copy of the question agrees | `test/heuristic-declarations.test.mjs`, `test/guessed-peek-refresh.test.mjs` |
| A semantic token survives all four places it can be lost, and no two kinds paint the same | `test/semantic-tokens.test.mjs` |
| The diff layers both painters instead of choosing one, keeping its own word-level marks | `test/semantic-diff.test.mjs` |
| Every IntelliJ platform colour key is mapped to a class or refused in writing | `test/intellij-parity.test.mjs` |
| A fact the whole viewer asks about has exactly one reader, and a column maps through one walker | `test/viewer-slices.test.mjs` |
| No slice reads a `let`/`const` a later slice declares | `test/viewer-slices.test.mjs` |
| `VIEWER_SLICES` names every file in `src/viewer`, and that array is the load order | `scripts/copy-viewer-assets.mjs` throws during the build |
| A sandboxed preload imports only what a sandboxed preload is given | `test/app-boundaries.test.mjs` |
| What may be previewed is one table the bundler injects, and a picture git found a text diff for keeps it | `test/media-preview.test.mjs` |
| A caller graph marks a recursion and a cycle, and a chain of distinct callers carries no mark | `test/peek-call-graph.test.mjs` |
| A language-server cache declares a scope per family with the measurement that chose it | `test/server-cache.test.mjs` |
| The sweep can actually fire, survives Go's read-only modules, and spends its bound across families | `test/server-cache.test.mjs` |
| An analysis survives a worktree switch because the symbol index is keyed by content | `test/symbol-cache-worktrees.test.mjs` |
| A server's own index never lands inside the repository being read | `test/server-cache.test.mjs`, `.claude/skills/verify-kakapo/clangd-index-hidden.mjs` |
| The installer's download cache keeps exactly the archives the pins name | `test/install-cache-prune.test.mjs` |
| A stack frame is read by the pinned reader order, against the real IntelliJ parser and real crashes | `test/stack-trace.test.mjs` |
| A path, line or symbol a document names is one the tree has | `test/doc-citations.test.mjs` |
| The compare menu always ticks the row describing the diff the window is built from | `.claude/skills/formal-compare-mode` |
| Chrome text never breaks inside a word and never overflows its box, at 1440 and at 900, in both locales | `npm run ui:text` |
| A served index equals a scanned one, and an edited worktree is never served stale text | `npm run index:bench` |
| A shared cache still answers from the text in front of it | `npm run cache:bench` |
| A caret-anchored popup closes when the code under it scrolls, and not when its own list does | `test/peek-call-graph.test.mjs` |
| A guess is withdrawn once a language server has a real answer | `test/guessed-peek-refresh.test.mjs` |
| Two engines answering a usage list agree about the declaration | `test/find-usages.test.mjs` |
| A stack trace resolves against the whole project, not against the review's changed files | `test/stack-trace.test.mjs`, `npm run ui:text` |
| A pull request is fetched into this checkout, merge base and all, and a fork needs no branch here | `test/github-pr.test.mjs` |
| No application state is ever written inside a reviewed project | `test/workspace-data.test.mjs` |
| A runtime dependency is declared with the review reason it is there, and a bundled server is pinned | `test/runtime-dependencies.test.mjs` |
| A stack row says whose sentence each text is, so the audit measures ours and not the reader's crash | `test/measured-chrome-text.test.mjs` |
| A bench removes the scratch directory it made — on a throw and on `SIGTERM` — and never the caller's | `test/scratch-dir.test.mjs` |
| A change works in the real app, not only in jsdom | `.claude/skills/verify-kakapo` |

Three of those are not part of `npm test` and have to be run deliberately: `npm run ui:text`, because jsdom
lays nothing out and every width is zero; the two benches, because they open real repositories; and the two
skills, because they drive the real app and a model checker. A Korean string is routinely half again as long
as its English twin, so a toolbar measured only in English was not measured.

## What the tools do that we cannot change

- clangd writes `.cache/clangd/index` into the root of the repository being read. `--background-index` is on
  in the bundled build and nothing in `--help-list` moves the directory, so the path is declared in
  `SERVER_CACHE_INSIDE_PROJECT` and refused on the way into the diff. A sibling worktree still indexes
  C and C++ from nothing.
- Go writes every extracted module read-only, so removing its cache needs the tree made writable first, the
  way `go clean` does. A half-deleted tree has a fresh mtime and is never stale again.
- macOS clears the temporary directory at boot, and `dirhelper`'s own policy does not descend into these
  subdirectories, so an age window longer than an uptime is a sweep that cannot fire.
- typescript-language-server's legend is twelve names and not one of them is `keyword`, `string`, `comment`
  or `number`, which is why a view that treats semantic tokens as the whole answer paints `const` and every
  string literal plain.
- jdtls needs `classFileContentsSupport` declared or a class-file target comes back as an empty array.
- The diff's left side is the base revision and no server can be pointed at it, so it is painted only where
  its text equals its twin on the right.

## Where a measurement is recorded

A number in this repository lives next to the assertion that would fail without it, not here.
`test/server-cache.test.mjs` carries the timing that chose every cache scope, `test/install-cache-prune.test.mjs`
the reason a table must be read, and the fixtures under `test/fixtures` carry what a real IntelliJ, a real
crash and a real server legend answered. Refresh a fixture with the script that captured it
(`npm run stack:oracle`, `npm run stack:samples`, `npm run lsp:legends`) rather than editing it, because a
legend that grew a name is how the first missing row went missing.
