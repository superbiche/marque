use crate::error::{AppError, AppResult};
use crate::folder::{build_tree, flatten_files, IndexedFile, TreeNode};
use crate::settings::{Folder, Settings};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// In-memory registry: persisted folder metadata plus hydrated trees and a
/// per-folder search-index slice. Folders begin unhydrated so setup can return
/// without walking their contents.
pub struct FolderRegistry {
    inner: RwLock<Inner>,
    recents: Mutex<RecentFiles>,
    save_lock: Mutex<()>,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    trees: HashMap<String, TreeNode>,
    index_by_folder: HashMap<String, Arc<Vec<IndexedFile>>>,
}

#[derive(Default, Clone)]
struct RecentFiles {
    last_opened_file: Option<String>,
    files: Vec<String>,
}

impl RecentFiles {
    fn from_settings(settings: &Settings) -> Self {
        Self {
            last_opened_file: settings.last_opened_file.clone(),
            files: settings.recent_files.clone(),
        }
    }

    fn apply_to(&self, settings: &mut Settings) {
        settings.last_opened_file = self.last_opened_file.clone();
        settings.recent_files = self.files.clone();
    }

    fn push(&mut self, path: String) {
        self.files.retain(|existing| existing != &path);
        self.files.insert(0, path.clone());
        self.files.truncate(20);
        self.last_opened_file = Some(path);
    }
}

impl FolderRegistry {
    /// Construct metadata-only state. Hydration is explicitly scheduled by
    /// the application after managed state is available.
    pub fn from_settings(settings: Settings) -> Self {
        let recents = RecentFiles::from_settings(&settings);
        Self {
            inner: RwLock::new(Inner {
                settings,
                ..Default::default()
            }),
            recents: Mutex::new(recents),
            save_lock: Mutex::new(()),
        }
    }

    pub fn settings(&self) -> Settings {
        let mut settings = self.inner.read().settings.clone();
        self.recents.lock().apply_to(&mut settings);
        settings
    }

    pub fn folders(&self) -> Vec<Folder> {
        self.inner.read().settings.folders.clone()
    }

    pub fn contains_folder(&self, folder_id: &str) -> bool {
        self.inner
            .read()
            .settings
            .folders
            .iter()
            .any(|folder| folder.id == folder_id)
    }

    pub fn tree_or_empty(&self, folder_id: &str) -> Option<TreeNode> {
        let inner = self.inner.read();
        if let Some(tree) = inner.trees.get(folder_id) {
            return Some(tree.clone());
        }
        inner
            .settings
            .folders
            .iter()
            .find(|folder| folder.id == folder_id)
            .map(empty_tree)
    }

    pub fn index_snapshot(&self) -> Vec<Arc<Vec<IndexedFile>>> {
        let inner = self.inner.read();
        inner
            .settings
            .folders
            .iter()
            .filter_map(|folder| inner.index_by_folder.get(&folder.id).cloned())
            .collect()
    }

    #[cfg(test)]
    pub fn add_folder(&self, path: PathBuf) -> AppResult<Folder> {
        self.add_folder_with_status(path).map(|(folder, _)| folder)
    }

    /// Register a folder without walking it. The boolean is true only when
    /// the folder was newly added and therefore needs hydration scheduled.
    pub fn add_folder_with_status(&self, path: PathBuf) -> AppResult<(Folder, bool)> {
        let abs = std::fs::canonicalize(&path)?;
        if !abs.is_dir() {
            return Err(AppError::Invalid("folder path is not a directory".into()));
        }
        let path_str = abs.to_str().ok_or(AppError::NonUtf8Path)?.to_string();
        let name = abs
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("folder")
            .to_string();

        let mut inner = self.inner.write();
        if let Some(existing) = inner
            .settings
            .folders
            .iter()
            .find(|folder| folder.path == path_str)
        {
            return Ok((existing.clone(), false));
        }

        let folder = Folder {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: path_str,
            added_at: chrono_now(),
        };
        inner.settings.add_folder(folder.clone());
        Ok((folder, true))
    }

    pub fn remove_folder(&self, id: &str) {
        let mut inner = self.inner.write();
        inner.settings.remove_folder(id);
        inner.trees.remove(id);
        inner.index_by_folder.remove(id);
    }

    /// Rebuild one folder without holding the registry write lock during the
    /// filesystem walk. The final swap updates only that folder's index slice.
    pub fn refresh_folder(&self, id: &str) {
        let Some(folder) = self.folder(id) else {
            return;
        };
        let root = PathBuf::from(&folder.path);
        let rebuilt = build_tree(&root).map(|tree| {
            let mut index = Vec::new();
            flatten_files(&folder.id, &folder.name, &root, &tree, &mut index);
            (tree, index)
        });

        let mut inner = self.inner.write();
        if !inner.settings.folders.iter().any(|current| current.id == folder.id) {
            return;
        }
        match rebuilt {
            Ok((tree, index)) => {
                inner.trees.insert(folder.id.clone(), tree);
                inner.index_by_folder.insert(folder.id, Arc::new(index));
            }
            Err(_) => {
                inner.trees.remove(&folder.id);
                inner.index_by_folder.remove(&folder.id);
            }
        }
    }

    pub fn push_recent(&self, path: String) {
        self.recents.lock().push(path);
    }

    /// Persist recents off the command path. This only takes the separate
    /// recents lock before spawning, so opening a document never queues behind
    /// a tree rebuild's registry write lock.
    pub fn persist_async(self: &Arc<Self>, dir: PathBuf) {
        let registry = Arc::clone(self);
        std::thread::spawn(move || {
            if let Err(error) = registry.save(&dir) {
                eprintln!("marque: failed to save recent files: {error}");
            }
        });
    }

    pub fn save(&self, dir: &Path) -> AppResult<()> {
        let _save = self.save_lock.lock();
        self.snapshot_settings().save(dir)
    }

    pub fn save_with(
        &self,
        dir: &Path,
        mutate: impl FnOnce(&mut Settings),
    ) -> AppResult<()> {
        mutate(&mut self.inner.write().settings);
        self.save(dir)
    }

    fn folder(&self, id: &str) -> Option<Folder> {
        self.inner
            .read()
            .settings
            .folders
            .iter()
            .find(|folder| folder.id == id)
            .cloned()
    }

    fn snapshot_settings(&self) -> Settings {
        let mut settings = self.inner.read().settings.clone();
        self.recents.lock().apply_to(&mut settings);
        settings
    }
}

fn empty_tree(folder: &Folder) -> TreeNode {
    TreeNode {
        name: folder.name.clone(),
        path: folder.path.clone(),
        is_dir: true,
        children: Vec::new(),
    }
}

pub type SharedRegistry = Arc<FolderRegistry>;

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn saved_folders_start_unhydrated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();
        let settings = Settings {
            folders: vec![Folder {
                id: "f1".into(),
                name: "folder".into(),
                path: dir.path().to_string_lossy().into_owned(),
                added_at: "now".into(),
            }],
            ..Default::default()
        };

        let registry = FolderRegistry::from_settings(settings);
        assert!(registry.index_snapshot().is_empty());
        assert_eq!(registry.tree_or_empty("f1").unwrap().children.len(), 0);
        assert!(registry.tree_or_empty("missing").is_none());
    }

    #[test]
    fn add_folder_requires_explicit_hydration() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();

        let registry = FolderRegistry::from_settings(Settings::default());
        let folder = registry.add_folder(dir.path().to_path_buf()).unwrap();
        assert!(registry.index_snapshot().is_empty());
        registry.refresh_folder(&folder.id);
        assert_eq!(registry.index_snapshot().len(), 1);
    }

    #[test]
    fn remove_folder_drops_index_entries() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();
        let registry = FolderRegistry::from_settings(Settings::default());
        let folder = registry.add_folder(dir.path().to_path_buf()).unwrap();
        registry.refresh_folder(&folder.id);
        assert!(!registry.index_snapshot().is_empty());
        registry.remove_folder(&folder.id);
        assert!(registry.index_snapshot().is_empty());
        assert!(registry.tree_or_empty(&folder.id).is_none());
    }

    #[test]
    fn add_same_folder_twice_dedups() {
        let dir = tempdir().unwrap();
        let registry = FolderRegistry::from_settings(Settings::default());
        let first = registry.add_folder(dir.path().to_path_buf()).unwrap();
        let second = registry.add_folder(dir.path().to_path_buf()).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(registry.folders().len(), 1);
    }

    #[test]
    fn refresh_replaces_only_the_changed_folder_index_slice() {
        let first_dir = tempdir().unwrap();
        let second_dir = tempdir().unwrap();
        fs::write(first_dir.path().join("a.md"), "x").unwrap();
        fs::write(second_dir.path().join("b.md"), "y").unwrap();

        let registry = FolderRegistry::from_settings(Settings::default());
        let first = registry.add_folder(first_dir.path().to_path_buf()).unwrap();
        let second = registry.add_folder(second_dir.path().to_path_buf()).unwrap();
        registry.refresh_folder(&first.id);
        registry.refresh_folder(&second.id);
        fs::write(first_dir.path().join("new.md"), "z").unwrap();
        registry.refresh_folder(&first.id);

        let inner = registry.inner.read();
        assert_eq!(inner.index_by_folder[&first.id].len(), 2);
        assert_eq!(inner.index_by_folder[&second.id].len(), 1);
        assert_eq!(
            inner.index_by_folder[&second.id][0].relative_path,
            "b.md"
        );
    }
}
