# Kakapo

**A desktop diff reader for what the AI actually changed. Run it from your terminal, in the repository you are working in.**

*[한국어 README](README_KR.md)*

Coding agents are fast. Reading their output is not. Kakapo is built for that half of the loop: a real diff, real language-server navigation, and review comments that live beside the code.

## Why Kakapo

**The diff is the source of truth, not the chat log.** An agent's "done ✅" is a claim. Kakapo opens the actual Git diff in an IntelliJ-style side-by-side view, with folded context you can expand, hunk navigation (`F7`), and per-file *Viewed* state — so you review what landed, not what was reported.

**Comment on a line; the thread stays with the code.** Press `?` on any line to ask a question or request a change — one comment per line, so asking again on a line you have already commented on reopens that comment instead of stacking a second beside it. `F8` walks every thread until nothing is left open. `⌘⇧/` assembles every open comment into one document to copy — just your comments, nothing prepended — to paste wherever the agent is. The thread itself is a plain file, so an agent told its path can append answers back onto the cards that asked.

**IDE-grade reading with zero setup.** Go to definition, references, implementations and workspace symbols work across the diff via real language servers, and Semantic Peek answers them inline instead of taking you out of the review. Project search runs on bundled ripgrep. Nine language toolchains ship inside the app — no `PATH` lookup, no installs, no editor plugins.

**It never writes into tracked project files.** Review threads live under `.git/` (Git never tracks its own directory, so `git status` stays clean, and a cwd-sandboxed agent can still reach them). Everything else lives in the OS application-data directory, keyed by absolute workspace path. Plain JSONL, Markdown and JSON — fully local, no account, no telemetry, MIT.

## The loop

1. The agent works in your own terminal.
2. `kakapo` in that repository opens its diff — `F7` between hunks, `Space` to mark a file reviewed.
3. `?` on a line to ask a question or request a change.
4. `⌘⇧/` gathers every open comment into one document; copy it and paste it wherever the agent is.

## Install

### macOS (Apple Silicon)

```bash
brew install --cask happy-nut/tap/kakapo
```

That installs the app *and* the `kakapo` command, so `kakapo .` in a repository works straight away. The
build is unsigned — the cask clears the quarantine flag for you, which a manual download does not, so a
`.dmg` taken from [Releases](https://github.com/happy-nut/kakapo/releases) still needs right-click →
**Open** on first launch.

`brew upgrade --cask kakapo` follows every release.

### From source

Requires Node.js 22.14+.

```bash
git clone https://github.com/happy-nut/kakapo.git
cd kakapo
npm install
npm run lsp:install
npm link
kakapo install-app   # optional: adds a Kakapo icon to Applications
```

`npm` installs a command, not an application, so kakapo lives in your terminal and nowhere else. `kakapo
install-app` adds an icon to Applications for Spotlight, Launchpad and the Dock; it launches the very CLI you
installed, so there is no second copy to go stale, and `kakapo uninstall-app` takes it away again.

## Running it

Run `kakapo` inside any Git repository or a package folder inside a monorepo:

```bash
kakapo
kakapo /path/to/repository/package     # or any folder
kakapo path/to/file.ts                 # open the folder around it, landing on the file
```

Git is optional. A folder with no repository in it opens as its source tree with an empty diff, which is how
you read a file that was never going to be committed — a design note under `~/.claude`, a scratch directory,
an unpacked tarball.

Kakapo runs as a single instance. Running `kakapo` again from the same repository or worktree focuses the window already reviewing it; another repository opens its own window. Subfolders are normalised to the Git top level, so the same checkout never opens twice, while separate worktrees stay separate windows.

### Choosing what to compare

The toolbar pill says what the diff is comparing, and opens the two states you switch between all day:

| Key | |
| --- | --- |
| `⌥A` | Everything on this branch, measured against its merge-base with the branch you pick |
| `⌥U` | Only what is not committed yet |
| `⌥C` | Pick that branch — search the list, or take the repository default |

"All changes" uses the **merge-base**, not the branch tip: `git diff main` against a `main` that has moved on shows other people's commits as your deletions.

Opened with no flags, kakapo picks for you: the upstream merge-base when the branch has unpushed commits, otherwise `HEAD`. You can also say it up front:

```bash
kakapo --base main          # working tree vs main (review a whole AI feature branch)
kakapo --base v0.2.0        # vs a tag
kakapo --base 9f3c1a2       # vs a commit
kakapo --staged             # index vs HEAD
```

`kakapo --help` lists every flag; `--base` takes any revision and validates it at startup, and `--staged` and `--base` are mutually exclusive. For a narrower slice than the dropdown offers, the patch-set bar under the toolbar diffs any single commit on the branch against any other, and `⌘9` opens the commit graph — Enter on a commit opens it in the main review.

### When the base has moved under you

If the base has landed commits since your branch left it, the Changes tree says so on the rows affected:

| Badge | |
| --- | --- |
| **conflict** | The base changed these same lines. This will not merge cleanly. |
| **diverged** | The base changed this file somewhere else. It still merges, but you are not reading the whole story. |

Both sides are compared at the commit where they parted company, so the lines line up. It reads the local
object database only — no fetch, no account, and nothing is written: not the working tree, not the index, not
a ref. It also works on changes that are not committed yet, which is the usual case for work an agent just
wrote, and a base that has not moved costs a single `git merge-base` call.

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘0` / `⌘1` | Changes / Files panel |
| `F7` / `⇧F7` | Next / previous changed hunk |
| `Space` | Toggle *Viewed* on the selected changed file |
| `?` | Comment on the current line |
| `F8` / `⇧F8` | Next / previous comment |
| `⌘⇧/` | All review comments (one hand-off document). Copying hands it over and archives it — the sidebar puts it back, `⌘Z` undoes |
| `⌘C` | In that document: hand over the selected comment — copying IS the hand-off, so what you copy is archived (`⌘A` first for all of it) |
| `⌥Enter` | In that document: hand the whole review over — the same copy-and-archive the button does |
| `⌘9` | Git history — commits, reflog, stashes |
| `⌘C` | In history: copy the selected commit's hash |
| `⌘F` / `⌘⇧F` | Find in file / in project (the ⌘⇧F rail also holds file search & recent files) |
| `⌥M` / `⌥W` / `⌥X` | In Find in Files: match case / whole words / regular expression |
| `⌘E` | Recent files — the list on its own, press again to close. Type to filter (Korean typing is read as the QWERTY keys that made it) |
| `⌥A` / `⌥U` | All changes on the branch / only what is not committed yet |
| `⌥C` | Choose the branch "all changes" is measured against |
| `⌘B` or `⌘⌥F7` | Who uses this — the flat list at the caret (IntelliJ's Show Usages) |
| `⌥F7` | Find usages — the same answer, grouped by what each usage *is* |
| `⌘F7` / `⌘⇧F7` | Highlight this symbol everywhere in the open file, writes apart from reads |
| `⌘⌥↓` / `⌘⌥↑` | Next / previous occurrence of the symbol under the caret |
| `⌘⌥B` / `⌘⌥O` | Go to implementation / workspace symbol |
| `⌘⇧B` | Go to the declaration of this thing's **type** |
| `⌘F12` | This file's structure — filter, then jump |
| `⌥↓` / `⌥↑` | Next / previous symbol in this file |
| `⌘P` | Search files by name (`store.ts:42` lands on the line) |
| `⌘⇧E` | Recent locations — where the caret has been |
| `⇧⇧` | Search everywhere (files, text, symbols, history) |
| `⌘⇧T` | This file's test, or back to what it tests |
| `⌘⌥H` / `⌘⇧H` | Call / type hierarchy — press again for the other direction |
| `⌘U` | Go to the supertype |
| `F3` / `⌘F3` | Bookmark this line / show every bookmark |
| `⇧⌥1`…`⇧⌥9` / `⌥1`…`⌥9` | Number this line / go to that number |
| `⌘↓` / `⌘`-click | Go to definition — including into library code (a dependency, a stdlib module, a bundled type stub), which opens read-only |
| `⌥F1` | Reveal the open file in the sidebar |
| `F2` / `⇧F2` | Next / previous problem the language server found |
| `⌥Enter` | On a flagged line: draft the change request that asks an agent to fix it |
| `⌘Enter` | Run the `.http` request at the caret |
| `⌘⇧Enter` | Run every request in the `.http` file, in order |
| `⌘⇧C` | Copy the `.http` request at the caret as a `curl` command |
| `⌘K` | Copy the caret's `file:line` |
| `⌘,` | Settings |

Settings ▸ Shortcuts lists the rest.

## Getting around

Most of this is IntelliJ's keymap, because most of it was already: `⌘B` usages, `⌥F7` find usages,
`⌘⌥B` implementations, `⌘⌥O` workspace symbols, `⌘E` recent files, `⌘⇧F` find in path, `⌘L` go to line,
`⌥F1` reveal in the sidebar, `F2`/`⇧F2` next problem, `⌘[`/`⌘]` back and forward, `⌘↓` or `⌘`-click for a
definition.

What this adds:

**Find usages** (`⌥F7`) — the same answer `⌘B` gives, grouped by what each usage *is*: the imports
together, the writes together, the `extends` clause, the `new`, the type parameters, the lines that only
mention the name in a comment or a string. Forty references to one symbol is a list you scroll; the same
forty under eight headings is a list you read, and "which of these forty write to it" is usually the
question you pressed the key for. The group names are IntelliJ's own — "Value write", "Usage in
extends/implements clause", "New instance creation" — taken from `UsageViewBundle.properties` in
intellij-community rather than invented here, so a reader who knows the IDE recognises them. A plain call
site has no usage type in IntelliJ either; it shows under *Unclassified*.

The comment and string hits are kept, under a *Non-code usages* divider, which is a change: the caret
popup drops them silently, and "no usages" when there are four mentions in comments is a wrong answer.
`⌥P` — the same chord and the same toggle Find in Files has — takes them and the test files out again.
What a line *cannot* say is whether a declaration is a field or a local, so those two IntelliJ types are
not in the table: a header that is right half the time is worse than no header.

**Highlight in this file** (`⌘F7` / `⌘⇧F7`) — every occurrence of the symbol under the caret in the open
file, writes in a second colour, `⌘⌥↓`/`⌘⌥↑` to walk them, `Esc` to put it away. IntelliJ's Find Usages in
File and Highlight Usages in File, which do the same thing from two chords. This one is name-based, not
semantic — two locals that share a name light up together, exactly as IntelliJ's own Find Word at Caret
does — and it asks no language server, so it answers while a cold one is still indexing. `⌥F7` is the
semantic answer when the difference matters. The chords were a second spelling of `F8`/`⇧F8`'s comment
stepping before this; a duplicate is not worth IntelliJ's two in-file usage keys.

**Find in Files' three modifiers** (`⌥M` match case, `⌥W` whole words, `⌥X` regular expression) —
IntelliJ's `Cc`, `W` and `.*`, one ripgrep flag each, with `⌥E` for a file mask and `⌥P` to drop comments
and tests as before. With none of them on the search is what it always was: smart-case (a lower-case query
ignores case, a query with a capital in it does not) and literal. A pattern that does not compile is named
as a bad pattern rather than searched for — "no matches" for a typo in a regex is a wrong answer a reviewer
would believe — and a standalone HTML review, which has no ripgrep to ask, applies the same three
modifiers in the page.

**This file's structure** (`⌘F12`) — every symbol in the open file, indented by nesting, filtered as you
type (names only, as IntelliJ matches, and a query typed with a Korean layout still on is read as the keys
that made it). `Enter` lands on the symbol's name. The language server answers it; where there is no server
for the language, the same declaration index that backs Find Usages does, labelled as the heuristic it is.

**Stepping by symbol** (`⌥↓` / `⌥↑`) — the next or previous symbol boundary, which is IntelliJ's
next/previous method. Not on `⌃↓`/`⌃↑`: kakapo's shortcut table spells Command and Control the same way
(one table, both platforms), and `⌘↓` is already Go to Definition.

**Go to type declaration** (`⌘⇧B`) — where the *type* of the thing under the caret is declared, rather
than the thing itself.

**Recent locations** (`⌘⇧E`) — the back/forward history as a list rather than one `⌘[` at a time, newest
first, with where you are now marked. `Enter` restores the whole position, diff side included.

**File search** (`⌘P`) — by name, with `store.ts:42` to land on a line. Not on `⇧⌘O`, which opens a
folder in a new window here — a desktop-app convention worth keeping.

**The two hierarchies** (`⌘⌥H` calls, `⌘⇧H` types) — a tree you open a level at a time, because "who
calls this" is only half the question and the other half is "and who calls them". `⇢` expands a row, `⇠`
collapses it, and pressing the chord again flips the direction (IntelliJ's two tabs, one key). They are on
`⌘` rather than IntelliJ's `⌃` for the reason above. Where the language server has no hierarchy request,
the declaration-text heuristic answers for the languages whose syntax carries the relationship on the line
(`class Child extends Base`, `class Worker(Base):`) — and where nothing can answer, the panel says *why*
rather than looking like "nothing calls this".

**Go to super** (`⌘U`) and **go to this file's test** (`⌘⇧T`) — the second by the naming conventions the
bundled languages use (`.test.`/`.spec.`, `_test`, `test_`, a `Test` suffix), both ways, nearest directory
first, so a monorepo with twenty `thing.test.ts` opens this file's.

**Bookmarks** (`F3`, `⌘F3`) — a place to come back to with nothing to say about it. When there *is*
something to say, that is a comment, which kakapo already keeps beside the code. Numbered (mnemonic)
bookmarks too: `⇧⌥3` gives this line the number 3 and `⌥3` goes back to it from anywhere, with a number
belonging to exactly one line. On `⌥` rather than IntelliJ's `⌃` because `⌘1`/`⌘0`/`⌘9` already mean the
Files panel, the Changes panel and history. Bookmarks live in kakapo's own per-workspace state, never in
the repository.

**Not ported, on purpose.** *Go to Related Symbol* (`⌃⌘↑`): in a reader with no framework knowledge its
contents are exactly `⌘⇧T` and `⌘U`, which are both here. *Go to Class* (`⌘O`): `⌘⌥O` already searches
every symbol including types, and `⌘O` opens a folder here. The *Structure tool window*: `⌘F12`'s popup is
the reading half of it, and a docked panel is workspace furniture. *Find Usages Settings* and *Structural
Search*: both are about search scopes and patterns this app has no model for.

**Search everywhere** (`⇧⇧`) — the launcher with every section beside it. The double tap is spelled as a
chord in [src/shortcuts.ts](src/shortcuts.ts) and recognised by the one matcher, so it stays rebindable and
there is no second place where a chord is written down.

**Not ported.** Go to Related Symbol, which in IntelliJ is framework-specific (a template and its
controller, a bean and its XML); `⌘⇧T` is the part of it that generalises to any project. And `⌘↑` opens
the sidebar at the file you are in rather than IntelliJ's breadcrumb popup — the sidebar *is* kakapo's
navigation bar, so it is the same gesture rather than a second surface for it.

## Reading a diff

The diff is side by side, with the characters that actually differ marked inside each changed line, and a
ruler down the right edge of the pane showing every change in the open file at once — where they are, how
much of the file they cover, where your comments sit, and where in all of it you currently are. Click the
ruler to go there.

Three things about what you are reading are adjustable, and two of them re-run `git diff`:

| Where | What |
| --- | --- |
| Diff menu | **Whitespace**: count every difference, ignore how much whitespace there is (`-b`), or ignore it entirely (`-w`). `⌘⇧W` cycles the three. |
| Diff menu | **Unchanged lines kept around a change**: 3, 12 (the default), 50, or the whole file. |
| Settings | **Changed lines**: colour the characters that differ, the whole line, or nothing but the gutter. |

The first two are per window, so two windows can read the same repository under different rules. The third
is a reading of markup that is always there, so it applies the moment you choose it.

**Not ported from IntelliJ's diff:** the unified (single-column) view, and rendering whitespace as visible
glyphs. The unified view is not a setting in kakapo's diff but a second shape for it — the caret model, the
row alignment, the comment anchoring and the gutter layers all read the two-column markup — so it is a
change to the review surface itself rather than an option on it, and it is not worth destabilising that for
a second way to look at the same hunk.

## HTTP requests (`.http` files)

A `.http` or `.rest` file in the repository is runnable where you read it: every request gets a `▶` in the
gutter, in the source view and in the diff, and the response lands under the request. The format is
JetBrains' HTTP Client, so the same file works in kakapo and in IntelliJ without being edited.

```http
@base = https://api.example.com

### log in
# @name login
POST {{base}}/sessions
Content-Type: application/json

{ "user": "ada", "password": "{{$dotenv.PASSWORD}}" }

> {%
  client.global.set("token", response.body.token);
  client.test("a token came back", function () {
    client.assert(response.body.token, "no token in the response");
  });
%}

### the profile it unlocks
# @timeout 5
GET {{base}}/me
Authorization: Bearer {{token}}

>> out/me.json
```

**Requests.** `###` separates them and names them (`# @name` works too, and an unnamed request is `#1`).
A bare URL is a `GET`. An HTTP version after the URL is not part of it. A long URL can be split across
indented lines that start with `/`, `?` or `&`. `GRAPHQL` posts `{query, variables}` — write the operation,
then a blank line, then the variables as JSON.

**Directives**, written as comments above the request: `@no-redirect`, `@no-cookie-jar`, `@no-log`,
`@no-auto-encoding`, `@timeout 600`, `@connection-timeout 2 m` (`ms`/`s`/`m`, seconds by default). Both
timeouts become one deadline, the larger of the two: there is no hook between connecting and reading to
enforce them separately, and a deadline shorter than either was asked for would be wrong.

**Bodies.** Inline, or `< ./body.bin` to send a file's bytes, or `<@ ./body.json` to substitute its
`{{variables}}` first. `multipart/form-data` parts are assembled from the `--boundary` blocks; a part with a
`filename=` is sent as that file's bytes, and one without it sends the file's text as the field's value.

**Variables.** `@name = value` in the file, `http-client.env.json` and `http-client.private.env.json`
(looked for beside the requests as well as at the repository root, nearer file wins), the `$shared` section
every environment sits on, `{{$dotenv.NAME}}` from a `.env`, `{{$env.NAME}}` from the process, and a dotted
name as a JSONPath into a variable holding JSON (`{{client.host.url}}`). Dynamic: `$uuid`, `$timestamp`,
`$isoTimestamp`, `$randomInt`, `$random.integer/float/alphabetic/alphanumeric/hexadecimal/email/uuid`,
`$projectRoot`, `$historyFolder`. A named response is readable too —
`{{login.response.body.$.token}}`, `.headers.Location`, `.status`. An unresolved `{{name}}` stops the
request and says which name, instead of sending the text and getting back a scheme error.

**Scripts.** `< {% … %}` before a request, `> {% … %}` or `> ./handler.js` after it, with IntelliJ's API:
`client.global`, `client.test`, `client.assert`, `client.log`, `client.exit`, `response.status/body/
contentType/headers`, `request.body/url/headers/method/variables/environment`, `jsonPath`, `xpath`,
`crypto.sha1/sha256/md5` and `crypto.hmac.*`, `await sleep(ms)`, and the dynamic variables as plain
identifiers. Test results and `client.log` output are shown with the response — a handler that asserted
and passed says so.

They run in the review window, which Electron gives kakapo sandboxed and without node integration: a
handler has no `require`, no `fs` and no `process`, and nothing runs until you press `▶` on a request whose
text is in front of you. Reading a repository should not run it.

**Saving.** `>> out.json` writes beside an existing file (`out-1.json`); `>>! out.json` overwrites.
`{{$historyFolder}}` resolves to kakapo's own app-data mirror — it never writes kakapo's state into the
repository you are reading. The cookie jar lives there too, in IntelliJ's readable
`# domain path name value date` format.

**Running other files.** `run ./smoke.http` runs every request in that file, `run #login` runs one by
name (searched here first, then through whatever this file `import`s), and
`run ./other.http#login (@host = https://staging.test)` overrides variables for that call alone. A file
that would run itself is stopped and says so.

**Collections.** A variable holding a JSON array makes a request a loop: `@ids = [1, 2, 3]` with
`GET {{base}}/items/{{ids}}` sends three requests, and a handler reads `request.iteration()` to know which
one it is in.

**Script modules.** A handler may `import` from a `.js` file beside it, in any of the ES6 forms (named,
default, namespace, renamed), and those modules may import each other. They run in the same sandbox as the
handler: no `require`, no `fs`, no `process`.

**Client certificates.** `SSLConfiguration` in `http-client.private.env.json` — `clientCertificate`,
`clientCertificateKey`, `verifyHostCertificate` — is honoured. The certificate is read in the main
process, from inside the review, and never passes through the page. A key with a passphrase is refused by
name: IntelliJ asks for it interactively and kakapo has nowhere to ask.

**Not ported.** gRPC (it needs a protobuf runtime, and this CLI carries no runtime dependency it has no
review reason for), OAuth2 `Security.Auth` flows, `@use-os-credentials` (recognised as a directive, but
there is no OS credential store to hand to a request), `$exampleServer`, the full Java Faker generator set
(the common ones are there; an unimplemented one is reported by name), and importing a `curl` command —
kakapo never writes to the file you are reading, so there would be nowhere to put it. WebSocket runs the
messages a file lists and shows the exchange; it is not IntelliJ's live console.

## Git history

`⌘9` opens the repository's read-only histories. It never changes anything: there is no commit, push,
rebase, checkout or stash-apply here, because the thing kakapo is for is reading a change someone (or
something) already made.

**Three kinds,** switched in the bar: **Commits** (the log, as a graph with branch lanes and ref chips),
**Reflog** (where `HEAD` has been — the one view that still holds a commit a reset or a rebase dropped),
and **Stashes**. A row from any of them opens in the main review surface, with the diff, the navigation and
the comments you already have; a stash opens against its first parent, which is where `HEAD` was when it
was made.

**Filters are applied by git,** not by hiding rows that are already on screen: author, path, a branch,
tag or revision to walk instead of all of them, changed code (git's pickaxe), a date range, the message, and
current-branch-only against every branch. The distinction
matters — a page holds a few hundred commits, so filtering within it answers "no commits by Ada" when what
it means is "none in the last few hundred".

**Go to a commit.** Type a hash, a branch, a tag or `HEAD~3` into the search box: if it names a commit, the
strip offers to open it even when it is nowhere in the current page. Anything that names nothing stays an
ordinary message filter. `⌘C` copies the selected commit's hash.

**One file, one line.** `⌥Enter` on a file in the sidebar shows that file's history, followed through its
renames. Right-clicking a line number shows the blame for the file in the gutter — date and author, tinted
by age — and clicking an attribution opens the commit that wrote that line. Right-clicking a line number
with history open scopes the list to that single line (`git log -L`), so you see only the commits that
actually changed it.

**Compare two commits.** Shift-click (or `⇧↑↓`) two rows and open the range: every change between those two
patch sets, in one review. `⌥A` / `⌥U` / `⌥C` do the branch-level version of the same question — see
[Choosing what to compare](#choosing-what-to-compare).

## Bundled language servers

| Language | Analyzer | Runtime shipped with it |
| --- | --- | --- |
| TypeScript / JavaScript | `typescript-language-server` | Electron's Node host |
| Python | Pyright | Electron's Node host |
| Go | `gopls` | Go SDK |
| Rust | `rust-analyzer` | Cargo, Rust stable, `rust-src` |
| C / C++ | `clangd` | Platform-native clangd |
| Java | Eclipse JDT LS | Temurin JRE 21 |
| Kotlin | JetBrains Kotlin LSP | Dedicated JetBrains Runtime |
| Ruby | Sorbet | Platform-native Sorbet |
| PHP | Phpactor | Static PHP 8.4 runtime |

A packaged build always prefers its own bundle and never searches your shell `PATH`; only an explicit `KAKAPO_LSP_<LANGUAGE>` executable overrides it. A binary from inside the repository you are reading is **not** a candidate unless you set `KAKAPO_LSP_PROJECT_SERVERS=1` — reviewing a repository should not run that repository's code, and the analysis prewarm starts a server without being asked. Packaging fails unless all nine bundles exist *and* return real cross-file definitions. Unsupported languages, or a server that can't answer, fall back to a regex index that says so in the results.

Semantic quality still depends on project metadata: Maven/Gradle for Java and Kotlin, `Cargo.toml` for Rust, `go.mod` for Go, `compile_commands.json` for large C/C++, Composer autoload for PHP. Analysis caches and the JDT/Kotlin workspaces are kept in temp/app-data, never inside your repository.

## Where state lives

Review threads sit in the repository's own Git directory:

```text
.git/worktrees/<name>/kakapo/comments.jsonl   # this worktree's review conversation
```

Everything else is mirrored per absolute workspace path under the OS app-data directory — for `/Users/me/repos/acme/turtle` on macOS:

```text
~/Library/Application Support/Kakapo/workspaces/Users/me/repos/acme/turtle/
├── state.json
├── perf/
└── review/app-review.html
```

Paths are readable, not hashed. A repository root, a package inside it and a separate worktree can all be open at once with independent state.

## Development

```bash
npm install
npm run lsp:install
npm run build
npm run lsp:smoke
npm test
npm run smoke
```

`npm run mermaid:smoke` is separate on purpose. Mermaid's `render()` measures text through `getBBox`, which
jsdom does not implement, so whether a diagram actually lays out can only be answered in the real app — it
opens a window for about twenty seconds, and needs no Kakapo already running from this checkout.

Review another repository with a local build:

```bash
npm run dev -- --cwd /path/to/repository
```

Build the app and the installable disk image:

```bash
npm run dist:mac:dmg
```

That bundles the language servers, builds, packages the Apple Silicon app, runs the bundled-server smoke test and writes `release/Kakapo-<version>-arm64.dmg`. kakapo is packaged for macOS on Apple Silicon only.

Measure performance with `npm run benchmark` (`-- --files 5000 --changed 200 --lines 120` for a larger synthetic repo).

Tests run against real temporary Git repositories and the built `dist/`, covering diff, search, comments, history, LSP fallback, state persistence and the Electron layout. Two checks go further than the suite can: `npm run mermaid:smoke` and `npm run nav:smoke` launch the real app and drive it over the Chrome DevTools Protocol — real key events, the real language server, and `getComputedStyle` on what was drawn. That is where a structure list with no nesting (tsserver answers in the flat symbol shape) and a bookmark mark that painted nothing (`attr()` on a pseudo-element reads the cell's attributes, not the row's) were caught; neither is visible to jsdom. Set `KAKAPO_SMOKE_SHOTS=<dir>` to keep screenshots from a run. The user-visible flows are listed in [test/USER_FLOWS.md](test/USER_FLOWS.md).

## Design principles

- Trust the real diff over a chat summary.
- Separate confirmed impact from candidates worth checking.
- Keep review evidence next to its file and line.
- Keep state local, in plain Markdown / JSON / JSONL.
- Stay independent of any single AI, editor plugin, worktree strategy or hosting service.

## License

MIT
