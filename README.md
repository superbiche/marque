<h1 align="center">
  <br>
  <img src="assets/logo.png" alt="Marque" width="360">
  <br>
   Marque
  <br>
</h1>

<h4 align="center">A fast, native markdown viewer for Linux built with <a href="https://v2.tauri.app">Tauri v2</a>, <a href="https://react.dev">React</a>, and <a href="https://github.com/markdown-it/markdown-it">markdown-it</a>. Beautiful rendering of tables, code blocks, task lists, footnotes, and Mermaid diagrams — with live reload.</h4>

Hard fork of [marky](https://github.com/GRVYDEV/marky) by GRVYDEV, Apache-2.0.

<p align="center">
  <a href="https://github.com/superbiche/marque/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/superbiche/marque/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/superbiche/marque/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/superbiche/marque?sort=semver"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

<!-- TABLE OF CONTENTS -->
<details open="open">
  <summary><h2 style="display: inline-block">Table of Contents</h2></summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#features">Features</a></li>
      </ul>
    </li>
    <li><a href="#install">Install</a></li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#keyboard-shortcuts">Keyboard Shortcuts</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

## About The Project

Marque is a desktop markdown viewer designed for one thing: opening `.md` files from the terminal and getting beautiful, instant rendering. Launch it with `marque FILENAME` to view a file or `marque FOLDER` to open a folder as a persistent workspace (Obsidian-style). Files reload live as they change on disk — perfect for viewing Claude-generated plans, documentation, or notes as they're being written.

### Features

- **CLI-first** — `marque README.md` opens a window. `marque ./docs/` opens a folder.
- **Live reload** — edits on disk (from your editor, Claude, etc.) update the view instantly.
- **Folders** — add folders as persistent workspaces (Obsidian-style). They appear in a sidebar and restore on launch.
- **Cmd+K command palette** — fuzzy-search files across all open folders, powered by [nucleo](https://github.com/helix-editor/nucleo).
- **Syntax highlighting** — [Shiki](https://shiki.style) with VS Code themes for accurate, beautiful code blocks.
- **Mermaid diagrams** — fenced `mermaid` blocks render as SVG.
- **GFM** — tables, task lists, strikethrough, autolinks, footnotes.
- **Light & dark themes** — follows system preference or toggle manually.
- **Sanitized rendering** — all HTML is run through DOMPurify. Safe to view untrusted markdown.
- **Small & fast** — native webview, no Electron.

## Install

### Packages (Linux x86_64)

Every release ships a `.deb`, an `.rpm`, and an `.AppImage` on the [releases page](https://github.com/superbiche/marque/releases/latest). The packages are built on Ubuntu 22.04 (glibc 2.35), so any distribution with glibc 2.35 or newer is expected to work (Ubuntu 22.04+, Debian 12+, Fedora 40+). Marque is developed and tested on Fedora / KDE Plasma / Wayland; other distributions are not routinely tested.

```bash
# Fedora
sudo dnf install ./Marque-*.x86_64.rpm

# Debian / Ubuntu
sudo apt install ./Marque_*_amd64.deb
```

Then install the CLI wrapper so `marque FILE` works from any terminal. Download [`scripts/install-cli.sh`](scripts/install-cli.sh), read it, and run it; it only writes a small wrapper to `~/.local/bin/marque`.

### From Source (Fedora / Linux)

Requires [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and the system `webkit2gtk4.1` development packages.

```bash
git clone https://github.com/superbiche/marque.git
cd marque
pnpm install
pnpm tauri build
./scripts/install-cli.sh
```

The install script installs a `marque` wrapper to `~/.local/bin/`. Make sure that's on your `PATH`:

```bash
# bash/zsh
export PATH="$HOME/.local/bin:$PATH"

# fish
set -Ux fish_user_paths $HOME/.local/bin $fish_user_paths
```

## Usage

```bash
# Open a single file
marque README.md

# Open a folder as a workspace
marque ./docs/

# Open with no args — restores your last session
marque
```

## Keyboard Shortcuts

| Shortcut      | Action                              |
| ------------- | ------------------------------------ |
| `Cmd+K`       | Command palette (fuzzy file search) |
| `Cmd+O`       | Open file                           |
| `Cmd+Shift+O` | Add folder                          |
| `Cmd+F`       | Search in page                      |

## Development

```bash
pnpm install
pnpm tauri dev       # dev server with HMR
```

### Run Tests

```bash
# Frontend
pnpm test

# Rust
cd src-tauri && cargo test
```

### Project Structure

```
src-tauri/       Rust backend — CLI, file I/O, file watching, folder registry, fuzzy search
src/             React frontend — markdown pipeline, UI components, theme
src/components/  App components (Viewer, Sidebar, CommandPalette, etc.)
src/components/ui/  shadcn/ui primitives
src/lib/         Core logic (markdown-it config, Shiki, Tauri IPC wrappers)
src/styles/      Tailwind base + markdown prose styles
scripts/         Install helpers
```

## Built With

| Layer               | Tech                                                      |
| ------------------- | --------------------------------------------------------- |
| Desktop shell       | [Tauri v2](https://v2.tauri.app)                          |
| Frontend            | React + TypeScript + Vite                                 |
| Markdown            | [markdown-it](https://github.com/markdown-it/markdown-it) |
| Syntax highlighting | [Shiki](https://shiki.style)                              |
| Diagrams            | [Mermaid](https://mermaid.js.org)                         |
| Fuzzy search        | [nucleo](https://github.com/helix-editor/nucleo)          |
| UI primitives       | [shadcn/ui](https://ui.shadcn.com)                        |
| Styling             | [Tailwind CSS](https://tailwindcss.com)                   |
| File watching       | [notify](https://github.com/notify-rs/notify)             |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, the checks CI runs, and what is in and out of scope (marque stays a read-only viewer). Security problems go through [SECURITY.md](SECURITY.md), not public issues.

Marque is a hard fork of [marky](https://github.com/GRVYDEV/marky), renamed and maintained independently since August 2026. It is actively maintained: dependencies are updated weekly through Dependabot and every PR gets CI plus an automated review before a maintainer looks at it.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution to the original marky project and bundled third-party components.
