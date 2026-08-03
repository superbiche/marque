# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Hard fork - 2026-08-02

Renamed project from `marky` to `marque`. New home at [superbiche/marque](https://github.com/superbiche/marque) (private). Upstream tracking with `GRVYDEV/marky` has ended.

## [Unreleased]

### Added
- Collapse-all button on each sidebar folder header (visible on hover) — folds every subdirectory of that folder

### Changed
- Sidebar folders remember which subdirectories were expanded: folding a folder (or its workspace header) and reopening it restores the exact expansion state instead of auto-unfolding the first level. Directories now start collapsed.

## [0.3.0] - 2026-08-03

### Added
- Marque logo — app icon set and README banner
- Content zoom, separate from UI scaling: Ctrl/⌘ +/−/0, toolbar zoom buttons, and a "Content Text Size" control in Settings (70–200%)
- Content width modes: Narrow (860px), Wide (1200px), Full
- Working document links: relative and absolute links to other markdown files open in a tab (with `#heading` scroll), in-page anchors scroll, external URLs open the system browser, other file links open in the system handler
- Release workflow: every `v*` tag builds and uploads Linux bundles (deb, rpm, AppImage)

### Changed
- Settings "Text Size" renamed to "UI Size" (it scales the whole UI, not just text)
- Copying a partial selection inside a block now copies exactly the selected text; full-block and multi-block selections still copy the original markdown source
- Render path memoized and processed documents cached per tab — settings interactions no longer re-render the sidebar tree, and revisiting a tab restores instantly instead of re-highlighting

### Fixed
- Editing a `.gitignore` now reconciles the watch set (newly ignored directories unwatched, newly visible ones watched)
- Watch-limit warning shows the folder name instead of its id
- A folder change arriving while that folder's tree is being fetched is no longer dropped

## [0.2.0] - 2026-08-03

First marque release. Cold-launches in under 2 seconds with large folders registered and never stalls the UI on watcher rebuilds.

### Added
- Adjustable text size — scales all text app-wide (sidebar, toolbar, command palette, markdown content) via Settings dropdown or Cmd+Plus/Cmd+Minus/Cmd+0
- Resizable sidebars — drag the edge of the folder sidebar or table of contents to resize; double-click to reset to default
- Copy contents as markdown
- Settings migration from marky (`~/.local/share/marky` → `~/.config/marque`) on first run
- Notification surface: corrupt-settings notice and watch-limit warnings (with folder name)
- Root React error boundary — a render crash no longer white-screens the app
- CI (frontend + Rust jobs) green on every push

### Changed
- Startup is metadata-only; folders hydrate in the background per folder after the window paints
- File watching is ignore-aware and non-recursive, capped at 10,000 directories per folder, with dynamic watches for new directories and diff-based reconciliation when a `.gitignore` changes
- Folder walks parallelized; search reads per-folder Arc'd index slices — ⌘K stays instant while typing
- Sidebar loads each folder's tree lazily on expand; refreshes arriving mid-fetch are queued, not dropped
- Syntax highlighting moved to shiki fine-grained core (4.4.1) on the JavaScript regex engine — dist shrank from 13 MB / 329 chunks to 6.6 MB / 97 files, no WASM
- Corrupt `settings.json` is renamed aside and surfaced instead of silently overwritten

### Fixed
- CLI not opening files when the app is already running
- Files not refreshing when edited from outside the app
- Stale-closure bug that broke sidebar scroll-to-folder for CLI targets
- Rejected shiki/mermaid singletons now retry instead of caching the failure forever
- Contact link

## [0.1.1] - 2026-04-16

### Fixed
- Folders not working correctly

## [0.1.0] - 2026-04-16

### Added
- Tauri v2 desktop markdown viewer
- Folder sidebar with file tree (Obsidian-style)
- Cmd+K command palette with fuzzy search
- Split panes and tabs
- In-document search
- Syntax highlighting via Shiki
- KaTeX math rendering
- Mermaid diagram support
- Light/dark theme with shadcn UI
- File watching with live reload
- CLI launcher (`marky FILE` or `marky FOLDER`)
- Homebrew tap distribution
