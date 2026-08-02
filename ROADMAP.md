# marque — Stability & Performance Roadmap

**Discipline:** this is the wanted-later ledger; the current version's punch-list is `MISSING.md` (which defines the shared MISSING/ROADMAP rules this repo follows). Items graduate from here into `MISSING.md` when a version goal claims them; deported MISSING items land here as `gap:` lines with provenance.

**Status 2026-08-02:** fork hygiene (§3 "De-forking" + Dependencies + CI baseline) executed the same day — see `MISSING.md` items 1/5/6 for its residuals. **Phase 0 executed 2026-08-02:** H1 locked with kernel evidence (846,385 inotify watches, ~3.5 min blocked setup, ramping ~6k/s; 1,242 watches / <2 s after removing the homelabs registration — backup at `~/.agents/backups/marque/settings.json.pre-phase0-2026-08-02`, re-add the folder once Phase 1 lands); Shiki eager set trimmed to `bash` and theme `resolved` sync-initialized (implemented by GPT-5.6-terra via acpx, brief + findings under `tmp/`). **Phase 1 executed 2026-08-02** in two terra rounds (`2a32e76` + `3df7bc0`, briefs/findings under `tmp/phase1*`): background hydration off `setup()`, ignore-aware per-dir watcher capped at 10k dirs (`folder://watch-limit`), event filtering + tree-build outside the write lock + per-folder index slices, `read_file` off the write lock, settings corruption guard (rename-aside), root error boundary, notification surface, shiki/mermaid singleton retry — MISSING items 2–4 consumed. Known residuals (both consumed 2026-08-03, `e557e89`): watch-set is not reconciled when an existing `.gitignore` is edited (refresh fires, watches aren't re-enumerated) — now diff-reconciled on ignore-file events with best-effort unwatch and a re-armed limit latch; watch-limit toast shows folder id, not name — payload now carries `folder_name`. **Phase 2 executed 2026-08-02** in three terra rounds (`a101fd1` walk parallelization + BTreeMap tree build + Arc'd index slices; `cc741b6` single folder-state owner + lazy per-folder tree loads, also fixing a stale-closure CLI-scroll bug; `5b4bf6e` shiki v1 full bundle → `@shikijs/core` 3.23.0 + JS regex engine, dist 13 MB/329 chunks → 6.4 MB/97 files, no WASM; briefs/findings under `tmp/phase2*`). Phase 2 items 3–4 had already landed in the fork-hygiene pass. Known residuals (both consumed 2026-08-03): a `folder://changed` arriving while that folder's tree fetch is in flight is skipped, not queued (self-heals on the next event) — now coalesced to one queued re-fetch (`e557e89`); `gap:` shiki v4 (4.4.1) exists — evaluated and bumped to 4.4.1, drop-in for the fine-grained core setup (`aa937ac`). Runtime verification of all of it stays with `MISSING.md` item 5.

Synthesized from the 2026-08 multi-agent audit (adversarially verified). Priorities follow the fork's goals: startup performance > stability > maintainability.

---

## 1. Startup performance

**The 30–60s first launch is explained and confirmed at the code level.** Platform-level suspects (portals, DMA-BUF, GStreamer, shader/fontconfig caches) were checked on-machine and exonerated. Ordered by likelihood × impact:

### H1 — Synchronous, ignore-blind recursive inotify watch in `setup()` — CODE-LEVEL, ROOT CAUSE (confirmed) `[effort: day]`

- **Mechanism:** `src-tauri/src/lib.rs:71-114` — the Tauri `.setup()` closure runs `Settings::load` → `FolderRegistry::from_settings` (tree walk per folder) → `watch_folder()` per folder, all on the main thread before `app.run()` (lib.rs:135) enters the event loop. Nothing paints, no IPC is served, until it finishes.
- **The dominant cost is the watcher, not the tree walk:** `src-tauri/src/watcher.rs:53` calls `debouncer.watch(&root, RecursiveMode::Recursive)`. notify's inotify backend walks the **entire** tree with no ignore filtering — one `inotify_add_watch` + readdir per directory. The registered `~/dev/personal/infra/homelabs` folder has **845,137 directories / ~8.5M files** (844,994 dirs under `benchmarks/`). Cold page cache → 30–60s; warm cache → seconds. That exactly matches "first launch slow, later launches faster". (The `build_tree` hydration walk is ignore-pruned via `ignore::WalkBuilder` and visits only ~9k dirs — a minor contributor. The previously suspected FileIdMap stat-walk does NOT occur on Linux: notify-debouncer-full 0.4 uses `NoCache` on linux.)
- **Why "opening another document is fast":** `lib.rs:68-70` — tauri-plugin-single-instance forwards args to the running process, skipping setup entirely.
- **Diagnostic (definitive, one run):**
  ```
  strace -f -tt -e trace=inotify_add_watch,openat,execve \
    -o /tmp/claude-1000/marky.trace /home/michel/Applications/marky README.md
  ```
  Expect a solid 30–60s block of `inotify_add_watch` on `homelabs/benchmarks/**`. Live check while running: `awk '/^inotify/{c++} END{print c}' /proc/$(pgrep -x marky)/fdinfo/*` → expect ~845k. Counter-test: remove the homelabs entry from `~/.local/share/marky/settings.json`, cold-launch → ~1–2s.
- **Fix (two parts, both required):**
  1. **Async hydration:** in `setup()`, only load settings and manage an empty/loading registry; spawn a background thread (`tauri::async_runtime::spawn_blocking`) that builds trees + installs watchers per folder, emitting `folder://changed` as each becomes ready (frontend already listens). Optionally `"visible": false` in `tauri.conf.json` + show from frontend on mount.
  2. **Ignore-aware watching:** backgrounding alone still burns ~845k kernel watches per launch. notify can't filter during recursive registration, so walk with `WalkBuilder` (reusing `folder.rs::DEFAULT_IGNORES` + gitignore) and add `NonRecursive` watches per surviving directory (dynamically watch newly created dirs), **or** cap watched dirs per folder (~50k) and degrade to manual refresh with a UI warning.
- Also: user-side mitigation now — re-point or remove the homelabs folder registration.

### H2 — Shiki eager init: 21 grammars + 622 KB Oniguruma WASM on every launch — CODE-LEVEL (confirmed, seconds-scale) `[effort: hours]`

- `src/lib/highlight.ts:8-41` — `createHighlighter` eagerly loads 21 langs (~2.06 MB of grammar/theme chunks) + 622 KB base64-inlined WASM, ~25 dynamic imports through the asset protocol. Triggered every launch by the ```` ```bash ```` fence in the built-in WELCOME doc (`src/App.tsx:23-42`, `Viewer.tsx:52`). Doesn't block literal first paint (runs in an async effect), but delays highlighted render/interactivity by seconds. Warm-singleton afterwards.
- **Fix:** (1) init with 2 themes + zero/2-3 langs; the on-demand `loadLanguage` path already exists (highlight.ts:51-57) — drop cpp/java/ruby/etc. from the eager set. (2) Migrate `shiki` full bundle → `@shikijs/core` + `createJavaScriptRegexEngine` (kills the WASM decode/compile entirely); pairs with the shiki v3 upgrade (§3). (3) Optionally drop the bash fence from WELCOME or defer highlight to `requestIdleCallback`.

### H3 — Frontend mount invoke storm — CODE-LEVEL (real, secondary) `[effort: hours]`

- `src/App.tsx:74-81` invokes `get_initial_target` + `list_folders_grouped`; `src/components/FolderSidebar.tsx:58-76` independently invokes `list_folders_grouped` **again** plus `read_folder_tree` for every folder concurrently. With H1's background hydration these become cheap, but dedupe anyway: lift folder state to App, lazy-load trees on folder expand.
- **Diagnostic:** launch with an empty folder registry to bisect frontend-vs-backend cost; `eprintln!` timestamps in setup vs first `list_folders_grouped`.

### H4 — Platform-level webview suspects — PLATFORM-LEVEL (exonerated, cheap A/B only) `[effort: hours]`

All checked on this machine (Fedora 44 / KDE Wayland / AMD RX 9070 XT / webkit2gtk 2.52.5) and ranked low. One-command confirmations if the strace in H1 leaves residual time unaccounted:
- **Portal 25s timeout:** `busctl --user call org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings ReadOne ss org.freedesktop.appearance color-scheme` — must return instantly. (Healthy here; symptom is 30–60s variable, not fixed 25s.)
- **DMA-BUF/compositing:** `time WEBKIT_DISABLE_DMABUF_RENDERER=1 ~/Applications/marky README.md` (and `WEBKIT_DISABLE_COMPOSITING_MODE=1`). Wrong failure mode (blank window, NVIDIA) — expect no difference on AMD+Mesa. If it ever helps, bake into the `.desktop` Exec (no wrapper is installed; the .desktop launches the bare binary).
- **Stale GStreamer registry:** `time gst-inspect-1.0 fakesrc`, then cold-launch and compare. Registry is stale (June 27) but likely never loaded by a media-free viewer.
- **Mesa shader / fontconfig caches:** one-shot, sub-2s — fail the "every cold launch" pattern. Skip.

### Supporting startup items `[effort: day total]`

- `folder.rs:50-68` walk is single-threaded → `build_parallel()`; `folder.rs:107-133` `insert_components` is O(n²) in wide dirs (237k md files in homelabs) → HashMap intermediate; `registry.rs:115-121` calls `rebuild_index` once per folder during `rebuild_all` → call once at the end.
- Theme double-render: `src/lib/theme.tsx:33` initializes `resolved` to `"light"`, flipped by an effect → the entire highlight/mermaid pipeline runs twice for dark-theme users (`Viewer.tsx:80` depends on `[html, resolved]`). Fix: compute `resolved` synchronously in the `useState` initializer; longer term, Shiki dual-theme CSS-variable output. `[hours]`
- `shiki/bundle/web` or fine-grained imports: dist is 329 chunks / 13 MB including emacs-lisp (804 KB), wolfram, every theme. Bundle/AppImage hygiene, not launch time. `[hours]`
- Cargo release profile is fine (`opt-level="s"` — startup is I/O-bound). Benchmark only on release builds; dev builds make the walks several times slower.

---

## 2. Stability

1. **Watcher event → full re-walk + index rebuild under the registry write lock** `[days]` — `watcher.rs:33` calls `refresh_folder` on every debounced batch with zero path filtering; `registry.rs:86-93` takes `inner.write()`, runs `build_tree` (full ignore-pruned walk) + `rebuild_index` (re-flattens ALL folders). Every command blocks meanwhile — and `read_file` takes a **write** lock via `push_recent`, so even document opens queue behind rebuilds. Any `.git` churn in a watched dev tree triggers this. Fix: filter event paths against `DEFAULT_IGNORES`/hidden/non-markdown before refreshing (helpers exist in folder.rs); build trees **outside** the lock and swap in briefly; incremental updates per changed path; rebuild only the affected folder's index slice.
2. **inotify watch budget: ~845k watches ≈ 40% of `fs.inotify.max_user_watches` (2,097,152)** `[covered by H1 fix]` — hundreds of MB of unswappable kernel memory for the app's lifetime; starves syncthing/IDEs. The ignore-aware watcher + per-folder cap fixes this; surface a UI warning when a folder exceeds the cap.
3. **Corrupt settings.json silently reset then overwritten — permanent folder-list loss** `[hours]` — `settings.rs:48` `unwrap_or_default()` on parse failure + the next save (`commands.rs:29` fires on every file open) rewrites defaults over the old file. Fix: rename corrupt file to `settings.json.corrupt-<ts>`, warn the frontend, never save over a file that didn't parse.
4. **No React error boundary** `[hours]` — one throw in the markdown pipeline white-screens the app. Add a top-level boundary around the Viewer/pane tree. (Per-block shiki/mermaid failures are already contained — good.)
5. **Watcher errors swallowed** `[day]` — `watcher.rs:48` `Err(_) => {}`. Deleted/renamed watch root → silent zombie folder. Fix: detect root removal, emit `folder://error` with folder id, drop the dead handle, optionally poll for reappearance.
6. **Lazy singletons cache rejected promises forever** `[hours]` — `highlight.ts:36-41` and `mermaid.ts:4-9`: one failed init kills the feature for the session; `renderMermaidBlocks` at `Viewer.tsx:71` is awaited with no catch → unhandled rejection, `onRendered` never fires. Fix: `promise = null` in a `.catch`; try/catch around the Viewer call.
7. **Errors invisible to users** `[hours]` — `App.tsx:68-70` `console.error` only for read_file failures (>25MB, non-UTF8, deleted); unhandled rejections in refreshFolders / initial load / addFolder / removeFolder. Backend errors are already user-presentable (`error.rs`) — add a toast (shadcn sonner) and route them there.
8. **`read_file` writes settings.json on every open** `[hours]` — `commands.rs:26-31`. Debounce recents persistence or save on exit; decouples opening from disk writes and lock contention.

---

## 3. Maintainability & fork hygiene

### De-forking `[~1 day]`
- **marky → marque rename** — unstarted; the Tauri identifier change is a **data-loss trap** (`app_data_dir` moves): migrate `~/.local/share/marky/settings.json` on first run of the renamed app, or keep the identifier and rename only display surfaces. Decide explicitly before touching `tauri.conf.json`.
- **Remove upstream-sync machinery** — obsolete remote, sync script, 4-branch model, stale doc (`FORK_WORKFLOW.md`) with wrong absolute paths.
- **Rewrite CLAUDE.md** — currently claims "no code scaffolded yet", references a nonexistent `PLAN.md`, points at `main.rs` for the invoke_handler (it's `lib.rs:115`), omits registry.rs/watcher.rs/error.rs. Per fleet convention: canonical `AGENTS.md` + thin `CLAUDE.md` bridge.
- **Release workflow** — `release.yml` builds on ubuntu-22.04, producing the exact AppImage that crashes on Fedora (the reason the fork exists). Delete or strip it; do not keep shipping it.
- **scripts/** — `bump-version.sh` uses BSD `sed -i ''` (breaks on Fedora) and pushes tags for the dead release flow: fix or delete. Trim `install-cli.sh`'s macOS branch if macOS is dropped.
- `git rm --cached tsconfig.node.tsbuildinfo`; add `*.tsbuildinfo` to `.gitignore`.

### Dependencies `[~half day]`
- **`pnpm update mermaid`** → 11.14.1 (runtime advisory; `^` range already allows it — lockfile-only). Cheapest real security fix; do first.
- **happy-dom ≥ 20.8.9** (critical/high advisories, dev-only Vitest env) — do together with **vitest 2.x → 3.x** (removes the duplicate `vite@5` in the tree).
- **Remove from `dependencies`:** `shadcn` CLI (drop entirely — `pnpm dlx` per project docs; also drop the `msw` allowBuilds entry in `pnpm-workspace.yaml`), 7 unused individual `@radix-ui/react-*` packages (code imports the `radix-ui` meta package), `tailwindcss-animate` (project uses `tw-animate-css`), `katex` (zero imports; mermaid brings its own).
- **One icon library:** migrate the 4 `@hugeicons/*` call sites (ui/dialog, ui/dropdown-menu) to lucide-react; drop both hugeicons packages.
- **shiki v1 → v3** as part of the H2 highlight.ts rework (v3 defaults to fine-grained bundles + JS engine).
- Add `"packageManager": "pnpm@<current>"` to package.json; Rust deps healthy (optionally notify 7→8, dirs 5→6 in a later pass — no urgency, not startup-relevant).

### Test & CI baseline `[hours]`
- **Zero CI runs the 33 Rust tests and 5 Vitest suites that exist.** Add `ci.yml` on push/PR: `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm test` + `cargo test` + `cargo clippy` (Linux runner only).
- Coverage itself is adequate for a viewer (lib/ covered per policy; commands.rs/watcher.rs are thin glue) — don't invest beyond CI execution. Add a regression fixture for the ignore-aware watcher when built.

---

## 4. Phased ordering

### Phase 0 — Diagnose + quick wins `[~half day]`
1. Run the strace diagnostic (H1) once to lock in the root cause / rule out residuals.
2. Mitigate now: remove/narrow the homelabs registration in settings.json.
3. `pnpm update mermaid` (advisory fix, lockfile-only).
4. Shiki eager-lang trim to 2-3 langs (highlight.ts one-liner; keeps existing on-demand path).
5. Theme `resolved` sync init (theme.tsx) — kills the double highlight pass.

### Phase 1 — The startup + stability core `[~3-4 days]`
1. Background hydration: empty registry in `setup()`, spawn hydration thread, `folder://changed` per folder; optional `visible:false` + frontend show. (lib.rs, registry.rs)
2. Ignore-aware watcher with per-folder cap + UI warning; dynamic watch of new dirs. (watcher.rs, folder.rs)
3. Event filtering + tree-build-outside-lock + incremental refresh; drop write lock from `read_file`/recents path. (watcher.rs, registry.rs, commands.rs)
4. Settings corruption guard (settings.rs) + React error boundary + toast error surface + singleton retry fix.
5. `ci.yml` so all of the above lands with tests running.

### Phase 2 — Hygiene + polish `[~2-3 days]`
1. Shiki v3 + `@shikijs/core` + JS engine migration (kills WASM, shrinks dist ~8-10 MB).
2. Frontend dedupe: single folder-state owner, lazy per-folder tree loads.
3. Dependency purge (shadcn/radix/katex/animate/icons), happy-dom + vitest 3 bump, packageManager pin.
4. De-fork: rename decision + data migration, upstream machinery removal, CLAUDE.md→AGENTS.md rewrite, scripts fixes, release.yml removal.
5. Walk parallelization + insert_components HashMap + index-clone fix in `search_files` (Arc-swap) — makes Cmd+K fast on the same dataset that caused the startup problem.

**Success criteria:** cold launch < 2s with homelabs registered (strace shows no inotify burst); no IPC stall while `git` runs in a watched tree; CI green on every push; zero references to marky/upstream sync machinery left (`rg --hidden --no-ignore -g '!.git/**' marky`).
