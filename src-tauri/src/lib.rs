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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use watcher::{hydrate_folder, hydrate_folders, SharedWatchers, Watchers};

/// Event asking the frontend to flush pending highlights saves before the
/// window is destroyed; the frontend answers with the `confirm_close`
/// command.
const HIGHLIGHTS_FLUSH_EVENT: &str = "highlights://flush-request";

/// Close-request state for the main window, shared with the frontend-ack
/// flow through the `Arc` in managed state. `attempted` marks that a close
/// has been intercepted (a second request before the ack passes through and
/// closes for real); `acked` means the frontend received the flush request
/// (suppressing the 2 s "frontend dead" fallback and starting the 30 s
/// ceiling); `confirmed` means `confirm_close` arrived (flush landed);
/// `cancelled` means `cancel_close` arrived (flush failed, stay open). The
/// main window is created once per process (this app never creates a
/// replacement one), so the guard is per process.
struct CloseGuard {
    attempted: AtomicBool,
    acked: AtomicBool,
    confirmed: AtomicBool,
    cancelled: AtomicBool,
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
        // the 2 s fallback below is suppressed) and then `confirm_close`
        // (flush landed: destroy) or `cancel_close` (flush failed: stay
        // open). A second request before the ack lands closes for real.
        // The JS `onCloseRequested` API is deliberately not used: its
        // close path calls `destroy()`, which needs the
        // `core:window:allow-destroy` capability (a permission change).
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
            // A second close request before the first was acknowledged:
            // pass through and close for real ("close without saving").
            if guard.attempted.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = tauri::Emitter::emit(window, HIGHLIGHTS_FLUSH_EVENT, ());
            // The frontend acks as soon as it receives the flush request.
            // If it never does (JS dead or the event undelivered), destroy
            // after 2 s. A plain OS thread avoids needing a tokio `time`
            // dependency; `Window::destroy` is dispatcher-based and
            // thread-safe. Once the frontend has acked, the 30 s ceiling
            // started by `ack_close_request` supersedes this fallback.
            let guard = Arc::clone(&*guard);
            let window = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if !guard.acked.load(Ordering::SeqCst) {
                    let _ = window.destroy();
                }
            });
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
                attempted: AtomicBool::new(false),
                acked: AtomicBool::new(false),
                confirmed: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
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
