# ai-flow

Validation control plane for AI-generated code changes.

`ai-flow` is not an agent orchestrator. It does not manage panes, sessions, worktrees, or model adapters. Its job is narrower: after an AI edits a repository, produce verification evidence that a human can trust.

It gives you:

- detected verification commands in `.ai-flow/config.json`
- repeatable verification logs under `.ai-flow/logs/`
- a local desktop review app for live diff inspection
- diff2html review pages under `.ai-flow/diffs/`
- searchable source previews, including unchanged indexed files
- compact validation reports under `.ai-flow/reports/`

## Why

AI coding output is hard to trust when review depends on chat memory or vague "done" claims. `ai-flow` keeps the review artifacts in the repository so the state can be inspected, rerun, and discussed.

The intended loop is simple:

```text
AI edits code.
ai-flow runs verification.
ai-flow creates a reviewable diff artifact.
You inspect evidence before accepting the change.
```

## Install

```bash
npm install -g ai-flow
```

After installation, the short command is:

```bash
aif
```

Homebrew tap distribution is prepared through `Formula/ai-flow.rb`. Once the npm package is published and the formula is copied to the `happy-nut/homebrew-ai-flow` tap, the intended install path is:

```bash
brew install happy-nut/ai-flow/ai-flow
```

For local development:

```bash
git clone https://github.com/happy-nut/ai-flow.git
cd ai-flow
npm install
npm run build
npm link
```

## Quick Start

Inside the repository you want to validate:

```bash
aif
ai-flow check --include-untracked
```

`aif` opens the local desktop review app for the current directory. On first run it creates `.ai-flow/`, updates Git ignore rules for `.ai-flow/`, and includes untracked files so new AI-created files show up immediately.

`check` runs configured verification commands, writes a log, creates a browser diff review, and records a compact report.

For a one-off command:

```bash
ai-flow check -- npm test
```

For live diff review while an AI is still editing:

```bash
aif
```

## Diff Review

The desktop review app is powered by Electron and diff2html. It reads Git diff and source files directly from the local repository, writes a local `.ai-flow/app-review.html` file, and refreshes when the working tree changes. It does not start an HTTP server.

- `F7`: show the next changed hunk, starting from the current source file when possible
- `Shift+F7`: previous changed hunk
- `]` / `[`: fallback keys if the browser captures function keys
- `Shift Shift`: search indexed files, including unchanged files
- `Cmd/Ctrl+E`: open recent files
- `Cmd/Ctrl+Down`: jump from the source cursor to a declaration-like match for the symbol under it

The app opens as a read-only source viewer by default. The `Files` tab opens indexed files even when they are unchanged, and `F7` switches into the diff view when you want to inspect changes. Drag-copying source text adds `path:line-range` plus a fenced code block to the clipboard so the snippet can be pasted into an AI prompt with context. Viewed marks are stored with file signatures, so a file becomes unviewed again when it changes.

The browser artifact path is still available through `ai-flow diff`. Add `--watch` there only when you specifically want a browser-served live review.

## Commands

```bash
ai-flow open [--base HEAD] [--staged] [--tracked-only] [--context 12] [--no-watch]
```

Opens the local desktop review app for the current directory. `aif` and bare `ai-flow` are aliases for this default flow. It auto-initializes local state when needed and includes untracked files by default; pass `--tracked-only` to inspect tracked changes only.

```bash
ai-flow check [--include-untracked] [--staged] [--base HEAD] [--context 12] [--open] [--no-verify] [--no-diff] [-- <command>]
```

Runs verification and creates a validation report. By default it uses commands from `.ai-flow/config.json`; pass `-- <command>` to override for one run.

```bash
ai-flow init [--force]
```

Creates `.ai-flow/` with config, state, decisions, reports, logs, and diff directories. Because these are local validation artifacts, ai-flow also adds `.ai-flow/` to `.gitignore` inside Git worktrees.

```bash
ai-flow install [--force] [--apply-agent-docs]
```

Writes `.ai-flow/agent-snippet.md`, a short instruction block telling AI agents to run validation before claiming completion. With `--apply-agent-docs`, it updates `AGENTS.md` and `CLAUDE.md` marker blocks where available.

```bash
ai-flow verify [-- <command>]
```

Runs configured verification commands and stores the log in `.ai-flow/logs/`. Exits non-zero on failure.

```bash
ai-flow app [--base HEAD] [--staged] [--include-untracked] [--context 12] [--no-watch]
```

Launches the local desktop review app. `aif`, `ai-flow open`, and `ai-flow review` are aliases. Prefer `aif` for normal use.

```bash
ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--context 12] [--output review.html] [--open] [--watch] [--port 0]
```

Generates a browser-based side-by-side diff review. Add `--watch` to serve a live review that reloads when the working tree changes.

```bash
ai-flow status
```

Prints current branch, git status, diff stat, configured verification commands, recent reports, and recent logs.

```bash
ai-flow report [--label manual] [--file report.md]
```

Stores a manual report under `.ai-flow/reports/` and appends a compact summary to `.ai-flow/state.md`.

## Repository State

`ai-flow init` creates:

```text
.ai-flow/
  config.json       verification commands and diff defaults
  state.md          compact validation history
  decisions.md      durable validation decisions
  diffs/            generated browser diff reviews
  reports/          validation reports
  logs/             verification logs
```

`ai-flow install` also writes `.ai-flow/agent-snippet.md` for projects that want to paste or apply agent-facing validation instructions.

Keep `.ai-flow/` ignored unless your team explicitly wants to commit validation state.

## Design Principles

- Verification evidence beats chat memory.
- Generated artifacts should be plain Markdown, JSON, logs, or static HTML.
- The tool should not require a specific AI agent, terminal multiplexer, editor, or worktree strategy.
- The default command should be useful after any AI-generated edit.
- A change is not accepted until verification evidence is clear or the gap is explicitly documented.
