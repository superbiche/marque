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

#[tauri::command]
pub fn get_highlights(path: String) -> AppResult<GetHighlightsResult> {
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
}

/// Replace the highlights for one document path; other paths are untouched.
/// An empty list removes the key. The file itself stores only references
/// (line range + normalized-text window + one-way hash) plus the user's
/// own note — never the selected text.
#[tauri::command]
pub fn save_highlights(path: String, highlights: Vec<Highlight>) -> AppResult<()> {
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
        // Structural validation (id, hash shape, ranges, timestamps). The
        // error names only the category and the entry's position, never
        // its values — they are attacker-controllable strings.
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
    // `HighlightsFile::update_path`) so rapid edits from two panes cannot
    // lose each other's update.
    HighlightsFile::update_path(&settings_dir(), path, highlights)
}

/// The per-installation 128-bit SipHash key as 32 lowercase hex
/// characters. Created on first call at `<settings_dir>/highlights.key`
/// (mode 0600 on Unix); the key never appears in `highlights.json`.
#[tauri::command]
pub fn get_highlights_key() -> AppResult<String> {
    crate::highlights::get_key(&settings_dir())
}

/// Final word on a close request: the frontend calls this after awaiting
/// its highlights flush (see the `highlights://flush-request` event), which
/// destroys the main window. A 2-second Rust-side timer destroys the window
/// if no confirmation arrives, so this command must only be called by our
/// own webview.
#[tauri::command]
pub fn confirm_close(app: AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .destroy()
            .map_err(|e| AppError::Other(anyhow::anyhow!("destroying the main window: {e}")))?;
    }
    Ok(())
}

/// All document paths that currently have at least one highlight, sorted
/// for a stable UI order.
#[tauri::command]
pub fn list_highlighted_paths() -> AppResult<Vec<String>> {
    let mut paths = HighlightsFile::load(&settings_dir())?
        .files
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
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
