use crate::cli::InitialTarget;
use crate::error::{AppError, AppResult};
use crate::folder::TreeNode;
use crate::registry::SharedRegistry;
use crate::search::{search, SearchResult};
use crate::settings::{settings_dir, Folder, SettingsLoadStatus};
use crate::watcher::{hydrate_folder, SharedWatchers};
use anyhow::Context as _;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
pub fn read_file(path: String, registry: State<'_, SharedRegistry>) -> AppResult<String> {
    let contents = crate::fs::read_text(&path)?;
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
    }
}

#[tauri::command]
pub fn get_settings_load_status(
    status: State<'_, SettingsLoadStatus>,
) -> SettingsLoadStatus {
    (*status).clone()
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
