mod cli;
mod commands;
mod error;
mod folder;
mod fs;
mod highlights;
mod menu;
mod registry;
mod search;
mod settings;
mod watcher;

use commands::InitialTargetState;
use parking_lot::Mutex;
use registry::{FolderRegistry, SharedRegistry};
use settings::{settings_dir, Settings};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use watcher::{hydrate_folder, hydrate_folders, SharedWatchers, Watchers};

/// Event asking the frontend to flush pending highlights saves before the
/// window is destroyed; the frontend answers with the `confirm_close`
/// command.
const HIGHLIGHTS_FLUSH_EVENT: &str = "highlights://flush-request";

/// Phases of the main window's close-request flow. The transitions are
/// pure functions over `(phase, cycle)` (below), so they are unit-testable
/// without a window; the guard is a single mutex holding that pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClosePhase {
    /// No close in flight.
    Idle,
    /// A close was intercepted and the `highlights://flush-request`
    /// event was emitted; waiting for the frontend ack.
    FlushRequested,
    /// The frontend acked the flush request; a save is in progress.
    Flushing,
    /// Terminal: destroy has been ordered (`confirm_close`, the 2 s
    /// no-ack fallback, or the 30 s ceiling).
    Closing,
}

/// What to do with a close request: intercept it, or let it through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    /// `api.prevent_close()`. `emit` is `true` only for the first
    /// request of a flush cycle: it fires the `highlights://flush-request`
    /// event and starts the 2 s no-ack fallback. A request while a flush
    /// is already in flight intercepts again with no new event and no
    /// new timer.
    Intercept { emit: bool },
    /// Let the window close: a destroy is already in flight for this
    /// window (`Closing`), so an in-flight OS close (or the recovery
    /// after a failed destroy) must not be intercepted.
    Pass,
}

/// Which timer fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushTimer {
    /// The 2 s "frontend never acked" fallback, started by the first
    /// intercepted close.
    NoAck,
    /// The 30 s ceiling, started by the ack.
    Ceiling,
}

/// Decide how to handle a new close request in `state`, and the state
/// that results.
///
/// A close while `FlushRequested` or `Flushing` is intercepted again —
/// the in-flight save must not be lost by a second close (the old guard
/// passed a second close through once any close had been attempted,
/// which destroyed the window mid-save); the cycle is unchanged. The
/// first close of a cycle (`Idle`) bumps `cycle`, which retires every
/// timer still sleeping from a previous cycle (see `handle_timer`). A
/// failed flush is *cancelled*: the guard returns to `Idle` for the
/// same cycle, so the user's next close is a fresh cycle that requests
/// a flush again — whether that close ends in a discard is the
/// frontend's call (it is the source of truth for every accepted edit,
/// including saves that have not reached Rust yet). `Closing` also
/// passes — a failed `window.destroy()` leaves the window alive in
/// `Closing` and no timer ever acts from there, so only a further OS
/// close (the platform's own destruction attempt) can get out of it;
/// the `on_destroy_result` recovery handles that.
fn handle_close_request(state: CloseState) -> (CloseAction, CloseState) {
    match state.phase {
        ClosePhase::Idle => (
            CloseAction::Intercept { emit: true },
            CloseState {
                phase: ClosePhase::FlushRequested,
                cycle: state.cycle + 1,
            },
        ),
        ClosePhase::FlushRequested | ClosePhase::Flushing => {
            (CloseAction::Intercept { emit: false }, state)
        }
        ClosePhase::Closing => (CloseAction::Pass, state),
    }
}

/// Decide whether `timer` firing in `state` destroys the window, and the
/// state that results (a destroy moves to `Closing`).
///
/// A timer only acts while the current `cycle` is still the one it was
/// started for (`timer_cycle`): a close that began, was cancelled (a
/// failed flush returns the guard to `Idle` for the same cycle), and
/// whose next close request then bumped the token (or whose window was
/// destroyed) belongs to a *later* cycle, so a stale no-ack or ceiling
/// timer that wakes in the meantime is a no-op — it must not destroy a
/// window whose in-flight state belongs to a different cycle.
///
/// `NoAck` fires only from `FlushRequested`: the frontend is dead or the
/// event was lost, so no flush is in flight. Once acked (`Flushing`) the
/// 30 s ceiling governs instead. A cancelled (failed) flush is back in
/// `Idle`, where no timer acts — a cancelled close must not be undone by
/// a timer.
fn handle_timer(state: CloseState, timer: FlushTimer, timer_cycle: u64) -> (bool, CloseState) {
    if state.cycle != timer_cycle {
        return (false, state);
    }
    match (timer, state.phase) {
        (FlushTimer::NoAck, ClosePhase::FlushRequested) => (
            true,
            CloseState {
                phase: ClosePhase::Closing,
                cycle: state.cycle,
            },
        ),
        (FlushTimer::Ceiling, ClosePhase::Flushing) => (
            true,
            CloseState {
                phase: ClosePhase::Closing,
                cycle: state.cycle,
            },
        ),
        _ => (false, state),
    }
}

/// The state after the frontend acked the flush request. Only an ack in
/// `FlushRequested` counts; a stale or duplicated ack in any other phase
/// is a no-op (and starts no ceiling). The cycle is unchanged: an ack
/// belongs to the same close cycle the flush-request that started it.
fn handle_ack(state: CloseState) -> CloseState {
    match state.phase {
        ClosePhase::FlushRequested => CloseState {
            phase: ClosePhase::Flushing,
            cycle: state.cycle,
        },
        _ => state,
    }
}

/// The state after `confirm_close` (the flush has landed), and whether
/// the window should be destroyed now. Only from `Flushing` — or from
/// `FlushRequested`, where the frontend skipped the ack but says the
/// flush landed, which is data-safe to destroy. Never from `Idle`: a
/// flush that failed has returned the guard to `Idle` (a late or
/// duplicated confirm from that state must not undo "stay open"), and a
/// stray confirm from `Closing` is a no-op too. The cycle is unchanged:
/// a confirm belongs to the in-flight cycle.
fn handle_confirm(state: CloseState) -> (CloseState, bool) {
    match state.phase {
        ClosePhase::Flushing | ClosePhase::FlushRequested => (
            CloseState {
                phase: ClosePhase::Closing,
                cycle: state.cycle,
            },
            true,
        ),
        _ => (state, false),
    }
}

/// The state after `cancel_close` (the flush failed: stay open). Only
/// from an in-flight flush cycle; a stale cancel is a no-op. The cycle
/// is unchanged: the guard returns to `Idle`, so the user's next close
/// request is a *fresh* cycle (a new token retires this one's timers)
/// that requests a flush again — whether that close ends in a discard
/// is the frontend's decision, not the guard's.
fn handle_cancel(state: CloseState) -> CloseState {
    match state.phase {
        ClosePhase::FlushRequested | ClosePhase::Flushing => CloseState {
            phase: ClosePhase::Idle,
            cycle: state.cycle,
        },
        _ => state,
    }
}

/// The state after a `window.destroy()` attempt in `state`. A success
/// leaves the state alone (the window is gone; no further transition
/// matters). A failure out of `Closing` returns to `Idle`, so the next
/// close request is a fresh cycle (flush request + timers) instead of
/// being trapped behind an un-destroyed window (a failed destroy must
/// not leave the window uncloseable). A failure from any other phase is
/// a no-op: destroy is only ever ordered from `Closing`. The cycle is
/// unchanged.
fn on_destroy_result(state: CloseState, ok: bool) -> CloseState {
    if !ok && state.phase == ClosePhase::Closing {
        CloseState {
            phase: ClosePhase::Idle,
            cycle: state.cycle,
        }
    } else {
        state
    }
}

/// The close cycle's phase and its token. `cycle` is bumped when a close
/// starts a new flush (`Idle` → `FlushRequested`); every timer captures
/// the `cycle` it was started for, so a timer that outlives its cycle is a
/// no-op (see `handle_timer`) rather than a stale destroy. A cancelled
/// (failed) flush, an in-flight flush, and a `Closing` window all keep
/// the current token: only a *new* close request — the first one out of
/// `Idle` — starts a fresh cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CloseState {
    phase: ClosePhase,
    cycle: u64,
}

/// Close-request state for the main window, shared with the frontend-ack
/// flow through the `Arc` in managed state. A single mutex-held
/// `(phase, cycle)` instead of four racing flags: every transition is a
/// compare-and-swap decided by the pure `handle_*` functions above, so a
/// second close during an in-flight flush is intercepted (not passed
/// through) and a stale ack/confirm/cancel/timer can no longer undo a
/// decision. The main window is created once per process (this app never
/// creates a replacement one), so the guard is per process.
struct CloseGuard {
    state: Mutex<CloseState>,
}

/// Handle a new CLI target from either single-instance forwarding or macOS
/// file-open events: register folders, update managed state, emit to frontend,
/// and focus the main window.
fn handle_target(app: &tauri::AppHandle, target: cli::InitialTarget) {
    let resolved = match &target {
        cli::InitialTarget::Folder { path } => {
            if let (Some(reg), Some(watchers)) = (
                app.try_state::<SharedRegistry>(),
                app.try_state::<SharedWatchers>(),
            ) {
                if let Ok((folder, added)) = reg.add_folder_with_status(PathBuf::from(path)) {
                    let _ = reg.save(&settings_dir());
                    if added {
                        hydrate_folder(
                            app.clone(),
                            Arc::clone(&*reg),
                            Arc::clone(&*watchers),
                            folder.clone(),
                        );
                    }
                    cli::InitialTarget::Folder { path: folder.path }
                } else {
                    target.clone()
                }
            } else {
                target.clone()
            }
        }
        other => other.clone(),
    };

    if let Some(state) = app.try_state::<InitialTargetState>() {
        *state.0.lock() = resolved.clone();
    }
    let _ = tauri::Emitter::emit(app, "cli://target", &resolved);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let initial = cli::resolve(&args);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_target(app, cli::resolve(&argv));
        }))
        // Route native menu item clicks. Dormant on Linux/Windows: no menu is
        // installed there, so no menu event can ever arrive.
        .on_menu_event(menu::handle_event)
        // Closing the main window (title-bar button, macOS Window menu):
        // the first request is intercepted so the frontend can flush
        // in-flight highlight saves. The frontend answers with
        // `ack_close_request` (it is alive: a 30 s ceiling now governs and
        // the 2 s fallback below no longer applies) and then
        // `confirm_close` (flush landed: destroy) or `cancel_close`
        // (flush failed: stay open; the guard returns to `Idle` for the
        // same cycle). A further close request while the flush cycle is
        // in flight is intercepted again — no new event, no new timers —
        // so an in-flight save cannot be lost. A *later* close request
        // (after a cancel, i.e. out of `Idle`) is a fresh cycle that
        // requests a flush again: whether that close discards unsaved
        // edits is the frontend's call (it knows every accepted edit,
        // including saves that have not reached Rust yet). The only
        // pass-through is a close while a destroy is already in flight
        // (`Closing`). The JS `onCloseRequested` API is
        // deliberately not used: its close path calls `destroy()`, which
        // needs the `core:window:allow-destroy` capability (a permission
        // change).
        // The macOS menu's Quit item (⌘Q) is a custom item that routes
        // through this same flow (see `menu.rs`). Dock "Quit" and OS
        // logout terminate the process directly and bypass it.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let Some(guard) = window.app_handle().try_state::<Arc<CloseGuard>>() else {
                return;
            };
            let (action, cycle) = {
                let mut state = guard.state.lock();
                let (a, n) = handle_close_request(*state);
                // The no-ack fallback is started for the cycle this close
                // request began (a new one only out of `Idle`): capture
                // the post-transition cycle so the timer acts only while
                // that cycle is still current.
                let c = n.cycle;
                *state = n;
                (a, c)
            };
            match action {
                CloseAction::Intercept { emit } => {
                    api.prevent_close();
                    if !emit {
                        return;
                    }
                    let _ = tauri::Emitter::emit(window, HIGHLIGHTS_FLUSH_EVENT, ());
                    // The frontend acks as soon as it receives the flush
                    // request. If it never does (JS dead or the event
                    // undelivered), destroy after 2 s. A plain OS thread
                    // avoids needing a tokio `time` dependency;
                    // `Window::destroy` is dispatcher-based and
                    // thread-safe. The check at expiry is phase- and
                    // cycle-aware: an ack (`Flushing`) or a cancel
                    // (`Idle`) suppresses it, and a later close
                    // cycle retires it (`handle_timer`).
                    let guard = Arc::clone(&*guard);
                    let window = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let destroy = {
                            let mut state = guard.state.lock();
                            let (d, n) = handle_timer(*state, FlushTimer::NoAck, cycle);
                            *state = n;
                            d
                        };
                        if destroy {
                            // A failed destroy must not leave the window
                            // trapped in `Closing` (no timer acts from
                            // that phase): log the failure without
                            // values and return the guard to `Idle`
                            // (`on_destroy_result`), so the next close
                            // request is a fresh cycle.
                            if window.destroy().is_err() {
                                eprintln!(
                                    "marque: could not destroy the main window (2 s no-ack fallback)"
                                );
                                let mut state = guard.state.lock();
                                *state = on_destroy_result(*state, false);
                            }
                        }
                    });
                }
                // Let the window close: a destroy is already in flight
                // for this window (`Closing`) — an in-flight OS close
                // (or the recovery after a failed destroy) passes
                // through instead of being intercepted.
                CloseAction::Pass => {}
            }
        })
        .setup(move |app| {
            settings::migrate_legacy_settings();
            let dir = settings_dir();
            let loaded_settings = Settings::load_with_status(&dir)?;
            let registry: SharedRegistry = Arc::new(FolderRegistry::from_settings(loaded_settings.settings));
            let watchers: SharedWatchers = Arc::new(Watchers::default());

            let initial_resolved = match &initial {
                cli::InitialTarget::Folder { path } => {
                    match registry.add_folder_with_status(PathBuf::from(path)) {
                        Ok((folder, _)) => {
                            let _ = registry.save(&dir);
                            cli::InitialTarget::Folder { path: folder.path }
                        }
                        Err(_) => cli::InitialTarget::None,
                    }
                }
                other => other.clone(),
            };

            app.manage(InitialTargetState(Mutex::new(initial_resolved)));
            app.manage(Arc::new(CloseGuard {
                state: Mutex::new(CloseState {
                    phase: ClosePhase::Idle,
                    cycle: 0,
                }),
            }));
            app.manage(loaded_settings.status);
            app.manage(Arc::clone(&registry));
            app.manage(Arc::clone(&watchers));
            hydrate_folders(app.handle().clone(), registry, watchers);

            // Replace Tauri's default macOS menu bar with marque's own menu.
            // On other platforms no menu is installed and every shortcut is
            // handled by the webview keydown handler.
            #[cfg(target_os = "macos")]
            {
                let menu = menu::build_menu(app.handle())?;
                // The returned `Option` is the previously installed menu (none
                // yet at setup time); we don't need it.
                let _ = menu.set_as_app_menu()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_initial_target,
            commands::set_initial_target,
            commands::read_file,
            commands::list_folders,
            commands::list_folders_grouped,
            commands::add_folder,
            commands::remove_folder,
            commands::set_folder_group,
            commands::read_folder_tree,
            commands::search_files,
            commands::get_recent_files,
            commands::list_pinned_files,
            commands::pin_file,
            commands::unpin_file,
            commands::save_theme,
            commands::save_preferences,
            commands::load_preferences,
            commands::get_settings_load_status,
            commands::reveal_in_file_manager,
            commands::get_highlights,
            commands::save_highlights,
            commands::get_highlights_key,
            commands::list_highlighted_paths,
            commands::ack_close_request,
            commands::confirm_close,
            commands::cancel_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Handle macOS file-open events (Finder "Open With", Dock drag-drop,
    // `open /path/to/file.md` when Marque is the default handler).
    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let target = cli::classify(&path);
                    if target != cli::InitialTarget::None {
                        handle_target(_app_handle, target);
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod close_guard {
    use super::*;

    /// Build a `CloseState` from a phase and an explicit cycle.
    fn close_state(phase: ClosePhase, cycle: u64) -> CloseState {
        CloseState { phase, cycle }
    }

    #[test]
    fn first_close_intercepts_and_requests_a_flush_and_starts_a_new_cycle() {
        let (action, next) = handle_close_request(close_state(ClosePhase::Idle, 7));
        assert_eq!(action, CloseAction::Intercept { emit: true });
        // A new close request starts a new cycle, retiring any timer
        // still sleeping from a previous one.
        assert_eq!(next, close_state(ClosePhase::FlushRequested, 8));
    }

    #[test]
    fn a_second_close_while_waiting_for_the_ack_is_intercepted_again() {
        let (action, next) = handle_close_request(close_state(ClosePhase::FlushRequested, 3));
        assert_eq!(action, CloseAction::Intercept { emit: false });
        // A re-intercepted close keeps the in-flight cycle.
        assert_eq!(next, close_state(ClosePhase::FlushRequested, 3));
    }

    #[test]
    fn a_second_close_during_an_in_flight_flush_is_intercepted_not_passed() {
        // The regression this exists to fix: the old guard let a second
        // close through once any close had been attempted, destroying the
        // window while an acknowledged save was still in flight.
        let (action, next) = handle_close_request(close_state(ClosePhase::Flushing, 3));
        assert_eq!(action, CloseAction::Intercept { emit: false });
        assert_eq!(next, close_state(ClosePhase::Flushing, 3));
    }

    #[test]
    fn a_close_after_a_failed_flush_requests_a_fresh_flush_cycle() {
        // A failed flush was cancelled: the guard is back in `Idle` for
        // the same cycle. The user's next close request is a *new*
        // cycle (bumping the token retires the previous cycle's
        // timers) that requests a flush again — whether it ends in a
        // discard is the frontend's decision.
        let s = handle_cancel(close_state(ClosePhase::Flushing, 3));
        let (action, next) = handle_close_request(s);
        assert_eq!(action, CloseAction::Intercept { emit: true });
        assert_eq!(next, close_state(ClosePhase::FlushRequested, 4));
    }

    #[test]
    fn a_close_while_closing_passes_through() {
        // The reviewer-blocked regression: a failed `window.destroy()`
        // used to leave the phase stuck in `Closing`, where every timer
        // is a no-op and the next close request was intercepted — the
        // window could never be closed again. A close that arrives
        // while a destroy is in flight (or after a failed one) passes
        // through (the OS close then proceeds normally).
        let (action, next) = handle_close_request(close_state(ClosePhase::Closing, 3));
        assert_eq!(action, CloseAction::Pass);
        assert_eq!(next, close_state(ClosePhase::Closing, 3));
    }

    #[test]
    fn a_failed_destroy_while_closing_returns_to_idle() {
        // A failed destroy un-traps the window: the guard returns to
        // `Idle` (same cycle), so the next close request is a fresh
        // cycle that requests a flush and can destroy again.
        assert_eq!(
            on_destroy_result(close_state(ClosePhase::Closing, 3), false),
            close_state(ClosePhase::Idle, 3)
        );
    }

    #[test]
    fn a_succeeded_destroy_leaves_the_phase_alone() {
        assert_eq!(
            on_destroy_result(close_state(ClosePhase::Closing, 3), true),
            close_state(ClosePhase::Closing, 3)
        );
    }

    #[test]
    fn a_failed_destroy_outside_closing_is_a_noop() {
        // Destroy is only ever ordered from `Closing`; a failure from
        // any other phase is a no-op (and keeps the cycle).
        for phase in [ClosePhase::Idle, ClosePhase::FlushRequested, ClosePhase::Flushing] {
            assert_eq!(on_destroy_result(close_state(phase, 3), false), close_state(phase, 3));
        }
    }

    #[test]
    fn an_ack_moves_flush_requested_to_flushing() {
        // An ack belongs to the same cycle the flush-request started.
        assert_eq!(
            handle_ack(close_state(ClosePhase::FlushRequested, 3)),
            close_state(ClosePhase::Flushing, 3)
        );
    }

    #[test]
    fn a_stale_ack_is_a_noop() {
        for phase in [ClosePhase::Idle, ClosePhase::Flushing, ClosePhase::Closing] {
            assert_eq!(handle_ack(close_state(phase, 3)), close_state(phase, 3));
        }
    }

    #[test]
    fn a_confirm_after_a_landed_flush_destroys() {
        // A confirm belongs to the in-flight cycle (the one it was
        // acknowledged in).
        assert_eq!(
            handle_confirm(close_state(ClosePhase::Flushing, 3)),
            (close_state(ClosePhase::Closing, 3), true)
        );
    }

    #[test]
    fn a_confirm_that_skipped_the_ack_still_destroys() {
        // Off-protocol (no ack first), but the frontend says the flush
        // landed, so destroying is data-safe.
        assert_eq!(
            handle_confirm(close_state(ClosePhase::FlushRequested, 3)),
            (close_state(ClosePhase::Closing, 3), true)
        );
    }

    #[test]
    fn a_confirm_after_a_failed_flush_does_not_destroy() {
        // A late or duplicated confirm after a cancelled (failed) flush
        // must not undo "stay open": the guard is back in `Idle`, and a
        // confirm there is a no-op (a discard goes through the next
        // close's fresh flush cycle, confirmed by the frontend).
        assert_eq!(
            handle_confirm(close_state(ClosePhase::Idle, 3)),
            (close_state(ClosePhase::Idle, 3), false)
        );
        assert_eq!(
            handle_confirm(close_state(ClosePhase::Closing, 3)),
            (close_state(ClosePhase::Closing, 3), false)
        );
    }

    #[test]
    fn a_cancel_moves_the_flush_cycle_back_to_idle() {
        // A failed flush cancels the close and returns the guard to
        // `Idle` for the *same* cycle: the in-flight timers keep their
        // (now-retired-once-bumped) token, and the user's next close
        // request is a fresh cycle (see the close-request tests).
        assert_eq!(
            handle_cancel(close_state(ClosePhase::FlushRequested, 3)),
            close_state(ClosePhase::Idle, 3)
        );
        assert_eq!(
            handle_cancel(close_state(ClosePhase::Flushing, 3)),
            close_state(ClosePhase::Idle, 3)
        );
    }

    #[test]
    fn a_stale_cancel_is_a_noop() {
        for phase in [ClosePhase::Idle, ClosePhase::Closing] {
            assert_eq!(handle_cancel(close_state(phase, 3)), close_state(phase, 3));
        }
    }

    #[test]
    fn the_no_ack_fallback_destroys_only_when_unacked() {
        // A timer that fires in its own (current) cycle acts.
        assert_eq!(
            handle_timer(close_state(ClosePhase::FlushRequested, 3), FlushTimer::NoAck, 3),
            (true, close_state(ClosePhase::Closing, 3))
        );
        // Acked: the 30 s ceiling governs, not this fallback.
        assert_eq!(
            handle_timer(close_state(ClosePhase::Flushing, 3), FlushTimer::NoAck, 3),
            (false, close_state(ClosePhase::Flushing, 3))
        );
        // Cancelled (even before an ack) the guard is back in `Idle`:
        // the window must stay open.
        assert_eq!(
            handle_timer(close_state(ClosePhase::Idle, 3), FlushTimer::NoAck, 3),
            (false, close_state(ClosePhase::Idle, 3))
        );
        assert_eq!(
            handle_timer(close_state(ClosePhase::Closing, 3), FlushTimer::NoAck, 3),
            (false, close_state(ClosePhase::Closing, 3))
        );
    }

    #[test]
    fn the_ceiling_destroys_only_a_hung_flush() {
        assert_eq!(
            handle_timer(close_state(ClosePhase::Flushing, 3), FlushTimer::Ceiling, 3),
            (true, close_state(ClosePhase::Closing, 3))
        );
        assert_eq!(
            handle_timer(close_state(ClosePhase::FlushRequested, 3), FlushTimer::Ceiling, 3),
            (false, close_state(ClosePhase::FlushRequested, 3))
        );
        assert_eq!(
            handle_timer(close_state(ClosePhase::Idle, 3), FlushTimer::Ceiling, 3),
            (false, close_state(ClosePhase::Idle, 3))
        );
        assert_eq!(
            handle_timer(close_state(ClosePhase::Closing, 3), FlushTimer::Ceiling, 3),
            (false, close_state(ClosePhase::Closing, 3))
        );
    }

    #[test]
    fn a_timer_outlives_its_cycle_after_a_cancelled_close_and_is_a_noop() {
        // The reviewer-blocked regression, in its current shape: a close
        // was cancelled (a failed flush left the guard in `Idle` for
        // cycle `old`) and the user's *next* close request started a
        // fresh cycle `new` while the previous cycle's timers were
        // still sleeping.
        let (a, s1) = handle_close_request(close_state(ClosePhase::Idle, 1));
        assert_eq!(a, CloseAction::Intercept { emit: true });
        let old = s1.cycle; // the no-ack timer started for this cycle
        assert_ne!(old, 1);
        let s2 = handle_cancel(s1); // the flush failed: stay open
        let (a2, s4) = handle_close_request(s2); // the user closes again
        assert_eq!(a2, CloseAction::Intercept { emit: true });
        let new = s4.cycle;
        assert_ne!(new, old);

        // The old cycle's no-ack timer wakes while the window is in a
        // *later* cycle's `FlushRequested`: it must not destroy (nor even
        // touch) the current state.
        assert_eq!(
            handle_timer(s4, FlushTimer::NoAck, old),
            (false, s4)
        );
        // The old cycle's 30 s ceiling (started by the first cycle's ack)
        // is retired the same way, whether the window is mid-flush or
        // still waiting for its ack.
        let acked = handle_ack(s4);
        assert_eq!(
            handle_timer(acked, FlushTimer::Ceiling, old),
            (false, acked)
        );
        assert_eq!(
            handle_timer(s4, FlushTimer::Ceiling, old),
            (false, s4)
        );
        // The new cycle's own timers still work: the no-ack fallback
        // destroys a window that never acked in this cycle, and the
        // ceiling a flush that hangs in it.
        assert_eq!(
            handle_timer(s4, FlushTimer::NoAck, new),
            (true, close_state(ClosePhase::Closing, new))
        );
        assert_eq!(
            handle_timer(acked, FlushTimer::Ceiling, new),
            (true, close_state(ClosePhase::Closing, new))
        );
    }
}
