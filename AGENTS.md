# Marque — shared agent instructions

Context marker: `marque:AGENTS.md`

This file is the canonical shared rule source for agents working on this repo; vendor bridges (`CLAUDE.md`, …) add only harness-specific deltas.

## What this is

`marque` is a Tauri-based desktop markdown viewer — a hard fork of GRVYDEV/marky (Apache-2.0), renamed and detached from upstream. Primary use case: viewing agent-generated plans and other markdown docs with good rendering of tables, code blocks, task lists, math, and mermaid diagrams. Launched via `marque FILENAME` to open a file or `marque FOLDER` to open a folder as a **folder workspace**. Folders persist across sessions (Obsidian-style), shown in a left sidebar. A **Cmd+K command palette** fuzzy-searches files across all folders.

Live project state is NOT in this file: `ROADMAP.md` carries the wanted-later ledger, `MISSING.md` the current version's punch-list.

## Stack (authoritative — do not swap without asking)

- **Tauri v2** — desktop shell, Rust backend
- **Vite + React + TypeScript** — frontend
- **pnpm** — package manager (not npm, not yarn)
- **markdown-it** — parser (not remark, not marked)
- **Shiki** — syntax highlighting (not highlight.js, not Prism)
- **shadcn/ui** — UI component primitives (Radix-based, copied into `src/components/ui/`)
- **Tailwind CSS** — styling
- **mermaid** for diagrams (it bundles KaTeX for its own labels; markdown math is not rendered yet, see `ROADMAP.md`)
- **nucleo** (Rust) — fuzzy matcher for Cmd+K file search
- **cmdk** via shadcn `<Command />` — command palette UI
- **notify** (Rust) — file watching per folder
- **DOMPurify** — sanitize rendered HTML before injection
- **lucide-react** — the only icon library

If a request would require swapping one of these, stop and confirm.

Platform reality: developed and used on Fedora Linux / Wayland, built against system `webkit2gtk4.1`. Releases are built by `.github/workflows/release.yml` on maintainer-signed `v*` tags: Linux x86_64/arm64 (deb, rpm, AppImage), macOS universal (dmg), Windows x64 (NSIS, MSI) — the upstream marky release machinery stays gone.

## Project layout

```
src-tauri/   Rust backend — cli, commands, error, folder, fs, registry, search, settings, watcher
src/         React frontend — rendering pipeline (lib/), UI components
scripts/     Install / dev helper scripts
```

## Core conventions

### Rust (`src-tauri/`)
- Keep `main.rs` thin — it only calls `marque_lib::run()`. Setup lives in `lib.rs`; logic is delegated to `cli.rs`, `fs.rs`, `folder.rs`, `registry.rs`, `search.rs`, `settings.rs`, `watcher.rs`, `commands.rs`.
- All frontend-callable functions live in `commands.rs` and are registered in `lib.rs`'s `invoke_handler`.
- Style: happy path unindented, errors wrapped with context (`anyhow::Context` or `thiserror`).
- File paths crossing the Rust↔JS boundary are always absolute strings.
- **Folder state** lives in a single shared `FolderRegistry` (`registry.rs`) in Tauri managed state. Don't scatter folder state across modules.
- **Fuzzy search index** is rebuilt from the registry on watcher events, debounced. Keep it in-memory only.
- Settings live at `~/.config/marque/settings.json` (`settings.rs::settings_dir()`, XDG config home), with a one-shot legacy migration from `~/.local/share/marky/`. Never delete the legacy file.

### Frontend (`src/`)
- Markdown pipeline lives in `src/lib/markdown.ts` as a single configured `markdown-it` instance. Do not create ad-hoc instances elsewhere.
- Shiki highlighter is a lazy singleton in `src/lib/highlight.ts` — loading grammars is expensive, load once.
- All `invoke()` calls go through typed wrappers in `src/lib/tauri.ts`. Do not call `@tauri-apps/api` `invoke` directly from components.
- Components are function components with hooks. No class components.

### UI components
- Use **shadcn/ui** primitives from `src/components/ui/` for dialogs, buttons, dropdowns, tooltips, command palette, scroll areas, etc.
- Add new shadcn components via `pnpm dlx shadcn@latest add <component>` — do not hand-write primitives that shadcn already provides. (`shadcn` is a CLI used ad hoc, never a dependency in `package.json`.)
- Shadcn files in `src/components/ui/` are **owned by us** once added — edit them freely. Don't re-run `add` on an existing component without intent to overwrite. Icons in them come from `lucide-react`.
- App-specific composite components (Viewer, Toolbar, etc.) live in `src/components/` and compose the primitives from `ui/`.

### Styling
- Tailwind for layout and component chrome.
- shadcn's CSS variables (`--background`, `--foreground`, `--muted`, etc.) drive theme colors. Prefer those tokens over raw Tailwind colors so light/dark stay consistent.
- `src/styles/markdown.css` owns prose styles (headings, paragraphs, tables, blockquotes). Keep markdown styling there, not inline on components.
- Theme switching toggles the `dark` class on `<html>` (shadcn's default). System/light/dark via the theme provider in `src/lib/theme.tsx`.

## Security

- **Always sanitize rendered HTML with DOMPurify** before setting `dangerouslySetInnerHTML`. Markdown files may contain raw HTML.
- External links (`target="_blank"`) must go through the Tauri opener plugin to open in the system browser, not the webview.
- Tauri capabilities: grant only `fs:read` on user-selected paths, not blanket filesystem access.
- Release trust: `scripts/release/verify-tag.sh` gates every release on the maintainer's primary key fingerprint (repository variable `RELEASE_SIGNING_FINGERPRINT`); only `scripts/release/publish.sh` makes a release public, after the inventory and digest checks. Never weaken either or publish by another path.
- Local images go through the Tauri asset protocol. Its static scope in `tauri.conf.json` stays empty; `read_file` extends it at runtime (`fs::grant_asset_scope`) to the opened document's registered folder root or its own directory, widened to the enclosing git repository root unless that root is the home directory or one of its ancestors. Never add a blanket pattern such as `$HOME/**` there. Image `src` rewriting lives in the DOMPurify hook in `src/lib/markdown.ts`; the path resolver (`src/lib/images.ts`) must keep returning `null` for remote and foreign-scheme sources.

## Running / building

```bash
pnpm install
pnpm tauri dev           # dev with HMR
pnpm tauri build         # production bundle
./scripts/install-cli.sh # install marque CLI wrapper (Linux)
```

## Releases & versioning

- Cutting a release ("cut a release", "let's cut it", version bumps, tags) -> load `my-marque-release` (`.agents/skills/my-marque-release/SKILL.md`).
- `CHANGELOG.md`: land each slice under `[Unreleased]`; the release workflow extracts the version section for release notes.

## Testing

- Rust: `cargo test` inside `src-tauri/`.
- Frontend: Vitest (`pnpm test`) for `lib/` functions (markdown pipeline, path helpers). No need to test components heavily — this is a viewer, behavior is mostly visual.
- Typecheck: `pnpm typecheck`.
- CI (`.github/workflows/ci.yml`) runs typecheck, vitest, cargo test, and clippy with `-D warnings` — keep all four green.
- The repository is public: every workflow job runs on GitHub-hosted runners (never a self-hosted one — any fork PR could execute on it), actions are pinned to commit SHAs, and workflow permissions stay least-privilege. Dependabot (`.github/dependabot.yml`) owns routine bumps; `.coderabbit.yaml` configures the automated PR review. `src-tauri/.cargo/audit.toml` lists `cargo audit` ignores for transitive advisories with no upstream fix — re-check them on each parent bump.
- Before reporting a rendering task done, run `pnpm tauri dev` and actually view a markdown file. Type checks don't catch rendering bugs.

## What not to do

- Don't add Electron fallbacks or wrappers.
- Don't add a markdown editor — this is read-only by design. No contenteditable, no textareas for editing.
- Don't persist user data outside `~/.config/marque` (settings) — folders are pointers; marque never writes inside them.
- Don't fetch remote resources at runtime (except images referenced in the markdown itself). No telemetry, no auto-update pings without explicit opt-in.
- Don't over-abstract. This is a single-purpose app — keep the component tree flat.
- Don't re-add upstream-sync machinery (remotes, sync scripts, upstream release workflows) — the fork is hard.

## When adding a new markdown feature

1. Is there a `markdown-it-*` plugin? Prefer that over a custom renderer rule.
2. Register it in `src/lib/markdown.ts`.
3. Add styling to `src/styles/markdown.css`.
4. Add a fixture and a Vitest case.

## Folder conventions

- A folder is a **pointer to a directory** — marque never writes inside it. All folder state (name, id) lives in `~/.config/marque/settings.json`.
- Default ignore list for folder trees: hidden dotfiles, `node_modules`, `.git`, `target`, `dist`, `build`. Centralized in `folder.rs::DEFAULT_IGNORES`.
- Default file extensions shown: `.md`, `.markdown`, `.mdx`.
- Folder IDs are UUIDs generated on add. Paths alone aren't stable identifiers (folders can move).

## Cmd+K conventions

- One canonical palette component: `CommandPalette.tsx`. Do not build ad-hoc search dialogs elsewhere.
- Palette sources are **pluggable** — each source is `{ id, label, search(query) -> results }`. Adding a new source (e.g. headings in current file) means adding a source, not forking the palette.
- Fuzzy matching for files happens in Rust (`nucleo`), not in JS. Keep the frontend dumb: query in, ranked results out.
