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

Inside the repository you want AI agents to work on, install the role instructions once:

```bash
ai-flow install --apply-agent-docs
```

This creates `.ai-flow/` and adds a short role-session snippet to `AGENTS.md` and `CLAUDE.md`.

After that, users should not need to know either ai-flow or cmux. The intended experience is:

```text
Open one Planner session in cmux.
Tell Planner what you want built.
Planner splits the work, dispatches Workers/Reviewers, reads their reports, and talks back to you.
```

For a non-technical user, the first useful thing to say is:

```text
Use Planner mode. I want <feature/fix>. Split it into small verified slices and run Workers as needed.
```

Planner then uses `ai-flow dispatch worker|reviewer` internally. If cmux is available, dispatch creates a helper pane and sends a short command to the selected agent. If cmux is missing, `ai-flow doctor` explains the single missing setup step.

When a Worker finishes, Planner can open a visual diff review:

```bash
ai-flow diff --cmux
```

The generated review page supports IntelliJ-style hunk navigation:

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
ai-flow init [--force]
```

Creates `.ai-flow/` with config, state, tasks, decisions, prompts, reports, and logs.

```bash
ai-flow install [--force] [--apply-agent-docs]
```

Installs role-session files under `.ai-flow/roles/` and `.ai-flow/cmux.md`. With `--apply-agent-docs`, it also adds the agent-facing trigger snippet to `AGENTS.md` and `CLAUDE.md`.

```bash
ai-flow start planner|worker|reviewer [--agent manual|codex|claude] [--task T001]
```

Starts a role session by generating the current role brief from repository state. Agents call this internally after the user chooses a role.

```bash
ai-flow finish planner|worker|reviewer [--task T001] [--file report.md] [--complete]
```

Records the role report and appends a compact summary to `.ai-flow/state.md`. Workers pass `--complete` only after the task is verified.

```bash
ai-flow dispatch worker|reviewer --agent codex|claude [--task T001] [--dry-run]
```

Planner uses this to send a Worker or Reviewer into cmux. It saves the full prompt under `.ai-flow/prompts/`, creates a helper terminal pane when cmux is available, and sends the agent a short "read this prompt file" command.

```bash
ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--open] [--cmux]
```

Generates a browser-based side-by-side diff review under `.ai-flow/diffs/`. `--cmux` opens it in a cmux browser split. `F7` and `Shift+F7` move by changed hunk, not by file.

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
