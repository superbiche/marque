# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Hard fork - 2026-08-02

Renamed project from `marky` to `marque`. New home at [superbiche/marque](https://github.com/superbiche/marque) (private). Upstream tracking with `GRVYDEV/marky` has ended.

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
