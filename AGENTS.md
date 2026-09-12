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

When adding commands or shortcuts, update `printHelp` in `src/commands.ts`, the Settings ▸ Shortcuts sheet
in `src/render.ts`, and both READMEs.
