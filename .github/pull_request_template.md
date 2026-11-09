## Summary

<!-- What changes and why. Link the issue if there is one. -->

## How it was verified

<!-- Commands run, markdown fixtures viewed in `pnpm tauri dev`, screenshots for rendering changes. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `cargo test` and `cargo clippy -- -D warnings` pass in `src-tauri/`
- [ ] Rendering changes were viewed in the running app, not only typechecked
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` (user-visible changes only)
- [ ] No new dependency outside the stack listed in `AGENTS.md`, or the swap was discussed first
