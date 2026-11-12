use crate::cli::InitialTarget;
use crate::error::{AppError, AppResult};
use crate::folder::TreeNode;
use crate::highlights::{Highlight, HighlightsFile, MAX_HIGHLIGHTS_PER_FILE, MAX_NOTE_CHARS};
use crate::registry::SharedRegistry;
use crate::search::{search, SearchResult};
use crate::settings::{settings_dir, Folder, SettingsLoadStatus};
use crate::watcher::{hydrate_folder, SharedWatchers};
use anyhow::Context as _;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct InitialTargetState(pub Mutex<InitialTarget>);

/// Run a blocking body on the blocking thread pool and await it. Tauri 2
/// runs synchronous commands on the main thread, where the highlights
/// commands' file I/O (including the durability `fsync`s) would freeze
/// window input and close handling on a slow volume. A join failure
/// (worker panic or cancellation) is mapped to an `AppError` with
/// context; the error value itself is never echoed — a panic message
/// could carry values. The RMW/KEY locks are taken inside the blocking
/// body, so their coverage is unchanged.
async fn run_blocking<T: Send + 'static>(
    op: &'static str,
    body: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(body)
        .await
        .map_err(|_e| {
            AppError::Other(anyhow::anyhow!(
                "{op}: the blocking worker was cancelled or panicked before returning a result"
            ))
        })?
}

#[tauri::command]
pub fn get_initial_target(state: State<'_, InitialTargetState>) -> InitialTarget {
    state.0.lock().clone()
}

#[tauri::command]
pub fn set_initial_target(target: InitialTarget, state: State<'_, InitialTargetState>) {
    *state.0.lock() = target;
}

#[tauri::command]
pub fn read_file(
    app: AppHandle,
    path: String,
    registry: State<'_, SharedRegistry>,
) -> AppResult<String> {
    let contents = crate::fs::read_text(&path)?;
    // Resolve symlinks and `..` before choosing what the asset protocol may
    // serve, so the grant lands on the document's real directory. If the path
    // cannot be resolved, grant nothing: the document still renders, its
    // local images do not.
    if let Some(document) = crate::fs::canonical_document_path(&path) {
        let folder_root = registry.folder_root_containing(&document);
        if let Err(error) = crate::fs::grant_asset_scope(&app, &document, folder_root) {
            eprintln!("marque: {error}");
        }
    } else {
        eprintln!("marque: could not resolve {path}; local images will not load");
    }
    registry.push_recent(path);
    Arc::clone(&*registry).persist_async(settings_dir());
    Ok(contents)
}

#[tauri::command]
pub fn list_folders(registry: State<'_, SharedRegistry>) -> Vec<Folder> {
    registry.folders()
}

#[derive(serde::Serialize)]
pub struct AnnotatedFolder {
    #[serde(flatten)]
    pub folder: Folder,
    pub repo_root: Option<String>,
    pub repo_name: Option<String>,
}

#[tauri::command]
pub fn list_folders_grouped(registry: State<'_, SharedRegistry>) -> Vec<AnnotatedFolder> {
    registry
        .folders()
        .into_iter()
        .map(|f| {
            let repo_root =
                crate::folder::find_git_repo_root(std::path::Path::new(&f.path));
            let repo_name = repo_root.as_ref().and_then(|r| {
                std::path::Path::new(r)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(String::from)
            });
            AnnotatedFolder {
                folder: f,
                repo_root,
                repo_name,
            }
        })
        .collect()
}

#[tauri::command]
pub fn add_folder(
    app: AppHandle,
    path: String,
    registry: State<'_, SharedRegistry>,
    watchers: State<'_, SharedWatchers>,
) -> AppResult<Folder> {
    let (folder, added) = registry.add_folder_with_status(PathBuf::from(&path))?;
    registry.save(&settings_dir())?;
    if added {
        hydrate_folder(
            app.clone(),
            Arc::clone(&*registry),
            Arc::clone(&*watchers),
            folder.clone(),
        );
    }
    let _ = app.emit("folder://changed", &folder.id);
    Ok(folder)
}

#[tauri::command]
pub fn remove_folder(
    app: AppHandle,
    id: String,
    registry: State<'_, SharedRegistry>,
    watchers: State<'_, SharedWatchers>,
) -> AppResult<()> {
    registry.remove_folder(&id);
    watchers.remove(&id);
    registry.save(&settings_dir())?;
    let _ = app.emit("folder://changed", &id);
    Ok(())
}

#[tauri::command]
pub fn set_folder_group(
    app: AppHandle,
    folder_ids: Vec<String>,
    group: Option<String>,
    registry: State<'_, SharedRegistry>,
) -> AppResult<Vec<Folder>> {
    let folders = registry.set_folder_group(&folder_ids, group)?;
    registry.save(&settings_dir())?;
    let payload = folders.first().map(|folder| folder.id.as_str()).unwrap_or("");
    let _ = app.emit("folder://changed", payload);
    Ok(folders)
}

#[tauri::command]
pub fn read_folder_tree(id: String, registry: State<'_, SharedRegistry>) -> AppResult<TreeNode> {
    registry
        .tree_or_empty(&id)
        .ok_or_else(|| AppError::NotFound(format!("folder {id}")))
}

#[derive(serde::Deserialize)]
pub struct SearchArgs {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    50
}

#[tauri::command]
pub fn search_files(
    args: SearchArgs,
    registry: State<'_, SharedRegistry>,
) -> Vec<SearchResult> {
    let snapshot = registry.index_snapshot();
    search(&snapshot, &args.query, args.limit)
}

#[tauri::command]
pub fn get_recent_files(registry: State<'_, SharedRegistry>) -> Vec<String> {
    registry.settings().recent_files
}

#[tauri::command]
pub fn list_pinned_files(registry: State<'_, SharedRegistry>) -> Vec<String> {
    registry.pinned_files()
}

#[tauri::command]
pub fn pin_file(path: String, registry: State<'_, SharedRegistry>) -> AppResult<Vec<String>> {
    registry.pin_file(&settings_dir(), path)
}

#[tauri::command]
pub fn unpin_file(path: String, registry: State<'_, SharedRegistry>) -> AppResult<Vec<String>> {
    registry.unpin_file(&settings_dir(), &path)
}

#[tauri::command]
pub fn save_theme(theme: String, registry: State<'_, SharedRegistry>) -> AppResult<()> {
    registry.save_with(&settings_dir(), |s| s.theme = Some(theme))
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PreferencesPayload {
    pub zoom: Option<f64>,
    pub content_zoom: Option<f64>,
    pub content_width: Option<String>,
    pub content_font: Option<String>,
    pub sidebar_left_width: Option<u32>,
    pub sidebar_right_width: Option<u32>,
    pub copy_as_markdown: Option<bool>,
    pub sidebar_group_by_repo: Option<bool>,
    pub sidebar_sort_by_modified: Option<bool>,
}

#[tauri::command]
pub fn save_preferences(
    prefs: PreferencesPayload,
    registry: State<'_, SharedRegistry>,
) -> AppResult<()> {
    registry.save_with(&settings_dir(), |s| {
        s.zoom = prefs.zoom;
        s.content_zoom = prefs.content_zoom;
        s.content_width = prefs.content_width;
        s.content_font = prefs.content_font;
        s.sidebar_left_width = prefs.sidebar_left_width;
        s.sidebar_right_width = prefs.sidebar_right_width;
        s.copy_as_markdown = prefs.copy_as_markdown;
        s.sidebar_group_by_repo = prefs.sidebar_group_by_repo;
        s.sidebar_sort_by_modified = prefs.sidebar_sort_by_modified;
    })
}

#[tauri::command]
pub fn load_preferences(registry: State<'_, SharedRegistry>) -> PreferencesPayload {
    let s = registry.settings();
    PreferencesPayload {
        zoom: s.zoom,
        content_zoom: s.content_zoom,
        content_width: s.content_width,
        content_font: s.content_font,
        sidebar_left_width: s.sidebar_left_width,
        sidebar_right_width: s.sidebar_right_width,
        copy_as_markdown: s.copy_as_markdown,
        sidebar_group_by_repo: s.sidebar_group_by_repo,
        sidebar_sort_by_modified: s.sidebar_sort_by_modified,
    }
}

#[tauri::command]
pub fn get_settings_load_status(
    status: State<'_, SettingsLoadStatus>,
) -> SettingsLoadStatus {
    (*status).clone()
}

/// The v2 highlights for one document path (empty when none).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHighlightsResult {
    pub version: u32,
    pub highlights: Vec<Highlight>,
}

/// The v2 highlights for one document path (empty when none). The load
/// (file read + the filtering write-back it may trigger + the directory
/// `fsync`) runs on the blocking pool, not the main thread (see
/// `run_blocking`).
#[tauri::command]
pub async fn get_highlights(path: String) -> AppResult<GetHighlightsResult> {
    run_blocking("get_highlights", move || {
        if !std::path::Path::new(&path).is_absolute() {
            return Err(AppError::Invalid(format!(
                "path must be absolute, got: {path}"
            )));
        }
        let file = HighlightsFile::load(&settings_dir())?;
        let highlights = file.get(&path).to_vec();
        Ok(GetHighlightsResult {
            version: file.version,
            highlights,
        })
    })
    .await
}

/// Replace the highlights for one document path; other paths are untouched.
/// An empty list removes the key. The file itself stores only references
/// (line range + normalized-text window + one-way hash) plus the user's
/// own note — never the selected text. The save (temp write + `sync_all`
/// + rename + directory `fsync`) runs on the blocking pool, not the main
/// thread (see `run_blocking`).
#[tauri::command]
pub async fn save_highlights(path: String, highlights: Vec<Highlight>) -> AppResult<()> {
    run_blocking("save_highlights", move || {
        if !std::path::Path::new(&path).is_absolute() {
            return Err(AppError::Invalid(format!(
                "path must be absolute, got: {path}"
            )));
        }
        if highlights.len() > MAX_HIGHLIGHTS_PER_FILE {
            return Err(AppError::Invalid(format!(
                "at most {MAX_HIGHLIGHTS_PER_FILE} highlights per file, got {}",
                highlights.len()
            )));
        }
        for (i, h) in highlights.iter().enumerate() {
            // Structural validation (id, hash shape, ranges, timestamps).
            // The error names only the category and the entry's position,
            // never its values — they are attacker-controllable strings.
            if let Some(problem) = crate::highlights::entry_problem(h) {
                return Err(AppError::Invalid(format!(
                    "invalid highlight entry #{i}: {problem} (line {}, offset {})",
                    h.anchor.start_line, h.anchor.start_offset
                )));
            }
            if let Some(note) = &h.note {
                if note.chars().count() > MAX_NOTE_CHARS {
                    return Err(AppError::Invalid(format!(
                        "highlight note exceeds {MAX_NOTE_CHARS} characters"
                    )));
                }
            }
        }
        // The read-modify-write is serialized process-wide (see
        // `HighlightsFile::update_path`) so rapid edits from two panes
        // cannot lose each other's update.
        HighlightsFile::update_path(&settings_dir(), path, highlights)
    })
    .await
}

/// The per-installation 128-bit SipHash key as 32 lowercase hex
/// characters. Created on first call at `<settings_dir>/highlights.key`
/// (mode 0600 on Unix); the key never appears in `highlights.json`. The
/// key-file access (including its durability `fsync`s) runs on the
/// blocking pool, not the main thread (see `run_blocking`).
#[tauri::command]
pub async fn get_highlights_key() -> AppResult<String> {
    run_blocking("get_highlights_key", || crate::highlights::get_key(&settings_dir())).await
}

/// Acknowledgement of a close request: the frontend calls this as soon as
/// it receives the `highlights://flush-request` event. It moves the close
/// guard to `Flushing`, which suppresses the 2 s "frontend dead" fallback
/// (it only fires from `FlushRequested`) and starts a 30-second ceiling
/// timer that destroys the window if neither `confirm_close` nor
/// `cancel_close` arrives (the flush can be slow but not forever). A
/// stale or duplicated ack in any other phase is a no-op.
#[tauri::command]
pub fn ack_close_request(app: AppHandle) -> AppResult<()> {
    let Some(guard) = app.try_state::<Arc<crate::CloseGuard>>() else {
        return Ok(());
    };
    let transitioned = {
        let mut phase = guard.phase.lock();
        let next = crate::handle_ack(*phase);
        let t = next != *phase;
        *phase = next;
        t
    };
    if transitioned {
        let guard = Arc::clone(&*guard);
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| AppError::Other(anyhow::anyhow!("no main window")))?
            .clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let destroy = {
                let mut phase = guard.phase.lock();
                let (d, n) = crate::handle_timer(crate::FlushTimer::Ceiling, *phase);
                *phase = n;
                d
            };
            if destroy {
                // A failed destroy must not leave the window trapped in
                // `Closing` (no timer acts from that phase): log the
                // failure without values and let the next close request
                // pass through (`on_destroy_result` moves the phase to
                // `DiscardAllowed`).
                if window.destroy().is_err() {
                    eprintln!("marque: could not destroy the main window (30 s ceiling)");
                    let mut phase = guard.phase.lock();
                    *phase = crate::on_destroy_result(*phase, false);
                }
            }
        });
    }
    Ok(())
}

/// Final word on a close request: the frontend calls this after its
/// highlights flush has landed, which destroys the main window. It is
/// honored only from an in-flight flush (`Flushing`, or a
/// protocol-violating `FlushRequested` where the ack was skipped) — a
/// confirm after a failed (cancelled) flush, or a stray confirm from
/// anywhere else, does not close the window. If the destroy call itself
/// fails, the guard moves to `DiscardAllowed`, so the next close
/// request passes through — a failed destroy must not leave the window
/// uncloseable. It must only be called by our own webview.
#[tauri::command]
pub fn confirm_close(app: AppHandle) -> AppResult<()> {
    let guard = match app.try_state::<Arc<crate::CloseGuard>>() {
        Some(g) => g,
        None => return Ok(()),
    };
    let destroy = {
        let mut phase = guard.phase.lock();
        let (next, d) = crate::handle_confirm(*phase);
        *phase = next;
        d
    };
    if destroy {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        // A failed destroy must not leave the window trapped in
        // `Closing` (no timer acts from that phase): log the failure
        // without values and let the next close request pass through
        // (`on_destroy_result` moves the phase to `DiscardAllowed`).
        if window.destroy().is_err() {
            eprintln!("marque: could not destroy the main window (confirm close)");
            let mut phase = guard.phase.lock();
            *phase = crate::on_destroy_result(*phase, false);
        }
    }
    Ok(())
}

/// Cancel a close request after a failed highlights flush: the window
/// stays open, and the guard moves to `DiscardAllowed`, so the *next*
/// close request closes for real ("close without saving"). A stale cancel
/// outside an in-flight flush cycle is a no-op.
#[tauri::command]
pub fn cancel_close(app: AppHandle) -> AppResult<()> {
    if let Some(guard) = app.try_state::<Arc<crate::CloseGuard>>() {
        let mut phase = guard.phase.lock();
        *phase = crate::handle_cancel(*phase);
    }
    Ok(())
}

/// Re-arm the close guard after new edits were accepted following a
/// cancelled close: the guard moves `DiscardAllowed` → `Idle`, so the
/// next close request intercepts and asks for a flush instead of
/// discarding the new edits without saving. The frontend calls it on the
/// first accepted mutation after a cancelled close; a stale rearm in any
/// other phase is a no-op. Synchronous: no I/O.
#[tauri::command]
pub fn rearm_close_guard(app: AppHandle) -> AppResult<()> {
    if let Some(guard) = app.try_state::<Arc<crate::CloseGuard>>() {
        let mut phase = guard.phase.lock();
        *phase = crate::handle_rearm(*phase);
    }
    Ok(())
}

/// All document paths that currently have at least one highlight, sorted
/// for a stable UI order. The load runs on the blocking pool, not the
/// main thread (see `run_blocking`).
#[tauri::command]
pub async fn list_highlighted_paths() -> AppResult<Vec<String>> {
    run_blocking("list_highlighted_paths", || {
        let mut paths = HighlightsFile::load(&settings_dir())?
            .files
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        paths.sort();
        Ok(paths)
    })
    .await
}

/// Show a file in the system file manager.
///
/// This wraps `tauri-plugin-opener`'s sync Rust API instead of invoking its
/// `reveal_item_in_dir` command from JS: on Linux the plugin blocks on zbus,
/// which spins up its own tokio runtime, and doing that on the thread driving
/// the invoke handler panics with "Cannot start a runtime from within a
/// runtime". A blocking thread has no runtime entered, so the nested
/// `block_on` is safe there.
///
/// Upstream bug: <https://github.com/tauri-apps/plugins-workspace/issues/3552>
/// — once a fixed plugin release ships, this wrapper can be dropped in favor
/// of the plugin's own JS `revealItemInDir` (plus its capability grant).
#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .with_context(|| format!("failed to reveal {path} in the file manager"))
    })
    .await
    .context("reveal task did not complete")??;
    Ok(())
}
