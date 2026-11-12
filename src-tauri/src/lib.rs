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
/// pure functions over this enum (below), so they are unit-testable
/// without a window; the guard is a single mutex holding the current
/// phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClosePhase {
    /// No close in flight.
    Idle,
    /// A close was intercepted and the `highlights://flush-request`
    /// event was emitted; waiting for the frontend ack.
    FlushRequested,
    /// The frontend acked the flush request; a save is in progress.
    Flushing,
    /// The frontend cancelled (its flush failed). The next close request
    /// passes through: "close without saving". A new edit accepted in
    /// this phase re-arms the guard through `rearm_close_guard` (back to
    /// `Idle`), so a later close flushes those edits instead of
    /// discarding them.
    DiscardAllowed,
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
    /// Let the window close: the last flush failed (`DiscardAllowed`)
    /// and the user chose to leave without saving.
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

/// Decide how to handle a new close request in `phase`, and the phase
/// that results.
///
/// A close while `FlushRequested` or `Flushing` is intercepted again —
/// the in-flight save must not be lost by a second close (the old guard
/// passed a second close through once any close had been attempted,
/// which destroyed the window mid-save). `DiscardAllowed` (a failed
/// flush) lets a close through: "close without saving". `Closing` also
/// passes — a failed `window.destroy()` leaves the window alive in
/// `Closing` and no timer ever acts from there, so only a further OS
/// close (the platform's own destruction attempt) can get out of it;
/// the `on_destroy_result` recovery handles that.
fn handle_close_request(phase: ClosePhase) -> (CloseAction, ClosePhase) {
    match phase {
        ClosePhase::Idle => (
            CloseAction::Intercept { emit: true },
            ClosePhase::FlushRequested,
        ),
        ClosePhase::FlushRequested | ClosePhase::Flushing => {
            (CloseAction::Intercept { emit: false }, phase)
        }
        ClosePhase::DiscardAllowed | ClosePhase::Closing => (CloseAction::Pass, phase),
    }
}

/// Decide whether `timer` firing in `phase` destroys the window, and the
/// phase that results (a destroy moves to `Closing`).
///
/// `NoAck` fires only from `FlushRequested`: the frontend is dead or the
/// event was lost, so no flush is in flight. Once acked (`Flushing`) the
/// 30 s ceiling governs instead. `DiscardAllowed` keeps the window open in
/// either case — a cancelled (failed) flush must not be undone by a
/// timer.
fn handle_timer(timer: FlushTimer, phase: ClosePhase) -> (bool, ClosePhase) {
    match (timer, phase) {
        (FlushTimer::NoAck, ClosePhase::FlushRequested) => (true, ClosePhase::Closing),
        (FlushTimer::Ceiling, ClosePhase::Flushing) => (true, ClosePhase::Closing),
        _ => (false, phase),
    }
}

/// The phase after the frontend acked the flush request. Only an ack in
/// `FlushRequested` counts; a stale or duplicated ack in any other phase
/// is a no-op (and starts no ceiling).
fn handle_ack(phase: ClosePhase) -> ClosePhase {
    match phase {
        ClosePhase::FlushRequested => ClosePhase::Flushing,
        other => other,
    }
}

/// The phase after `confirm_close` (the flush has landed), and whether
/// the window should be destroyed now. Only from `Flushing` — or from
/// `FlushRequested`, where the frontend skipped the ack but says the
/// flush landed, which is data-safe to destroy. Never from
/// `DiscardAllowed`: a flush that failed has told the user the window
/// stays open, and a stray late confirm must not undo that.
fn handle_confirm(phase: ClosePhase) -> (ClosePhase, bool) {
    match phase {
        ClosePhase::Flushing | ClosePhase::FlushRequested => (ClosePhase::Closing, true),
        other => (other, false),
    }
}

/// The phase after `cancel_close` (the flush failed: stay open, and let
/// the next close through — "close without saving"). Only from an
/// in-flight flush cycle; a stale cancel is a no-op.
fn handle_cancel(phase: ClosePhase) -> ClosePhase {
    match phase {
        ClosePhase::FlushRequested | ClosePhase::Flushing => ClosePhase::DiscardAllowed,
        other => other,
    }
}

/// The phase after a `window.destroy()` attempt in `phase`. A success
/// leaves the phase alone (the window is gone; no further transition
/// matters). A failure out of `Closing` moves to `DiscardAllowed`, so
/// the next close request passes through instead of being trapped
/// behind an un-destroyed window (a failed destroy must not leave the
/// window uncloseable — "close without saving" recovers it). A failure
/// from any other phase is a no-op: destroy is only ever ordered from
/// `Closing`.
fn on_destroy_result(phase: ClosePhase, ok: bool) -> ClosePhase {
    if !ok && phase == ClosePhase::Closing {
        ClosePhase::DiscardAllowed
    } else {
        phase
    }
}

/// The phase after `rearm_close_guard`: a new edit was accepted after a
/// cancelled (failed) flush, so `DiscardAllowed` — "the next close passes
/// through without saving" — must not outlive it: back to `Idle`, where
/// the next close request intercepts and asks for a fresh flush. A
/// stale rearm in any other phase is a no-op: it must not disturb an
/// in-flight cycle or a window that is already closing.
fn handle_rearm(phase: ClosePhase) -> ClosePhase {
    match phase {
        ClosePhase::DiscardAllowed => ClosePhase::Idle,
        other => other,
    }
}

/// Close-request state for the main window, shared with the frontend-ack
/// flow through the `Arc` in managed state. A single mutex-held phase
/// instead of four racing flags: every transition is a compare-and-swap
/// decided by the pure `handle_*` functions above, so a second close
/// during an in-flight flush is intercepted (not passed through) and a
/// stale ack/confirm/cancel can no longer undo a decision. The main
/// window is created once per process (this app never creates a
/// replacement one), so the guard is per process.
struct CloseGuard {
    phase: Mutex<ClosePhase>,
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
        // (flush failed: stay open). A further close request while the
        // flush cycle is in flight is intercepted again — no new event,
        // no new timers — so an in-flight save cannot be lost; only after
        // a cancelled (failed) flush (`DiscardAllowed`) does a close pass
        // through without saving. The JS `onCloseRequested` API is
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
            let action = {
                let mut phase = guard.phase.lock();
                let (a, n) = handle_close_request(*phase);
                *phase = n;
                a
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
                    // thread-safe. The check at expiry is phase-aware: an
                    // ack (`Flushing`) or a cancel (`DiscardAllowed`) in
                    // the meantime suppresses it.
                    let guard = Arc::clone(&*guard);
                    let window = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let destroy = {
                            let mut phase = guard.phase.lock();
                            let (d, n) = handle_timer(FlushTimer::NoAck, *phase);
                            *phase = n;
                            d
                        };
                        if destroy {
                            // A failed destroy must not leave the window
                            // trapped in `Closing` (no timer acts from
                            // that phase): log the failure without
                            // values and let the next close request
                            // pass through (`on_destroy_result` moves
                            // the phase to `DiscardAllowed`).
                            if window.destroy().is_err() {
                                eprintln!(
                                    "marque: could not destroy the main window (2 s no-ack fallback)"
                                );
                                let mut phase = guard.phase.lock();
                                *phase = on_destroy_result(*phase, false);
                            }
                        }
                    });
                }
                // Let the window close: the last flush failed and the
                // user has asked to leave without saving.
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
                phase: Mutex::new(ClosePhase::Idle),
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
            commands::rearm_close_guard,
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

    #[test]
    fn first_close_intercepts_and_requests_a_flush() {
        let (action, next) = handle_close_request(ClosePhase::Idle);
        assert_eq!(action, CloseAction::Intercept { emit: true });
        assert_eq!(next, ClosePhase::FlushRequested);
    }

    #[test]
    fn a_second_close_while_waiting_for_the_ack_is_intercepted_again() {
        let (action, next) = handle_close_request(ClosePhase::FlushRequested);
        assert_eq!(action, CloseAction::Intercept { emit: false });
        assert_eq!(next, ClosePhase::FlushRequested);
    }

    #[test]
    fn a_second_close_during_an_in_flight_flush_is_intercepted_not_passed() {
        // The regression this exists to fix: the old guard let a second
        // close through once any close had been attempted, destroying the
        // window while an acknowledged save was still in flight.
        let (action, next) = handle_close_request(ClosePhase::Flushing);
        assert_eq!(action, CloseAction::Intercept { emit: false });
        assert_eq!(next, ClosePhase::Flushing);
    }

    #[test]
    fn a_close_after_a_failed_flush_passes_through() {
        let (action, next) = handle_close_request(ClosePhase::DiscardAllowed);
        assert_eq!(action, CloseAction::Pass);
        assert_eq!(next, ClosePhase::DiscardAllowed);
    }

    #[test]
    fn a_close_while_closing_passes_through() {
        // The reviewer-blocked regression: a failed `window.destroy()`
        // used to leave the phase stuck in `Closing`, where every timer
        // is a no-op and the next close request was intercepted — the
        // window could never be closed again. Letting the request
        // through (the OS close then proceeds normally) is the recovery.
        let (action, next) = handle_close_request(ClosePhase::Closing);
        assert_eq!(action, CloseAction::Pass);
        assert_eq!(next, ClosePhase::Closing);
    }

    #[test]
    fn a_failed_destroy_while_closing_allows_the_next_close() {
        assert_eq!(
            on_destroy_result(ClosePhase::Closing, false),
            ClosePhase::DiscardAllowed
        );
    }

    #[test]
    fn a_succeeded_destroy_leaves_the_phase_alone() {
        assert_eq!(
            on_destroy_result(ClosePhase::Closing, true),
            ClosePhase::Closing
        );
    }

    #[test]
    fn a_failed_destroy_outside_closing_is_a_noop() {
        // Destroy is only ever ordered from `Closing`; a failure from
        // any other phase is a no-op.
        for phase in [
            ClosePhase::Idle,
            ClosePhase::FlushRequested,
            ClosePhase::Flushing,
            ClosePhase::DiscardAllowed,
        ] {
            assert_eq!(on_destroy_result(phase, false), phase);
        }
    }

    #[test]
    fn a_rearm_after_a_failed_flush_restores_protection() {
        assert_eq!(
            handle_rearm(ClosePhase::DiscardAllowed),
            ClosePhase::Idle
        );
    }

    #[test]
    fn a_stale_rearm_is_a_noop() {
        for phase in [
            ClosePhase::Idle,
            ClosePhase::FlushRequested,
            ClosePhase::Flushing,
            ClosePhase::Closing,
        ] {
            assert_eq!(handle_rearm(phase), phase);
        }
    }

    #[test]
    fn a_close_after_rearm_intercepts_and_requests_a_flush_again() {
        // The CodeRabbit third-pass regression: `DiscardAllowed` used to
        // outlive new edits accepted after a cancelled close, so a later
        // close discarded those edits without a flush. After re-arm the
        // next close starts a fresh flush cycle.
        let phase = handle_rearm(ClosePhase::DiscardAllowed);
        let (action, next) = handle_close_request(phase);
        assert_eq!(action, CloseAction::Intercept { emit: true });
        assert_eq!(next, ClosePhase::FlushRequested);
    }

    #[test]
    fn an_ack_moves_flush_requested_to_flushing() {
        assert_eq!(handle_ack(ClosePhase::FlushRequested), ClosePhase::Flushing);
    }

    #[test]
    fn a_stale_ack_is_a_noop() {
        for phase in [
            ClosePhase::Idle,
            ClosePhase::Flushing,
            ClosePhase::DiscardAllowed,
            ClosePhase::Closing,
        ] {
            assert_eq!(handle_ack(phase), phase);
        }
    }

    #[test]
    fn a_confirm_after_a_landed_flush_destroys() {
        assert_eq!(
            handle_confirm(ClosePhase::Flushing),
            (ClosePhase::Closing, true)
        );
    }

    #[test]
    fn a_confirm_that_skipped_the_ack_still_destroys() {
        // Off-protocol (no ack first), but the frontend says the flush
        // landed, so destroying is data-safe.
        assert_eq!(
            handle_confirm(ClosePhase::FlushRequested),
            (ClosePhase::Closing, true)
        );
    }

    #[test]
    fn a_confirm_after_a_failed_flush_does_not_destroy() {
        // A late or duplicated confirm after a cancelled (failed) flush
        // must not undo "stay open".
        assert_eq!(
            handle_confirm(ClosePhase::DiscardAllowed),
            (ClosePhase::DiscardAllowed, false)
        );
        assert_eq!(handle_confirm(ClosePhase::Idle), (ClosePhase::Idle, false));
        assert_eq!(
            handle_confirm(ClosePhase::Closing),
            (ClosePhase::Closing, false)
        );
    }

    #[test]
    fn a_cancel_moves_the_flush_cycle_to_discard_allowed() {
        assert_eq!(
            handle_cancel(ClosePhase::FlushRequested),
            ClosePhase::DiscardAllowed
        );
        assert_eq!(
            handle_cancel(ClosePhase::Flushing),
            ClosePhase::DiscardAllowed
        );
    }

    #[test]
    fn a_stale_cancel_is_a_noop() {
        for phase in [
            ClosePhase::Idle,
            ClosePhase::DiscardAllowed,
            ClosePhase::Closing,
        ] {
            assert_eq!(handle_cancel(phase), phase);
        }
    }

    #[test]
    fn the_no_ack_fallback_destroys_only_when_unacked() {
        assert_eq!(
            handle_timer(FlushTimer::NoAck, ClosePhase::FlushRequested),
            (true, ClosePhase::Closing)
        );
        // Acked: the 30 s ceiling governs, not this fallback.
        assert_eq!(
            handle_timer(FlushTimer::NoAck, ClosePhase::Flushing),
            (false, ClosePhase::Flushing)
        );
        // Cancelled (even before an ack): the window must stay open.
        assert_eq!(
            handle_timer(FlushTimer::NoAck, ClosePhase::DiscardAllowed),
            (false, ClosePhase::DiscardAllowed)
        );
        assert_eq!(
            handle_timer(FlushTimer::NoAck, ClosePhase::Idle),
            (false, ClosePhase::Idle)
        );
        assert_eq!(
            handle_timer(FlushTimer::NoAck, ClosePhase::Closing),
            (false, ClosePhase::Closing)
        );
    }

    #[test]
    fn the_ceiling_destroys_only_a_hung_flush() {
        assert_eq!(
            handle_timer(FlushTimer::Ceiling, ClosePhase::Flushing),
            (true, ClosePhase::Closing)
        );
        assert_eq!(
            handle_timer(FlushTimer::Ceiling, ClosePhase::FlushRequested),
            (false, ClosePhase::FlushRequested)
        );
        assert_eq!(
            handle_timer(FlushTimer::Ceiling, ClosePhase::DiscardAllowed),
            (false, ClosePhase::DiscardAllowed)
        );
        assert_eq!(
            handle_timer(FlushTimer::Ceiling, ClosePhase::Idle),
            (false, ClosePhase::Idle)
        );
    }
}
