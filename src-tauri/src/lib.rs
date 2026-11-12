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

/// First-`CloseRequested`-only guard for the main window: the first close
/// request is prevented so the frontend can flush (and then call
/// `confirm_close`); a second request before the flush lands closes the
/// window for real. The main window is created once per process (this app
/// never creates a replacement one), so the guard is per process.
struct CloseGuard {
    attempted: AtomicBool,
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
        // in-flight highlight saves (it answers with `confirm_close`,
        // which destroys the window). A second request before the flush
        // lands — or one after the 2 s fallback timer expired — closes
        // for real. The JS `onCloseRequested` API is deliberately not
        // used: its close path calls `destroy()`, which needs the
        // `core:window:allow-destroy` capability (a permission change).
        // Cmd+Q / app quit bypasses this flow and exits like before.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let Some(guard) = window.app_handle().try_state::<CloseGuard>() else {
                return;
            };
            if guard.attempted.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = tauri::Emitter::emit(window, HIGHLIGHTS_FLUSH_EVENT, ());
            // No confirmation from the frontend within 2 s (JS dead or the
            // flush hung): close anyway. A plain OS thread avoids needing a
            // tokio `time` dependency; `Window::destroy` is dispatcher-based
            // and thread-safe. May race a late `confirm_close`; a second
            // destroy is an error we ignore.
            let window = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = window.destroy();
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
            app.manage(CloseGuard {
                attempted: AtomicBool::new(false),
            });
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
            commands::confirm_close,
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
