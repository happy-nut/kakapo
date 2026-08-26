# Kakapo

**A desktop workspace for reviewing what the AI actually changed — and handing the review straight back to it.**

*[한국어 README](README_KR.md)*

Coding agents are fast. Reading their output is not. Kakapo is built for that half of the loop: a real diff, real language-server navigation, and a review conversation that the agent can read and answer without you copy-pasting anything.

![Creating a worktree workspace in Kakapo, reviewing the agent's diff, and getting its answer back on the line](assets/kakapo-core-flow.gif)

## Why Kakapo

**The diff is the source of truth, not the chat log.** An agent's "done ✅" is a claim. Kakapo opens the actual Git diff in an IntelliJ-style side-by-side view, with folded context you can expand, hunk navigation (`F7`), and per-file *Viewed* state — so you review what landed, not what was reported.

**Your comments go back to the agent; its answers come back on the line.** Press `?` on any line to ask a question or request a change. `⌘⇧/` merges every open comment into one request, writes it to `.git/kakapo/`, and hands the agent a single line naming that file. The agent appends its replies to the same thread and they appear as replies under your comment — no prompt-assembly, no scrolling walls of pasted text. `F8` walks every thread until nothing is left open.

**`⌘7` makes the agent explain its own diff.** It walks the change and leaves plain-language note cards on the lines that matter, marking where a change goes wrong and where it is fixed. What it learns about the codebase accumulates in `.git/kakapo/knowledge.jsonl`, shared by every worktree of the repository — so the next explanation doesn't start from zero.

**One window, one worktree per task.** `⌘N` creates a managed worktree under `~/kakapo/workspaces/<repo>/<task>`, fetches the base branch first, and can start `claude` or `codex` in it right away. Agents keep running in the background when you switch away (tmux-backed, so they survive an app restart); the left rail badges which workspace is working and which is waiting on you, and a finished turn in another workspace sends a native notification. `⌘⌥1–9` switches instantly.

**IDE-grade reading with zero setup.** Go to definition, references, implementations and workspace symbols work across the diff via real language servers; Change Impact separates confirmed callers, importers and implementors from candidate tests and types; project search runs on bundled ripgrep. Nine language toolchains ship inside the app — no `PATH` lookup, no installs, no editor plugins.

**It never writes into your project.** Review threads live in `.git/kakapo/` (Git never tracks its own directory, so `git status` stays clean, and a cwd-sandboxed agent can still reach them). Everything else lives in the OS application-data directory, keyed by absolute workspace path. Plain JSONL, Markdown and JSON — fully local, no account, no telemetry, MIT.

## The loop

1. The agent works in the workspace terminal (``⌃` ``).
2. You read the real diff — `F7` between hunks, `Space` to mark a file reviewed.
3. `?` on a line to ask a question or request a change.
4. `⌘⇧/` to merge and send; `⌥Enter` hands it to the agent.
5. The agent fixes and answers inline; `F8` walks the answers.

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
```

## Running it

Run `kakapo` inside any Git repository or a package folder inside a monorepo:

```bash
kakapo
kakapo --cwd /path/to/repository/package
```

Kakapo runs as a single instance. Running `kakapo` again from another repository or worktree joins the existing app and opens that workspace; if the path is already open it just focuses it. Subfolders are normalised to the Git top level, so the same checkout never opens twice, while separate worktrees stay separate workspaces.

### Workspaces

The left rail is always there: the selector at the top shows the current repo, branch and activity, and `⌘K` (or clicking it) opens the workspace list.

`⌘N` (or **New**) picks a local clone and a task name and creates `<prefix>/<slug>` in `~/kakapo/workspaces/<repo>/<slug>`. The base is resolved in order — `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` — and fetched first; offline, it continues from the local base with a warning. The fetch never blocks the UI and can be cancelled. You can have the new workspace start an agent immediately, or open a plain terminal and start one yourself.

Each workspace's `⋯` menu renames it, detaches it into its own window, or closes it. Deleting a generated worktree warns separately about uncommitted changes, unpushed commits and running terminals or agents, and keeps the branch by default. The main checkout can only be closed, never deleted. Reopening the app restores the list and the last active workspace; a workspace whose path is gone stays as `disconnected` rather than disappearing quietly. Sessions where a Claude or Codex run was detected can be resumed from the rail.

### Choosing what to compare

By default the working tree is compared against an automatic base: the upstream merge-base when the branch has unpushed commits, otherwise `HEAD`. When the agent's work is already committed, pick the base yourself — from the toolbar, or up front:

```bash
kakapo --base main          # working tree vs main (review a whole AI feature branch)
kakapo --base v0.2.0        # vs a tag
kakapo --base 9f3c1a2       # vs a commit
kakapo --staged             # index vs HEAD
```

`--base` takes any revision and validates it at startup; `--staged` and `--base` are mutually exclusive. The review status bar always says what is being compared. Inside the app, the patch-set selector lets you diff against any single commit on the branch, and `⌘9` opens the commit graph — Enter on a commit opens it in the main review.

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘K` / `⌘N` | Switch workspace / create a managed worktree |
| `⌘⌥1–9` | Jump to a workspace |
| `⌘0` / `⌘1` | Changes / Files panel |
| `F7` / `⇧F7` | Next / previous changed hunk |
| `Space` | Toggle *Viewed* on the selected changed file |
| `?` | Comment on the current line |
| `⌘⇧/` | All review comments (merged request; `⌥Enter` sends) |
| `F8` / `⇧F8` | Next / previous comment or Explain note |
| `⌘7` | Explain — let the agent annotate this diff |
| `⌘8` / `⌘9` | Change Impact / Git history |
| `⇧⇧` / `⌘F` / `⌘⇧F` | Find file / in file / in project |
| `⌘B` / `⌘⌥B` / `⌘⌥O` | Definition & usages / implementation / workspace symbol |
| ``⌃` `` / `⌘D` | Toggle terminal / split pane |
| `⌘⇧P` / `⌘⇧N` | Prompt palette / prompt memo |
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

Review threads and accumulated codebase notes sit in the repository's own Git directory:

```text
.git/worktrees/<name>/kakapo/comments.jsonl   # this workspace's review conversation
.git/kakapo/knowledge.jsonl                   # codebase notes, shared by all worktrees
```

Everything else is mirrored per absolute workspace path under the OS app-data directory — for `/Users/me/repos/acme/turtle` on macOS:

```text
~/Library/Application Support/Kakapo/workspaces/Users/me/repos/acme/turtle/
├── memo.json
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

Regenerate the README GIF with `npm run demo:gif`, and measure performance with `npm run benchmark` (`-- --files 5000 --changed 200 --lines 120` for a larger synthetic repo).

Tests run against real temporary Git repositories and the built `dist/`, covering diff, search, comments, memos, history, LSP fallback, state persistence and the Electron layout. The user-visible flows are listed in [test/USER_FLOWS.md](test/USER_FLOWS.md).

## Design principles

- Trust the real diff over a chat summary.
- Separate confirmed impact from candidates worth checking.
- Keep review evidence next to its file and line.
- Keep state local, in plain Markdown / JSON / JSONL.
- Stay independent of any single AI, editor plugin, worktree strategy or hosting service.

## License

MIT
