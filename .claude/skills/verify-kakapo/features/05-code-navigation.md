# NAV — code navigation

Reading a change means leaving the diff: what is this symbol, who calls it, what does it implement. The
keys are IntelliJ's, and so are the answers — that is the standard this feature is held to, not internal
consistency. A bundled language server does the resolving, with a regex fallback when there is none.
Library code opens read-only, including into a dependency, a stdlib module or a class a server
decompiles for itself.

## Sub-features

- `NAV-1` **`⌘B` / `⌘`-click** — go to declaration, or to the usages when the caret is already on
  it. One key, two results — IntelliJ's own behaviour. `⌘↓` is not a second key for it: IntelliJ gives
  that chord to Edit Source, which is `NAV-8`.
- `NAV-2` **`⌥F7`** — find usages, grouped by what each one is; `⌘⌥F7` for the flat popup.
- `NAV-3` **`⌘F7` / `⌘⇧F7`** — highlight the symbol in the open file, writes apart from reads;
  `⌘⌥↓` / `⌘⌥↑` to step occurrences.
- `NAV-4` **`⌘⌥B`** go to implementation, **`⌘⌥O`** workspace symbol, **`⌥O`** go to class.
- `NAV-5` **`⌘⇧Y` / `⌘⇧H` / `⌘⇧M`** call / type / method hierarchy; **`⌘U`** supertype.
- `NAV-6` **the source view** — `#source-viewer`, opened by any of the above or by `#diff-open-source`.
  Tabs, `⌘W`, `⌘⇧[` / `⌘⇧]`.
- `NAV-7` **`⌘6` problems, `F2` / `⇧F2`** — the language server's diagnostics. *(Not mapped in detail.)*
- `NAV-8` **`⌘↓` / `F4`** — Edit Source: open the source of the row selected in the sidebar, or of the
  diff line at the caret, which is what `#diff-open-source` clicks. Does nothing in the source view,
  where IntelliJ disables it.

## How to get to it (user POV)

- Caret on a symbol, in the diff or in the source view, then the key.
- `⌘`-click on the symbol.
- The Changes list or the project tree, then `#diff-open-source` to read the whole file.

## Driving it with the CDP harness

**This feature already has two scripted paths. Drive them; do not re-write them.**

```bash
KAKAPO_DEV=1 npm run nav:smoke     # does each navigation key still work
KAKAPO_DEV=1 npm run nav:matrix    # does it still do what IntelliJ does — 18 rows, side by side
```

The second exists because the first cannot see the defect this repository paid for: `⌘B` worked for a
year and showed the usages popup on a reference, which IntelliJ never does. **Change anything about
go-to-declaration, usages, implementations, the type hierarchy or library targets and run the matrix.**
When a row's expectation changes, re-read it out of the installed IDE — the header of
`scripts/navigation-matrix.mjs` has the decompile command — rather than editing the expectation to match
what the code now does.

`nav:matrix` is the oracle; this file is for driving a single case by hand while you are fixing one:

- Put the caret on a symbol — there is no keyboard route to a chosen one, so click it:
  `await h.click('.d2h-code-line-ctn', 2)`.
- `NAV-1` `⌘B` — `page.key("b", "KeyB", 66, 4)`.
  Observe: either the source view opened on the declaration
  (`!document.getElementById('source-viewer').classList.contains('hidden')` and `#source-title`), or the
  usages panel did (`#usages-results`). **Which one is the answer** — on a declaration it is the usages,
  on a reference it is the declaration.
- `NAV-2` `⌥F7` — `page.key("F7", "F7", 118, 1)`.
  Observe: `#usages-results` has rows, and they are grouped — the group headers are the point of the key.
- `NAV-4` `⌘⌥O` — `page.key("o", "KeyO", 79, 5)` (Meta 4 + Alt 1).
- Screenshot: `h.shot("go-to-declaration")` on the source view it landed in.

## Gotchas

- **The language server is real and slow to start.** The first request after launch can take tens of
  seconds while the server indexes. `h.until` on the panel's content, never a sleep; a fixture that is a
  real workspace (a `package.json`, a `tsconfig.json`, more than one module) is what makes the answers
  interesting, and `nav:smoke`'s `fixtureRepo()` is the worked example.
- **A server that times out is quarantined for the life of the window.** One request over 8 seconds and
  that language's `⌘B`, `⌘⌥B` and `⌥F7` are dead until the window closes. A navigation check that fails
  *after* an earlier one timed out is reporting the quarantine, not the feature. Relaunch between cases
  when one has timed out.
- **An LSP feature can be plumbed correctly and still off.** A server that was never sent its settings
  answers Code Vision and inlay hints with `ok` and an empty array. "No error" is not "it works" —
  assert on content.
- **Measure against IntelliJ, not against the app.** A row's expectation is read out of the IDE. Editing
  an expectation so the current code passes removes the only thing the matrix is for.
- **`⌘C` cannot be measured over CDP** without `Input.dispatchKeyEvent`'s `commands: ["copy"]`; the
  native accelerator does not fire from a plain key dispatch.
- **Library targets open read-only and some do not open at all.** A JDK image class reports where it is
  rather than opening — reading one needs a decompiler kakapo does not ship, and only Java has a server
  that decompiles on its own. That is the documented answer, not a failure.
