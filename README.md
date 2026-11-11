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
  <a href="https://coderabbit.ai"><img alt="CodeRabbit Pull Request Reviews" src="https://img.shields.io/coderabbit/prs/github/superbiche/marque?utm_source=oss&utm_medium=github&utm_campaign=superbiche%2Fmarque&labelColor=171717&color=FF570A&label=CodeRabbit+Reviews"></a>
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

Marque is a desktop markdown viewer designed for one thing: opening `.md` files from the terminal and getting beautiful, instant rendering. Launch it with `marque FILENAME` to view a file or `marque FOLDER` to open a folder as a persistent workspace (Obsidian-style). Files reload live as they change on disk, which makes it a good companion for plans and notes written by coding agents while they are being written.

Marque started as a hard fork of [marky](https://github.com/GRVYDEV/marky) because the upstream AppImage crashed on Fedora / KDE / Wayland. It is now maintained independently, Linux-first, with its own feature set.

### Features

Viewing

- **CLI-first** — `marque README.md` opens a window; `marque ./docs/` opens a folder; `marque` alone restores the last session. A second invocation reuses the running window.
- **Live reload** — edits on disk (from your editor, an agent, a build) update the view instantly for files inside a folder workspace.
- **Tabs and split panes** — open several documents, split the active pane vertically or horizontally, drop a file onto the window to open it.
- **Document links** — relative and absolute links to other markdown files open in a tab (with `#heading` scroll), in-page anchors scroll, external URLs open in the system browser.
- **On this page** — a table of contents of the open document; sidebars are resizable.
- **Find in document** — ⌘F searches inside the open document.
- **Content zoom, width and fonts** — zoom the rendered content independently of the UI (70–200 %), choose Narrow / Wide / Full width, and pick the reading font (Geist, Inter, iA Writer Quattro, Literata, or System).
- **Print** — ⌘P prints the open document with a paper-friendly stylesheet.
- **Copy** — copy the document's markdown source, or copy exactly what you selected.
- **Light & dark themes** — follow the system or toggle; a warm, low-glare dark palette.
- **Local images** — images referenced relative to the document (or by absolute path) load like in any editor; the viewer may read only the registered folder that contains the document (or, for a file opened on its own, its folder), widened to the enclosing git repository when there is one — never a repository rooted at your home directory or above. An image outside that scope (`../shared/logo.png` from a file opened on its own outside any repository) loads once an enclosing directory is open as a folder.

Workspaces

- **Folders** — add folders as persistent workspaces; they appear in a sidebar and restore on launch. Marque never writes inside them.
- **⌘K command palette** — fuzzy-search files across all open folders, powered by [nucleo](https://github.com/helix-editor/nucleo), instant even on large trees.
- **Pinned files** — pin any file to its own section above the folders, independent of workspaces.
- **Sidebar that remembers** — expanded directories are restored across sessions; collapse-all per folder; `.gitignore` and the usual build directories are respected.
- **Sort by last modified** — a toggle in the folder sidebar header orders each tree newest first (directories still before files); the choice persists across sessions.
- **Group labels** — right-click a folder in the sidebar to give it a group label (or remove it from a group), and right-click a group header to rename the group. Folders sharing a label collect under one header even when they live in different repositories; unlabeled folders keep the automatic repository grouping.
- **Drag out, reveal** — drag a file from the sidebar or a tab into any drop target; open a file's location in the system file manager.
- **Native dialogs** — file and folder pickers go through the XDG desktop portal, so KDE and other non-GNOME desktops get their own dialog.

Rendering

- **Syntax highlighting** — [Shiki](https://shiki.style) with VS Code themes, loaded on demand.
- **Mermaid diagrams** — fenced `mermaid` blocks render as SVG, in both themes.
- **GFM** — tables, task lists, strikethrough, autolinks, footnotes; YAML front matter is stripped.
- **Sanitized rendering** — all HTML goes through DOMPurify; safe to view untrusted markdown.
- **Fast** — cold launch under two seconds with large folders registered; file watching is ignore-aware, non-recursive and capped per folder, so the UI never stalls on a rebuild. Native webview, no Electron.

## Install

### Packages

Every release on the [releases page](https://github.com/superbiche/marque/releases/latest) ships:

| Platform | Files |
|---|---|
| Linux x86_64 and arm64 | `.deb`, `.rpm`, `.AppImage` |
| macOS (universal: Apple silicon and Intel) | `.dmg` |
| Windows x64 | `-setup.exe` (NSIS) and `.msi` |

macOS, Windows and Linux arm64 builds start with 0.4.7. Marque is developed and tested on Fedora / KDE Plasma / Wayland; the macOS and Windows builds come from CI and are not yet routinely tested on those systems, so reports are welcome.

**Linux.** The packages are built on Ubuntu 22.04 (glibc 2.35), so any distribution with glibc 2.35 or newer is expected to work (Ubuntu 22.04+, Debian 12+, Fedora 40+). The deb and rpm install `/usr/bin/marque` and register Marque for markdown files in the file manager.

```bash
# Fedora
sudo dnf install ./Marque-*.x86_64.rpm

# Debian / Ubuntu
sudo apt install ./Marque_*_amd64.deb
```

To make `marque FILE` return to the prompt immediately instead of holding the terminal, install the CLI wrapper: download [`scripts/install-cli.sh`](scripts/install-cli.sh), read it, and run it; it only writes a small wrapper to `~/.local/bin/marque`.

**macOS.** The app is ad-hoc signed but not notarized (no Apple Developer ID yet), so Gatekeeper blocks the first launch: open it once from Finder with right-click → Open, or allow it in System Settings → Privacy & Security → Open Anyway. If macOS reports that the app "is damaged", first check the download (see [Verifying a release](#verifying-a-release)); a verified, un-notarized download is usually only quarantined, which `xattr -dr com.apple.quarantine /Applications/Marque.app` clears. For the CLI: `ln -s /Applications/Marque.app/Contents/MacOS/marque /usr/local/bin/marque`.

**Windows.** The installers are not code-signed yet, so SmartScreen may warn on first run (More info → Run anyway). Add the install directory to `PATH` to use `marque FILE` from a terminal.

### Verifying a release

Release tags are signed by the maintainer, and the release workflow refuses any tag that is not. Each release lists every asset in `SHA256SUMS`, includes an SPDX SBOM, and attaches GitHub build provenance to every file, `SHA256SUMS` included; its notes give the exact commands (the signer's fingerprint check, `gh attestation verify`, `sha256sum -c`).

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

`⌘` is `Ctrl` on Linux.

| Shortcut              | Action                                   |
| --------------------- | ---------------------------------------- |
| `⌘K`                  | Command palette (fuzzy file search)      |
| `⌘O`                  | Open file                                |
| `⌘F`                  | Find in document                         |
| `⌘P`                  | Print                                    |
| `⌘\`                  | Split the active pane vertically         |
| `⌘⇧\`                 | Split the active pane horizontally       |
| `⌘W`                  | Close the active tab                     |
| `⌘+` / `⌘−` / `⌘0`    | Content zoom in / out / reset            |

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
