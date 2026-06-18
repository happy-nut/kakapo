# ai-flow

Lightweight planning and verification control plane for AI coding agents.

`ai-flow` does not replace [cmux](https://cmux.com/), Claude Code, Codex CLI, OpenCode, Cline, or other coding agents. It gives them a shared workflow:

- one planner that reads the repo state and decides the next slice
- cmux-managed worker sessions that edit one slice
- cmux-managed read-focused reviewers or researchers
- durable state, prompts, reports, and verification logs in `.ai-flow/`

The default model is **one user-facing Planner, one writer at a time, many readers**. No git worktree is required.

## Why

AI coding sessions fail when the process depends on chat memory:

- the planner forgets what has already been done
- workers expand scope
- reviewers lack the acceptance criteria
- context fills up and handoff gets messy
- "done" is claimed without test evidence

`ai-flow` keeps the truth in the repository. Every session can restart from the same files, diff, tasks, reports, and logs.

## Install

```bash
npm install -g ai-flow
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

Inside the repository you want AI agents to work on, run one command:

```bash
ai-flow go
```

With no objective, Planner opens and asks what you want to build. It should not dump old project progress.

Or include the objective up front:

```bash
ai-flow go "add the missing empty state and verify it"
```

With an objective, Planner should split the work and immediately dispatch the first Worker when no user decision is needed.

That command bootstraps the repo, installs ai-flow role instructions when needed, opens cmux when available, and starts a Planner agent. After that, the intended experience is:

```text
Talk to Planner only.
Planner splits the work, dispatches Workers/Reviewers, opens diff reviews, and reports back.
```

If cmux is not available yet, `ai-flow go` falls back to the current terminal and `ai-flow doctor` explains the missing setup step.

The old manual bootstrap still works:

```bash
ai-flow install --apply-agent-docs
```

Planner then uses `ai-flow dispatch worker|reviewer` internally. If cmux is available, dispatch creates a helper pane and sends a short command to the selected agent. If cmux is missing, `ai-flow doctor` explains the single missing setup step.

When a Worker records completion, ai-flow automatically creates a visual diff review and opens it in cmux when available. For review while edits may still change, open a live review manually:

```bash
ai-flow diff --watch --cmux
```

The generated review page has a folder-tree sidebar and supports IntelliJ-style hunk navigation:

- `F7`: next changed hunk
- `Shift+F7`: previous changed hunk
- `]` / `[`: fallback keys if the browser captures function keys

Planner sessions maintain `.ai-flow/tasks.md`:

```markdown
- [ ] T001: Add empty state rendering for the login form.
- [ ] T002: Show a validation error when email is missing.
- [ ] T003: Add a regression test for failed login loading state.
```

## Manual Mode

The CLI remains available for agents, advanced users, and scripts.

```bash
ai-flow go --dry-run
ai-flow doctor
ai-flow status
ai-flow dispatch worker --agent codex
ai-flow dispatch reviewer --agent claude --task T001
ai-flow diff --open
ai-flow verify
ai-flow report --task T001 --file worker-report.md
```

## Commands

```bash
ai-flow go [what you want built] [--agent codex|claude] [--dry-run] [--no-cmux] [--no-auto-dispatch] [--apply-agent-docs]
```

Bootstraps the repository and starts Planner. When cmux is available and the command is run outside cmux, it opens a new cmux workspace for the Planner. When run inside cmux, it starts Planner in the current terminal. Without cmux, it starts Planner in the current terminal as a fallback.

Worker panes appear after Planner dispatches them. If you want that to happen immediately, pass the objective directly to `ai-flow go`.

By default, `go` only writes local `.ai-flow/` state, which is ignored by Git. Pass `--apply-agent-docs` only if you want ai-flow to update `AGENTS.md` and `CLAUDE.md` with reusable role trigger snippets.

```bash
ai-flow init [--force]
```

Creates `.ai-flow/` with config, state, tasks, decisions, prompts, reports, and logs. Because this is local orchestration state, ai-flow also adds `.ai-flow/` to `.gitignore` when the directory is inside a Git worktree.

```bash
ai-flow install [--force] [--apply-agent-docs]
```

Installs role-session files under `.ai-flow/roles/` and `.ai-flow/cmux.md`. With `--apply-agent-docs`, it also adds the agent-facing trigger snippet to `AGENTS.md` and `CLAUDE.md`.

```bash
ai-flow start planner|worker|reviewer [--agent manual|codex|claude] [--task T001]
```

Starts a role session by generating the current role brief from repository state. Agents call this internally after the user chooses a role.

```bash
ai-flow finish planner|worker|reviewer [--task T001] [--file report.md] [--complete] [--no-diff]
```

Records the role report and appends a compact summary to `.ai-flow/state.md`. Workers pass `--complete` only after the task is verified. Worker finish creates a visual diff review automatically and opens it in cmux when available; pass `--no-diff` only when that review pane is not wanted.

```bash
ai-flow dispatch worker|reviewer --agent codex|claude [--task T001] [--dry-run]
```

Planner uses this to send a Worker or Reviewer into cmux. It saves the full prompt under `.ai-flow/prompts/`, creates a helper terminal pane when cmux is available, and sends the agent a short "read this prompt file" command.

```bash
ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--open] [--cmux] [--watch]
```

Generates a browser-based side-by-side diff review under `.ai-flow/diffs/`. `--cmux` opens it in a cmux browser split. Add `--watch` to serve a live review that reloads when the working tree changes. The sidebar groups changed files as a folder tree, includes search, and has a Files tab for opening indexed source files even when they are unchanged. `F7` / `Shift+F7` move by changed hunk, not by file.

```bash
ai-flow doctor
```

Checks whether cmux, Codex CLI, and Claude Code are available and explains the next setup step in plain language.

```bash
ai-flow status
```

Prints current branch, git status, diff stat, next task, recent reports, and verification commands.

```bash
ai-flow next [--agent manual|codex|claude] [--role worker|reviewer] [--task T001]
```

Builds the next prompt from the current repo state and saves it under `.ai-flow/prompts/`.

```bash
ai-flow prompt worker|reviewer [--agent manual|codex|claude] [--task T001]
```

Generates a role-specific prompt.

```bash
ai-flow run worker|reviewer --agent codex|claude [--task T001] [--dry-run] [--print]
```

Launches the selected agent in the current checkout. It does not create a worktree.

```bash
ai-flow verify [-- <command>]
```

Runs configured verification commands and stores the log in `.ai-flow/logs/`.

```bash
ai-flow report [--task T001] [--file report.md]
```

Stores a worker report and appends a compact summary to `.ai-flow/state.md`.

## Claude and Codex

`ai-flow` supports both Claude Code and Codex CLI by treating them as adapters.

Codex:

```bash
ai-flow dispatch worker --agent codex
ai-flow run worker --agent codex
ai-flow run reviewer --agent codex --print
```

Claude:

```bash
ai-flow dispatch worker --agent claude
ai-flow run worker --agent claude
ai-flow run reviewer --agent claude --print
```

For manual control, generate the prompt and paste it into any agent:

```bash
ai-flow prompt worker --agent manual
```

## Repository State

`ai-flow init` creates:

```text
.ai-flow/
  config.json       verification commands and defaults
  state.md          durable progress and reports
  tasks.md          small verifiable slices
  decisions.md      project decisions that should survive context resets
  agent-snippet.md  instructions to paste into agent docs if needed
  cmux.md           agent-facing cmux dispatch protocol
  roles/            planner, worker, and reviewer lifecycle protocols
  diffs/            generated browser diff reviews
  prompts/          generated worker/reviewer prompts
  reports/          worker reports
  logs/             verification logs
```

Commit `config.json`, `state.md`, `tasks.md`, `decisions.md`, `agent-snippet.md`, `cmux.md`, and `roles/` if you want the process to travel with the repo. Keep prompts, reports, and logs local unless your team wants those artifacts in version control.

## Design Principles

- Single writer by default.
- The user talks to Planner; Planner talks to cmux.
- Readers can plan, review, research, and debug without editing.
- The current repo state beats chat memory.
- A task is not done until verification evidence exists.
- Generated prompts should be small enough to review.
- Claude, Codex, and manual copy/paste should all work.

## Status

This is an early MVP. The CLI is intentionally small and does not attempt to be a full autonomous agent platform.

Planned:

- configurable prompt templates
- stricter report parsing
- machine-readable task state
- more adapters

## License

MIT
