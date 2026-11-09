# Contributing to Marque

Thanks for considering a contribution. Marque is a small, single-purpose markdown viewer, so the bar is "does it make viewing markdown better without making the app bigger than it needs to be."

## Before you start

- Open an issue first for anything beyond a small fix. It saves you from building something that will not be merged.
- The stack is fixed: Tauri v2, Vite + React + TypeScript, pnpm, markdown-it, Shiki, shadcn/ui, Tailwind, Mermaid, KaTeX, nucleo, notify. Proposals that swap one of these need a discussion first.
- Marque is read-only by design. Editing features will not be merged.
- `AGENTS.md` holds the project conventions (file layout, Rust and frontend rules, security requirements). Read it; it applies to humans too.

## Development setup

Requires Rust, Node.js LTS, pnpm, and the system `webkit2gtk4.1` development packages (see the README).

```bash
pnpm install
pnpm tauri dev
```

## Checks

CI runs these four and all must pass:

```bash
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

For rendering changes, also open a real markdown file in `pnpm tauri dev` and look at it. Typechecks do not catch rendering bugs.

## Pull requests

- Branch from `main`. Keep one concern per PR.
- Commit subjects follow `type: summary` (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`, `refactor:`), in English.
- Add a line under `[Unreleased]` in `CHANGELOG.md` for user-visible changes.
- New markdown features: prefer an existing `markdown-it-*` plugin, register it in `src/lib/markdown.ts`, style it in `src/styles/markdown.css`, and add a fixture plus a Vitest case.
- PRs get an automated first-pass review and a maintainer review. Address or answer the comments; it is fine to push back.

## Dependencies

Dependency bumps arrive weekly through Dependabot. Pin exact versions when you add a dependency by hand, and say in the PR why the dependency is needed.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0, the same license as the project.
