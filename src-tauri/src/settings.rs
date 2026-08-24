use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub added_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Saved folder workspaces. `vaults` is accepted as a legacy alias so
    /// settings written by older builds still load.
    #[serde(default, alias = "vaults")]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub last_opened_file: Option<String>,
    #[serde(default)]
    pub recent_files: Vec<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub content_zoom: Option<f64>,
    #[serde(default)]
    pub content_width: Option<String>,
    #[serde(default)]
    pub content_font: Option<String>,
    #[serde(default)]
    pub sidebar_left_width: Option<u32>,
    #[serde(default)]
    pub sidebar_right_width: Option<u32>,
    #[serde(default)]
    pub copy_as_markdown: Option<bool>,
    #[serde(default)]
    pub sidebar_group_by_repo: Option<bool>,
    /// Files pinned to the sidebar, in display order.
    #[serde(default)]
    pub pinned_files: Vec<String>,
}

#[cfg(test)]
const RECENT_LIMIT: usize = 20;
const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize)]
pub struct SettingsLoadStatus {
    pub corrupt_settings_path: Option<String>,
}

pub struct LoadedSettings {
    pub settings: Settings,
    pub status: SettingsLoadStatus,
}

impl Settings {
    pub fn load_with_status(dir: &Path) -> AppResult<LoadedSettings> {
        let p = dir.join(FILE_NAME);
        if !p.exists() {
            return Ok(LoadedSettings {
                settings: Self::default(),
                status: SettingsLoadStatus::default(),
            });
        }
        let raw = std::fs::read_to_string(&p)?;
        match serde_json::from_str(&raw) {
            Ok(settings) => Ok(LoadedSettings {
                settings,
                status: SettingsLoadStatus::default(),
            }),
            Err(error) => {
                let corrupt_path = preserve_corrupt_settings(&p)?;
                eprintln!(
                    "marque: settings file {} was corrupt and was preserved at {}: {error}",
                    p.display(),
                    corrupt_path.display()
                );
                Ok(LoadedSettings {
                    settings: Self::default(),
                    status: SettingsLoadStatus {
                        corrupt_settings_path: Some(corrupt_path.to_string_lossy().into_owned()),
                    },
                })
            }
        }
    }

    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        let p = dir.join(FILE_NAME);
        let tmp = dir.join(format!("{FILE_NAME}.tmp"));
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn push_recent(&mut self, path: String) {
        self.recent_files.retain(|p| p != &path);
        self.recent_files.insert(0, path.clone());
        self.recent_files.truncate(RECENT_LIMIT);
        self.last_opened_file = Some(path);
    }

    pub fn add_folder(&mut self, folder: Folder) {
        if self.folders.iter().any(|v| v.path == folder.path) {
            return;
        }
        self.folders.push(folder);
    }

    pub fn remove_folder(&mut self, id: &str) {
        self.folders.retain(|v| v.id != id);
    }

    pub fn pin_file(&mut self, path: String) {
        if self.pinned_files.contains(&path) {
            return;
        }
        self.pinned_files.push(path);
    }

    pub fn unpin_file(&mut self, path: &str) {
        self.pinned_files.retain(|p| p != path);
    }
}

fn preserve_corrupt_settings(path: &Path) -> AppResult<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut suffix = 0_u32;
    loop {
        let label = if suffix == 0 {
            format!("{FILE_NAME}.corrupt-{timestamp}")
        } else {
            format!("{FILE_NAME}.corrupt-{timestamp}-{suffix}")
        };
        let candidate = path.with_file_name(label);
        if !candidate.exists() {
            std::fs::rename(path, &candidate)?;
            return Ok(candidate);
        }
        suffix += 1;
    }
}

/// Settings directory: `~/.config/marque` (XDG config dir).
pub fn settings_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("marque")
}

/// Legacy settings directory used by the upstream marky builds:
/// `~/.local/share/marky` (XDG data dir).
fn legacy_settings_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("marky")
}

/// One-time first-run migration: if no settings exist at the new location but
/// a legacy marky settings.json does, copy it over. The old file is never
/// deleted. Call before `Settings::load_with_status`.
pub fn migrate_legacy_settings() {
    migrate_legacy_settings_between(&legacy_settings_dir(), &settings_dir());
}

fn migrate_legacy_settings_between(old_dir: &Path, new_dir: &Path) {
    let new_file = new_dir.join(FILE_NAME);
    if new_file.exists() {
        return;
    }
    let old_file = old_dir.join(FILE_NAME);
    if !old_file.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        eprintln!(
            "marque: failed to create settings dir {}: {e}",
            new_dir.display()
        );
        return;
    }
    match std::fs::copy(&old_file, &new_file) {
        Ok(_) => eprintln!(
            "marque: migrated legacy settings from {} to {}",
            old_file.display(),
            new_file.display()
        ),
        Err(e) => eprintln!(
            "marque: failed to migrate legacy settings from {}: {e}",
            old_file.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn folder(id: &str, path: &str) -> Folder {
        Folder {
            id: id.into(),
            name: "x".into(),
            path: path.into(),
            added_at: "now".into(),
        }
    }

    #[test]
    fn round_trip_default() {
        let dir = tempdir().unwrap();
        let s = Settings::default();
        s.save(dir.path()).unwrap();
        let loaded = Settings::load_with_status(dir.path()).unwrap().settings;
        assert!(loaded.folders.is_empty());
        assert!(loaded.recent_files.is_empty());
    }

    #[test]
    fn round_trip_with_data() {
        let dir = tempdir().unwrap();
        let mut s = Settings::default();
        s.add_folder(folder("f1", "/tmp/a"));
        s.push_recent("/tmp/a/file.md".into());
        s.save(dir.path()).unwrap();
        let loaded = Settings::load_with_status(dir.path()).unwrap().settings;
        assert_eq!(loaded.folders.len(), 1);
        assert_eq!(loaded.recent_files, vec!["/tmp/a/file.md"]);
        assert_eq!(loaded.last_opened_file.as_deref(), Some("/tmp/a/file.md"));
    }

    #[test]
    fn add_folder_dedups_by_path() {
        let mut s = Settings::default();
        s.add_folder(folder("f1", "/tmp/a"));
        s.add_folder(folder("f2", "/tmp/a"));
        assert_eq!(s.folders.len(), 1);
        assert_eq!(s.folders[0].id, "f1");
    }

    #[test]
    fn remove_folder_works() {
        let mut s = Settings::default();
        s.add_folder(folder("f1", "/tmp/a"));
        s.add_folder(folder("f2", "/tmp/b"));
        s.remove_folder("f1");
        assert_eq!(s.folders.len(), 1);
        assert_eq!(s.folders[0].id, "f2");
    }

    #[test]
    fn push_recent_dedups_and_caps() {
        let mut s = Settings::default();
        for i in 0..30 {
            s.push_recent(format!("/p/{i}.md"));
        }
        assert_eq!(s.recent_files.len(), RECENT_LIMIT);
        assert_eq!(s.recent_files[0], "/p/29.md");

        s.push_recent("/p/5.md".into());
        assert_eq!(s.recent_files[0], "/p/5.md");
        let occurrences = s.recent_files.iter().filter(|p| *p == "/p/5.md").count();
        assert_eq!(occurrences, 1);
    }

    #[test]
    fn pin_file_dedups_and_keeps_order() {
        let mut s = Settings::default();
        s.pin_file("/tmp/a.md".into());
        s.pin_file("/tmp/b.md".into());
        s.pin_file("/tmp/a.md".into());
        assert_eq!(s.pinned_files, vec!["/tmp/a.md", "/tmp/b.md"]);
    }

    #[test]
    fn unpin_file_removes_entry() {
        let mut s = Settings::default();
        s.pin_file("/tmp/a.md".into());
        s.pin_file("/tmp/b.md".into());
        s.unpin_file("/tmp/a.md");
        assert_eq!(s.pinned_files, vec!["/tmp/b.md"]);
        s.unpin_file("/tmp/missing.md");
        assert_eq!(s.pinned_files, vec!["/tmp/b.md"]);
    }

    #[test]
    fn pinned_files_round_trip() {
        let dir = tempdir().unwrap();
        let mut s = Settings::default();
        s.pin_file("/tmp/a.md".into());
        s.pin_file("/tmp/b.md".into());
        s.save(dir.path()).unwrap();
        let loaded = Settings::load_with_status(dir.path()).unwrap().settings;
        assert_eq!(loaded.pinned_files, vec!["/tmp/a.md", "/tmp/b.md"]);
    }

    #[test]
    fn loads_settings_without_pinned_files() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE_NAME),
            r#"{"zoom":1.1,"sidebar_left_width":240}"#,
        )
        .unwrap();

        let settings = Settings::load_with_status(dir.path()).unwrap().settings;

        assert!(settings.pinned_files.is_empty());
    }

    #[test]
    fn load_missing_file_is_default() {
        let dir = tempdir().unwrap();
        let s = Settings::load_with_status(dir.path()).unwrap().settings;
        assert!(s.folders.is_empty());
    }

    #[test]
    fn load_corrupt_file_is_preserved_before_falling_back_to_default() {
        let dir = tempdir().unwrap();
        let original = "{not json";
        let settings_path = dir.path().join(FILE_NAME);
        std::fs::write(&settings_path, original).unwrap();

        let loaded = Settings::load_with_status(dir.path()).unwrap();

        assert!(loaded.settings.folders.is_empty());
        assert!(!settings_path.exists());
        let preserved = PathBuf::from(loaded.status.corrupt_settings_path.unwrap());
        assert!(preserved
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("settings.json.corrupt-")));
        assert_eq!(std::fs::read_to_string(&preserved).unwrap(), original);

        Settings::default().save(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(preserved).unwrap(), original);
    }

    #[test]
    fn migrates_legacy_settings_when_new_location_empty() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        let new_dir = new.path().join("marque");
        let raw = r#"{"folders":[{"id":"f1","name":"a","path":"/tmp/a","added_at":"0"}]}"#;
        std::fs::write(old.path().join(FILE_NAME), raw).unwrap();

        migrate_legacy_settings_between(old.path(), &new_dir);

        let s = Settings::load_with_status(&new_dir).unwrap().settings;
        assert_eq!(s.folders.len(), 1);
        assert_eq!(s.folders[0].id, "f1");
        // Old file is preserved, never deleted.
        assert!(old.path().join(FILE_NAME).exists());
    }

    #[test]
    fn migration_does_not_overwrite_existing_settings() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        std::fs::write(
            old.path().join(FILE_NAME),
            r#"{"folders":[{"id":"old","name":"o","path":"/tmp/o","added_at":"0"}]}"#,
        )
        .unwrap();
        std::fs::write(
            new.path().join(FILE_NAME),
            r#"{"folders":[{"id":"new","name":"n","path":"/tmp/n","added_at":"0"}]}"#,
        )
        .unwrap();

        migrate_legacy_settings_between(old.path(), new.path());

        let s = Settings::load_with_status(new.path()).unwrap().settings;
        assert_eq!(s.folders.len(), 1);
        assert_eq!(s.folders[0].id, "new");
    }

    #[test]
    fn migration_noop_when_no_legacy_file() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        migrate_legacy_settings_between(old.path(), new.path());
        assert!(!new.path().join(FILE_NAME).exists());
    }

    #[test]
    fn loads_legacy_vaults_alias() {
        let dir = tempdir().unwrap();
        let raw = r#"{"vaults":[{"id":"v1","name":"old","path":"/tmp/x","added_at":"0"}]}"#;
        std::fs::write(dir.path().join("settings.json"), raw).unwrap();
        let s = Settings::load_with_status(dir.path()).unwrap().settings;
        assert_eq!(s.folders.len(), 1);
        assert_eq!(s.folders[0].id, "v1");
    }

    #[test]
    fn loads_settings_without_content_preferences() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE_NAME),
            r#"{"zoom":1.1,"sidebar_left_width":240}"#,
        )
        .unwrap();

        let settings = Settings::load_with_status(dir.path()).unwrap().settings;

        assert_eq!(settings.zoom, Some(1.1));
        assert_eq!(settings.content_zoom, None);
        assert_eq!(settings.content_width, None);
        assert_eq!(settings.content_font, None);
    }
}
