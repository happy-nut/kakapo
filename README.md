# monacori

**A local desktop review workspace for AI-generated code changes.**

Run `mo` after an AI edits your repository. monacori opens a side-by-side diff, lets you attach line-level questions or change requests, and bundles that feedback back into the AI CLI (command-line interface) session running in the built-in terminal.

![monacori reviewing a diff, adding a change request, and targeting the built-in terminal](assets/monacori-demo.gif)

## Why monacori

AI coding tools are fast, but their "done" message is not a review. monacori gives the human reviewer a dedicated control surface for the gap between generated code and trusted code:

- See every changed, added, and untracked file in an IntelliJ-style review sidebar.
- Review side-by-side diffs with syntax highlighting, changed-line emphasis, and keyboard navigation.
- Leave questions or change requests directly on the relevant line.
- Send all reviewer comments, with file paths and code context, into `claude`, `codex`, or another terminal session without copy-paste.
- Keep all generated review state local, plain, and inspectable under `.monacori/`.

## Workflow

1. Let an AI coding tool make changes in your repository.
2. Run `mo` from that repository.
3. Inspect the diff, mark files as viewed, and attach line comments where needed.
4. Open the built-in terminal and keep your AI CLI session beside the review.
5. Send the merged questions or change requests back to the session as a focused follow-up prompt.

The result is a tighter review loop: the AI produces changes, the human reviews the actual diff, and the next prompt is grounded in exact file and line context.

## Install

```bash
npm install -g @happy-nut/monacori
```

The short command is `mo`.

## Quick Start

Inside any Git repository:

```bash
mo
```

On first run, `mo` creates `.monacori/`, adds it to `.gitignore`, and includes untracked files so new AI-created files appear immediately.

## Highlights

- **Desktop diff review**: reads the repository directly, refreshes from local Git state, and does not require a web server.
- **AI handoff comments**: questions and change requests are stored with their file, line, and code context.
- **Integrated terminal**: keep `claude`, `codex`, or a shell open inside the same window, with split panes when needed.
- **Source navigation**: jump between changed files, search indexed files, preview source, and move through hunks from the keyboard.
- **Plain local artifacts**: generated review files and state are Markdown, JSON, and static HTML under `.monacori/`.

## Development

Working on monacori itself? The globally-installed `mo` runs the **published** package, not your
checkout — local edits won't appear until you build and run locally.

Run your checkout directly (builds, then launches in the foreground with DevTools open):

```bash
npm run dev
```

This reviews the monacori repo itself. To review **another repo** with your local build, pass `--cwd`:

```bash
npm run dev -- --cwd /path/to/other-repo
```

**Which build is running?** A dev build titles its window `monacori (dev)` and opens DevTools, and
every launch prints its app path — so a local checkout is distinguishable from the installed package
even when their version numbers match:

```text
monacori: launching /…/repos/monacori/dist/app-main.js                       # local checkout
monacori: launching /…/lib/node_modules/@happy-nut/monacori/dist/app-main.js  # installed package
```

Prefer the `mo` command pointed at your checkout? `npm link` once, then rebuild after each change:

```bash
npm link                              # global `mo` now runs this checkout
npm run build                         # rebuild dist/ after editing src/
npm unlink -g @happy-nut/monacori     # restore the published `mo`
```

`src/viewer.client.js` and `src/viewer.css` are copied (not compiled) into `dist/` by the build, so
re-run `npm run build` (or `npm run dev`) after editing them.

### Tests

```bash
npm test
```

`npm test` builds, then runs the jsdom regression suite (`test/*.test.mjs`) against the built `dist/`.
It guards the core user flows end to end — see [test/USER_FLOWS.md](test/USER_FLOWS.md) — and the same
suite gates every release.

## Local State

Running `mo` creates a git-ignored `.monacori/` directory for generated diff reviews, local config, comments, logs, and validation notes. Keep it ignored unless your team intentionally wants to version review artifacts.

## Design Principles

- Real diffs beat chat summaries.
- Human review should stay close to the code and the running AI session.
- The core should be local, inspectable, and agent-agnostic.
- No required terminal multiplexer, editor plugin, hosted service, or worktree strategy.

## License

MIT
