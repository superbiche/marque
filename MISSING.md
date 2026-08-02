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

## 2. Cold launch: synchronous ignore-blind recursive watch in setup()

**Observation:** `lib.rs` setup() hydrates trees and installs recursive inotify watches (845k dirs for the homelabs folder) before the window paints — the confirmed 30–60s root cause (`ROADMAP.md` H1).

**Consumes when:** hydration + watcher install move off the setup hook (background thread, `folder://changed` per folder) AND watching is ignore-aware/capped, with the strace diagnostic showing no inotify burst and cold launch <2s with homelabs registered. (Phase 1 items 1–2.)

## 3. Watcher events trigger full re-walk + index rebuild under the registry write lock

**Observation:** any debounced event batch (including `.git` churn) runs `refresh_folder` → full tree rebuild + full index rebuild holding `inner.write()`; `read_file` also takes the write lock via `push_recent`, so document opens queue behind rebuilds (`ROADMAP.md` Stability 1/8).

**Consumes when:** events are filtered against ignores before refresh, trees build outside the lock, only the affected folder's index slice rebuilds, and the recents write is off the read path.

## 4. Failure surfaces: settings corruption, render crashes, watcher death are all silent

**Observation:** corrupt `settings.json` is silently reset then overwritten on next save (permanent folder-list loss); no React error boundary (one render throw white-screens); watcher errors are swallowed (`Err(_) => {}`); rejected lazy-singleton promises (shiki/mermaid) are cached forever (`ROADMAP.md` Stability 3–7).

**Consumes when:** corrupt settings are renamed aside + surfaced, a top-level error boundary exists, backend errors reach a toast, and failed singletons retry.

## 5. Runtime verification of the hygiene pass has not happened

**Observation:** per repo convention (AGENTS.md Testing), rendering changes require an actual `pnpm tauri dev` run. The icon swaps (lucide X/Check/ChevronRight) and the first-run settings migration (`~/.local/share/marky` → `~/.config/marque`, plus one-time webview localStorage reset from the identifier change) are code-verified and unit-tested but never run visually.

**Consumes when:** operator (or a runtime-verify lane) launches the app post-install, confirms icons render, migration eprintln fires once, folders/theme survive.

## 6. ~~No local clippy signal; CI is the only lint gate~~ (CLOSED 2026-08-02)

**Closed:** first green CI run on main (run 30748916873, 2026-08-02) after fixing the two lints local tooling couldn't see (`search.rs` sort_by_key, `watcher.rs` if-let). Standing caveat: clippy still isn't runnable locally — CI remains the lint oracle until rustup lands on this machine.
