use crate::folder::{folder_walk, has_ignored_component};
use crate::registry::SharedRegistry;
use crate::settings::Folder;
use ignore::gitignore::GitignoreBuilder;
use notify_debouncer_full::{
    new_debouncer,
    notify::RecursiveMode,
    DebounceEventResult,
    DebouncedEvent,
    Debouncer,
    RecommendedCache,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const WATCH_LIMIT: usize = 10_000;

#[derive(Clone, Serialize)]
struct WatchLimitPayload<'a> {
    folder_id: &'a str,
    watched: usize,
    limit: usize,
}

pub struct WatcherHandle {
    _inner: Arc<WatcherInner>,
}

struct WatcherInner {
    app: AppHandle,
    registry: SharedRegistry,
    folder_id: String,
    root: PathBuf,
    debouncer: parking_lot::Mutex<Debouncer<notify::RecommendedWatcher, RecommendedCache>>,
    watched: parking_lot::Mutex<WatchedDirectories>,
}

#[derive(Default)]
struct WatchedDirectories {
    paths: HashSet<PathBuf>,
    limit_emitted: bool,
}

/// Create a non-recursive, ignore-aware watcher for one folder. Existing
/// directories are enumerated with the same walker used by tree hydration.
pub fn watch_folder(
    app: AppHandle,
    registry: SharedRegistry,
    folder_id: String,
    root: PathBuf,
) -> anyhow::Result<WatcherHandle> {
    let weak_slot = Arc::new(parking_lot::Mutex::new(Weak::<WatcherInner>::new()));
    let callback_slot = Arc::clone(&weak_slot);
    let debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                if let Some(inner) = callback_slot.lock().upgrade() {
                    inner.handle_events(events);
                }
            }
        },
    )?;

    let inner = Arc::new(WatcherInner {
        app,
        registry,
        folder_id,
        root: root.clone(),
        debouncer: parking_lot::Mutex::new(debouncer),
        watched: parking_lot::Mutex::new(WatchedDirectories::default()),
    });
    *weak_slot.lock() = Arc::downgrade(&inner);

    let (directories, capped) = watch_directories(&root, WATCH_LIMIT);
    inner.add_directories(directories, capped)?;
    Ok(WatcherHandle { _inner: inner })
}

impl WatcherInner {
    fn handle_events(&self, events: Vec<DebouncedEvent>) {
        let relevant_paths: Vec<&Path> = events
            .iter()
            .flat_map(|event| event.paths.iter())
            .filter(|path| !event_path_is_ignored(&self.root, path))
            .map(PathBuf::as_path)
            .collect();
        if relevant_paths.is_empty() {
            return;
        }

        for path in &relevant_paths {
            if path.is_dir() {
                self.watch_new_subtree(path);
            }
        }

        self.registry.refresh_folder(&self.folder_id);
        let _ = self.app.emit("folder://changed", &self.folder_id);

        let paths: Vec<String> = relevant_paths
            .iter()
            .filter(|path| path.is_file())
            .filter_map(|path| path.to_str().map(String::from))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !paths.is_empty() {
            let _ = self.app.emit("file://changed", &paths);
        }
    }

    fn watch_new_subtree(&self, root: &Path) {
        let remaining = WATCH_LIMIT.saturating_sub(self.watched.lock().paths.len());
        if remaining == 0 {
            self.emit_limit_if_needed();
            return;
        }
        let (directories, capped) = watch_directories(root, remaining);
        if let Err(error) = self.add_directories(directories, capped) {
            eprintln!(
                "marque: failed to add watcher for {}: {error}",
                root.display()
            );
        }
    }

    fn add_directories(&self, directories: Vec<PathBuf>, source_was_capped: bool) -> notify::Result<()> {
        let mut hit_limit = source_was_capped;
        {
            let mut watched = self.watched.lock();
            for directory in directories {
                if watched.paths.contains(&directory) {
                    continue;
                }
                if watched.paths.len() == WATCH_LIMIT {
                    hit_limit = true;
                    break;
                }
                self.debouncer
                    .lock()
                    .watch(&directory, RecursiveMode::NonRecursive)?;
                watched.paths.insert(directory);
            }
        }
        if hit_limit {
            self.emit_limit_if_needed();
        }
        Ok(())
    }

    fn emit_limit_if_needed(&self) {
        let watched = {
            let mut state = self.watched.lock();
            if state.paths.len() < WATCH_LIMIT || state.limit_emitted {
                return;
            }
            state.limit_emitted = true;
            state.paths.len()
        };
        let payload = WatchLimitPayload {
            folder_id: &self.folder_id,
            watched,
            limit: WATCH_LIMIT,
        };
        let _ = self.app.emit("folder://watch-limit", payload);
    }
}

/// Start background hydration for all registered folders. It deliberately runs
/// after Tauri state has been managed, keeping setup free of tree walks and
/// watcher installation.
pub fn hydrate_folders(app: AppHandle, registry: SharedRegistry, watchers: SharedWatchers) {
    std::thread::spawn(move || {
        for folder in registry.folders() {
            hydrate_folder_sync(&app, &registry, &watchers, folder);
        }
    });
}

/// Schedule a newly-added folder through the same background path used at
/// startup. Existing folders are not rehydrated or given duplicate watchers.
pub fn hydrate_folder(app: AppHandle, registry: SharedRegistry, watchers: SharedWatchers, folder: Folder) {
    std::thread::spawn(move || hydrate_folder_sync(&app, &registry, &watchers, folder));
}

fn hydrate_folder_sync(
    app: &AppHandle,
    registry: &SharedRegistry,
    watchers: &SharedWatchers,
    folder: Folder,
) {
    registry.refresh_folder(&folder.id);
    if !registry.contains_folder(&folder.id) {
        return;
    }
    match watch_folder(
        app.clone(),
        Arc::clone(registry),
        folder.id.clone(),
        PathBuf::from(&folder.path),
    ) {
        Ok(handle) => watchers.insert(folder.id.clone(), handle),
        Err(error) => eprintln!(
            "marque: failed to watch folder {}: {error}",
            folder.path
        ),
    }
    let _ = app.emit("folder://changed", &folder.id);
}

/// Enumerate directory watches with the tree's full ignore policy. `capped`
/// indicates that at least one otherwise eligible directory exceeded `limit`.
fn watch_directories(root: &Path, limit: usize) -> (Vec<PathBuf>, bool) {
    let mut directories = Vec::new();
    for entry in folder_walk(root).flatten() {
        if !entry.file_type().is_some_and(|file_type| file_type.is_dir()) {
            continue;
        }
        if directories.len() == limit {
            return (directories, true);
        }
        directories.push(entry.into_path());
    }
    (directories, false)
}

fn event_path_is_ignored(root: &Path, path: &Path) -> bool {
    if is_ignore_control_file(path) {
        return false;
    }
    has_ignored_component(root, path) || path_is_gitignored(path, path.is_dir())
}

fn is_ignore_control_file(path: &Path) -> bool {
    matches!(path.file_name().and_then(|name| name.to_str()), Some(".gitignore" | ".ignore"))
}

/// Check `.gitignore` files on the ancestor chain without walking the whole
/// folder on every watcher event. The initial and subtree enumerations remain
/// authoritative because they use `WalkBuilder` directly.
fn path_is_gitignored(path: &Path, is_dir: bool) -> bool {
    let mut ancestor = path.parent();
    let mut matchers = Vec::new();
    let mut found_git_root = false;

    while let Some(directory) = ancestor {
        let ignore_file = directory.join(".gitignore");
        if ignore_file.is_file() {
            let mut builder = GitignoreBuilder::new(directory);
            let _ = builder.add(&ignore_file);
            if let Ok(matcher) = builder.build() {
                matchers.push(matcher);
            }
        }
        if directory.join(".git").exists() {
            found_git_root = true;
            break;
        }
        ancestor = directory.parent();
    }

    if !found_git_root {
        return false;
    }
    for matcher in matchers {
        let matched = matcher.matched_path_or_any_parents(path, is_dir);
        if matched.is_ignore() {
            return true;
        }
        if matched.is_whitelist() {
            return false;
        }
    }
    false
}

/// Lifetime holder for active watchers, keyed by folder id.
#[derive(Default)]
pub struct Watchers {
    inner: parking_lot::Mutex<HashMap<String, WatcherHandle>>,
}

impl Watchers {
    pub fn insert(&self, id: String, handle: WatcherHandle) {
        self.inner.lock().insert(id, handle);
    }

    pub fn remove(&self, id: &str) {
        self.inner.lock().remove(id);
    }
}

pub type SharedWatchers = Arc<Watchers>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn watch_directories_respects_ignores_and_cap() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir_all(dir.path().join("included/nested")).unwrap();
        fs::create_dir_all(dir.path().join("ignored/nested")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/nested")).unwrap();
        fs::create_dir_all(dir.path().join(".hidden/nested")).unwrap();

        let (directories, capped) = watch_directories(dir.path(), 2);
        assert_eq!(directories.len(), 2);
        assert!(capped);
        assert!(directories.iter().all(|path| {
            !path.components().any(|component| {
                matches!(component.as_os_str().to_str(), Some("ignored" | "node_modules" | ".hidden"))
            })
        }));

        let (directories, capped) = watch_directories(dir.path(), WATCH_LIMIT);
        assert!(!capped);
        assert!(directories.iter().any(|path| path.ends_with("included/nested")));
        assert!(!directories.iter().any(|path| path.ends_with("ignored")));
    }

    #[test]
    fn event_filter_skips_ignored_components_and_gitignored_paths() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "generated/\n").unwrap();
        fs::create_dir_all(dir.path().join("generated")).unwrap();

        assert!(event_path_is_ignored(dir.path(), &dir.path().join(".git/config")));
        assert!(event_path_is_ignored(dir.path(), &dir.path().join("generated/output.md")));
        assert!(!event_path_is_ignored(dir.path(), &dir.path().join("docs/readme.md")));
        assert!(!event_path_is_ignored(dir.path(), &dir.path().join(".gitignore")));
    }
}
