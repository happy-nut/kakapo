# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`monacori` is a small TypeScript CLI. Its job is to validate AI-generated code changes by running verification commands, creating diff review artifacts, and preserving compact evidence.

It is not an autonomous coding agent or orchestration layer. Keep the core simple, local, and validation-oriented.

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
  user-data directory; never create or write a project-local `.monacori/` directory.
- Prefer plain Markdown and JSON artifacts so users can inspect and edit everything.
- Do not introduce git worktree, terminal multiplexer, editor, or agent-specific requirements.
- Treat AI tools as producers of changes; monacori is the verifier of those changes.

## Quality Bar

Every behavior change should include:

- a focused implementation
- a smoke test or command-level verification
- documentation updates when CLI behavior changes

When adding commands, update both `src/cli.ts` help output and `README.md`.
