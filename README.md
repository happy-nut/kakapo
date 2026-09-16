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

Download `Kakapo-<version>-arm64.dmg` from [Releases](https://github.com/happy-nut/kakapo/releases). The build is unsigned, so the first launch needs right-click → **Open** to get past Gatekeeper.

### Linux (x64 / ARM64)

Every PR, `main` push and release runs the full test suite on a native Ubuntu runner for both architectures, packages the app, and verifies a real Chromium renderer opens under Xvfb. Only builds that pass are published.

```bash
tar -xzf Kakapo-<version>-linux-x64.tar.gz
./Kakapo-linux-x64/Kakapo --cwd /path/to/repository
```

Swap `x64` for `arm64` on ARM. Neither package needs a system Electron, Node.js, language server, JRE, PHP or Go/Rust toolchain.

### Windows (x64)

Download `Kakapo-<version>-windows-x64.zip` from [Releases](https://github.com/happy-nut/kakapo/releases), extract it, and run `Kakapo.exe`. The build is unsigned, so SmartScreen needs **More info → Run anyway** on first launch. TypeScript and Python language servers are bundled; the other seven language families use a server on your `PATH` or fall back to the regex index.

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

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘0` / `⌘1` | Changes / Files panel |
| `F7` / `⇧F7` | Next / previous changed hunk |
| `Space` | Toggle *Viewed* on the selected changed file |
| `?` | Comment on the current line |
| `F8` / `⇧F8` | Next / previous comment |
| `⌘⇧/` | All review comments (one hand-off document) |
| `⌘9` | Git history |
| `⌘F` / `⌘⇧F` | Find in file / in project (the ⌘⇧F rail also holds file search & recent files) |
| `⌥A` / `⌥U` | All changes on the branch / only what is not committed yet |
| `⌥C` | Choose the branch "all changes" is measured against |
| `⌘B` / `⌘⌥B` / `⌘⌥O` | Definition & usages / implementation / workspace symbol |
| `⌘,` | Settings |

Settings ▸ Shortcuts lists the rest.

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

A packaged build always prefers its own bundle and never searches your shell `PATH`; only an explicit `KAKAPO_LSP_<LANGUAGE>` executable overrides it, and a repository-local binary is accepted only in a source checkout that hasn't installed the bundle yet. Packaging fails unless all nine bundles exist *and* return real cross-file definitions. Unsupported languages, or a server that can't answer, fall back to a regex index that says so in the results.

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

Paths are readable, not hashed. A repository root, a package inside it and a separate worktree can all be open at once with independent state. On Linux the same tree lives under `${XDG_CONFIG_HOME:-~/.config}/Kakapo/workspaces/...`.

## Development

```bash
npm install
npm run lsp:install
npm run build
npm run lsp:smoke
npm test
npm run smoke
```

Review another repository with a local build:

```bash
npm run dev -- --cwd /path/to/repository
```

Build a Linux package and check a real desktop renderer:

```bash
npm run dist:linux:x64   # or dist:linux:arm64
npm run smoke:linux
```

Linux packages are only produced on a Linux host of the same architecture, so a cross build can't ship missing platform-specific optional dependencies; running the command on macOS fails immediately instead of producing an incomplete artifact. macOS builds come from `npm run dist:mac:dmg`.

Measure performance with `npm run benchmark` (`-- --files 5000 --changed 200 --lines 120` for a larger synthetic repo).

Tests run against real temporary Git repositories and the built `dist/`, covering diff, search, comments, history, LSP fallback, state persistence and the Electron layout. The user-visible flows are listed in [test/USER_FLOWS.md](test/USER_FLOWS.md).

## Design principles

- Trust the real diff over a chat summary.
- Separate confirmed impact from candidates worth checking.
- Keep review evidence next to its file and line.
- Keep state local, in plain Markdown / JSON / JSONL.
- Stay independent of any single AI, editor plugin, worktree strategy or hosting service.

## License

MIT
