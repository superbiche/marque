# Missing: the current version's punch-list

**Definition (per the shared MISSING/ROADMAP discipline used by Liaison, Memoire, Reveille — extraction to a canonical home is pending, see liaison inbox 2026-08-02):** MISSING holds what the CURRENT VERSION'S GOAL requires to be functional, stable, complete. It is CONSUMED within the version. Everything wanted-later lives in `ROADMAP.md` (`gap:` lines). An entry is never deleted: it is consumed (fixed, with a dated strikethrough note) or deported to `ROADMAP.md` with provenance. No silent death.

**Release gate:** no tag ships with open, non-deported items. Arms at v0.2.0 — the first marque tag.

**Current version goal (v0.2.0):** marque cold-launches in under 2 seconds with large folders registered, never stalls the UI on watcher rebuilds, and CI is green on every push. (Fork hygiene — rename, XDG settings migration, de-fork, dep purge, CI — landed pre-v0.2.0 on 2026-08-02.)

Item numbers are stable; gaps in the sequence are consumed or deported items. Founded 2026-08-02 from the fork audit (`ROADMAP.md`) residuals and the hygiene-pass review.

---

## 1. ~~Lockfile regeneration is blocked behind the safe gate — deps changes are committed nowhere~~ (CLOSED 2026-08-02)

**Closed:** operator ran `pnpm install` interactively through the safe gate the same day; vitest 3.2.7 / happy-dom 20.11.1 / mermaid 11.16.0 resolved, 37/37 tests + typecheck green on the regenerated tree, deps chunk committed (`4132a15`) and pushed.

**Observation:** the dependency purge (hugeicons→lucide, katex/shadcn/radix-singles/tailwindcss-animate removal, mermaid 11.14.1, vitest 3, happy-dom 20) edited `package.json` and code, but every non-interactive `pnpm install` exits 102 (`safe: BLOCKED — audit found critical findings`, 4 CRITICAL / 32 HIGH pre-existing CVEs in the tree). `pnpm-lock.yaml` is stale; the deps chunk is intentionally uncommitted; vitest 3 / happy-dom 20 have never executed.

**Consumes when:** operator runs `pnpm install` interactively (reviewing the safe audit), then `pnpm test` + `pnpm typecheck` pass against the new tree, and the deps commit (package.json, lockfile, pnpm-workspace.yaml, dialog.tsx, dropdown-menu.tsx) lands.

## 2. ~~Cold launch: synchronous ignore-blind recursive watch in setup()~~ (CLOSED 2026-08-02)

**Closed:** Phase 1 Round A (`2a32e76`): `setup()` is metadata-only; a background thread hydrates folder-by-folder emitting `folder://changed`, and watching is per-directory `NonRecursive` over the ignore-aware walk, capped at 10k dirs per folder with a `folder://watch-limit` event + dynamic new-dir watches. Runtime confirmation (cold launch <2 s with homelabs re-added, no inotify burst) folds into item 5's graphical run.

**Observation:** `lib.rs` setup() hydrates trees and installs recursive inotify watches (845k dirs for the homelabs folder) before the window paints — the confirmed 30–60s root cause (`ROADMAP.md` H1).

**Consumes when:** hydration + watcher install move off the setup hook (background thread, `folder://changed` per folder) AND watching is ignore-aware/capped, with the strace diagnostic showing no inotify burst and cold launch <2s with homelabs registered. (Phase 1 items 1–2.)

## 3. ~~Watcher events trigger full re-walk + index rebuild under the registry write lock~~ (CLOSED 2026-08-02)

**Closed:** Phase 1 Round A (`2a32e76`): event batches are filtered against hidden/default-ignore components + ancestor `.gitignore` before any refresh; trees build outside the write lock and swap in only that folder's `index_by_folder` slice; recents moved to their own lock with deferred persistence, so `read_file` no longer takes the registry write lock. Residual (parked to ROADMAP status note): editing an existing `.gitignore` refreshes the tree but does not re-enumerate the watch set.

**Observation:** any debounced event batch (including `.git` churn) runs `refresh_folder` → full tree rebuild + full index rebuild holding `inner.write()`; `read_file` also takes the write lock via `push_recent`, so document opens queue behind rebuilds (`ROADMAP.md` Stability 1/8).

**Consumes when:** events are filtered against ignores before refresh, trees build outside the lock, only the affected folder's index slice rebuilds, and the recents write is off the read path.

## 4. ~~Failure surfaces: settings corruption, render crashes, watcher death are all silent~~ (CLOSED 2026-08-02)

**Closed:** Phase 1 Round B (`3df7bc0`): corrupt `settings.json` is renamed aside (`settings.json.corrupt-<ts>`), never overwritten, and surfaced at startup via `get_settings_load_status`; a root React error boundary replaces the white screen; a notification surface shows the corrupt-settings notice and `folder://watch-limit` warnings; rejected shiki/mermaid singletons reset so the next call retries.

**Observation:** corrupt `settings.json` is silently reset then overwritten on next save (permanent folder-list loss); no React error boundary (one render throw white-screens); watcher errors are swallowed (`Err(_) => {}`); rejected lazy-singleton promises (shiki/mermaid) are cached forever (`ROADMAP.md` Stability 3–7).

**Consumes when:** corrupt settings are renamed aside + surfaced, a top-level error boundary exists, backend errors reach a toast, and failed singletons retry.

## 5. Runtime verification of the hygiene + Phase 1 passes has not happened

**Observation:** per repo convention (AGENTS.md Testing), rendering changes require an actual `pnpm tauri dev` run. The icon swaps (lucide X/Check/ChevronRight) and the first-run settings migration (`~/.local/share/marky` → `~/.config/marque`, plus one-time webview localStorage reset from the identifier change) are code-verified and unit-tested but never run visually. Phase 1 (2026-08-02) widened the surface: background hydration, the notification toasts, and the error boundary are likewise unverified in a real window (terra's headless `pnpm tauri dev` attempt built but produced no window). The homelabs re-add is the natural end-to-end test: re-register `/home/michel/dev/personal/infra/homelabs` (backup at `~/.agents/backups/marque/settings.json.pre-phase0-2026-08-02`) and confirm cold launch <2 s, sidebar populating progressively, no inotify burst.

**Consumes when:** operator (or a runtime-verify lane) launches the app post-install in a graphical session, confirms icons render, migration eprintln fires once, folders/theme survive, folders hydrate progressively after the window paints, and the homelabs re-add stays under 2 s cold launch.

## 6. ~~No local clippy signal; CI is the only lint gate~~ (CLOSED 2026-08-02)

**Closed:** first green CI run on main (run 30748916873, 2026-08-02) after fixing the two lints local tooling couldn't see (`search.rs` sort_by_key, `watcher.rs` if-let). Standing caveat: clippy still isn't runnable locally — CI remains the lint oracle until rustup lands on this machine.
