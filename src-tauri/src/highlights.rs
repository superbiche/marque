//! Highlights persistence.
//!
//! Highlights are keyed by the absolute file path of the markdown document
//! they belong to, in a single JSON file at `<settings_dir>/highlights.json`
//! (next to `settings.json`), so they survive across sessions without any
//! permission outside marque's own config directory.
//!
//! **The file stores references only, never document content.** Each
//! highlight pins its passage with a line range, a character window in the
//! block's normalized text, and a one-way 64-bit hash of the normalized
//! passage. The selected text itself is never written; only the user's own
//! `note` is stored.

use crate::error::AppResult;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "highlights.json";
pub const CURRENT_VERSION: u32 = 2;

/// Serialised as a plain word ("yellow", …). An unknown value makes the
/// whole file fail to parse, which routes it through the corrupt-file
/// backup path — data is preserved, never re-saved from an unknown shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Colour {
    Yellow,
    Orange,
    Pink,
    Blue,
    Purple,
}

/// Where a passage sits: inside the block identified by the line range, at
/// `start_offset` for `length` characters of the block's normalized text,
/// checked by `hash` (one-way; the text itself is not stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub start_line: u32,
    pub end_line: u32,
    pub start_offset: u32,
    pub length: u32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub colour: Colour,
    pub anchor: Anchor,
    /// Optional per-item annotation — the only user text stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightsFile {
    pub version: u32,
    pub files: HashMap<String, Vec<Highlight>>,
}

impl Default for HighlightsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            files: HashMap::new(),
        }
    }
}

impl HighlightsFile {
    /// Get the highlights for one document path (empty slice when absent).
    pub fn get(&self, path: &str) -> &[Highlight] {
        self.files
            .get(path)
            .map(|items| items.as_slice())
            .unwrap_or(&[])
    }

    /// Replace the list for one path; an empty list removes the key (this
    /// is how a file's highlights are cleared — the frontend sends the full
    /// list, so there is no separate delete path).
    pub fn set(&mut self, path: String, highlights: Vec<Highlight>) {
        if highlights.is_empty() {
            self.files.remove(&path);
        } else {
            self.files.insert(path, highlights);
        }
    }

    /// Load the v2 store. A missing file yields the default; a file that
    /// does not parse (or fails to deserialize) is preserved as
    /// `highlights.json.corrupt-<timestamp>` and never overwritten
    /// silently. A legacy v1 file (upstream marky shape, which stores
    /// passage text) is parsed and returned so the frontend can migrate it
    /// (hashing the passages and discarding the text); it is left untouched
    /// until the first save, which replaces it — no v1 text survives on disk
    /// after that save (per the reference-only rule).
    pub fn load(dir: &Path) -> AppResult<LoadedHighlights> {
        let p = dir.join(FILE_NAME);
        if !p.exists() {
            return Ok(LoadedHighlights::default());
        }
        let raw = std::fs::read_to_string(&p)?;
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(error) => {
                let backup = preserve_corrupt(&p)?;
                eprintln!(
                    "marque: highlights file {} did not parse and was preserved at {}: {error}",
                    p.display(),
                    backup.display()
                );
                return Ok(LoadedHighlights::default());
            }
        };
        if value.get("version").and_then(|v| v.as_u64()) == Some(1) {
            match serde_json::from_value::<LegacyHighlightsFile>(value) {
                Ok(legacy) => {
                    eprintln!(
                        "marque: highlights file {} is legacy v1 (stores passage text); its \
                         entries are migrated by the frontend and the file is rewritten as \
                         v2 on the next save",
                        p.display()
                    );
                    Ok(LoadedHighlights {
                        file: Self::default(),
                        legacy: Some(legacy),
                    })
                }
                Err(error) => {
                    let backup = preserve_corrupt(&p)?;
                    eprintln!(
                        "marque: highlights file {} could not be read as legacy v1 and was \
                         preserved at {}: {error}",
                        p.display(),
                        backup.display()
                    );
                    Ok(LoadedHighlights::default())
                }
            }
        } else {
            match serde_json::from_value::<HighlightsFile>(value) {
                Ok(file) => Ok(LoadedHighlights {
                    file,
                    legacy: None,
                }),
                Err(error) => {
                    let backup = preserve_corrupt(&p)?;
                    eprintln!(
                        "marque: highlights file {} failed to deserialize and was preserved \
                         at {}: {error}",
                        p.display(),
                        backup.display()
                    );
                    Ok(LoadedHighlights::default())
                }
            }
        }
    }

    /// Atomic write: serialize to a temp file in the same directory, then
    /// rename over the target. A legacy v1 file still on disk (upstream
    /// marky's shape, which stores passage text) is simply replaced: the
    /// v2 file carries references only, so no v1 passage text survives on
    /// disk after this save (the reference-only rule). The user's original
    /// marky data, if any, is untouched in marky's own data directory.
    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        let _guard = SAVE_LOCK.lock();
        let p = dir.join(FILE_NAME);
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if v.get("version").and_then(|v| v.as_u64()) == Some(1) {
                    eprintln!(
                        "marque: replaced legacy v1 highlights file {} with v2 (references \
                         only; no v1 passage text is retained on disk)",
                        p.display()
                    );
                }
            }
        }
        let tmp = dir.join(format!("{FILE_NAME}.tmp.{}", std::process::id()));
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }
}

/// Result of [`HighlightsFile::load`].
#[derive(Debug, Clone, Default)]
pub struct LoadedHighlights {
    pub file: HighlightsFile,
    /// Parsed v1 content when the on-disk file predates the v2 model.
    pub legacy: Option<LegacyHighlightsFile>,
}

/// Upstream marky v1 shape. The camelCase derive reproduces the exact
/// upstream field names (`filePath`, `sourceStartLine`, …). Deserialized to
/// hand the content to the frontend for migration (the passage hash needs
/// the JS-side NFC normalization, unavailable in Rust without a new
/// dependency) and re-serialized unchanged in the `get_highlights` payload
/// so the frontend can migrate it and save it back as v2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHighlight {
    pub id: String,
    pub file_path: String,
    pub colour: String,
    pub source_start_line: u32,
    pub source_end_line: u32,
    pub passage: String,
    #[serde(default)]
    pub occurrence: u32,
    #[serde(default)]
    pub section: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyHighlightsFile {
    pub version: u32,
    pub files: HashMap<String, Vec<LegacyHighlight>>,
}

/// `load`/`save` can be called from concurrent command tasks; the
/// rename-based write is atomic on its own, but the replace-legacy check
/// must not race with itself, so all writes are serialized.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn preserve_corrupt(path: &Path) -> AppResult<PathBuf> {
    preserve_with_suffix(path, "corrupt")
}

fn preserve_with_suffix(path: &Path, suffix: &str) -> AppResult<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut trial = 0_u32;
    loop {
        let label = if trial == 0 {
            format!("{FILE_NAME}.{suffix}-{timestamp}")
        } else {
            format!("{FILE_NAME}.{suffix}-{timestamp}-{trial}")
        };
        let candidate = path.with_file_name(label);
        if !candidate.exists() {
            std::fs::rename(path, &candidate)?;
            return Ok(candidate);
        }
        trial += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(id: &str, colour: Colour, start_line: u32, end_line: u32) -> Highlight {
        Highlight {
            id: id.into(),
            colour,
            anchor: Anchor {
                start_line,
                end_line,
                start_offset: 4,
                length: 11,
                hash: "0123456789abcdef".into(),
            },
            note: None,
            created_at: "2026-04-29T00:00:00.000Z".into(),
            updated_at: "2026-04-29T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn round_trip_default() {
        let dir = tempfile::tempdir().unwrap();
        let f = HighlightsFile::default();
        f.save(dir.path()).unwrap();
        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(loaded.file.version, CURRENT_VERSION);
        assert!(loaded.file.files.is_empty());
        assert!(loaded.legacy.is_none());
    }

    #[test]
    fn round_trip_with_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        f.set(
            "/a.md".into(),
            vec![
                h("1", Colour::Yellow, 0, 1),
                h("2", Colour::Blue, 3, 4),
            ],
        );
        f.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        let items = loaded.file.get("/a.md");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "1");
        assert_eq!(items[0].colour, Colour::Yellow);
        assert_eq!(items[0].anchor.start_line, 0);
        assert_eq!(items[1].colour, Colour::Blue);
    }

    #[test]
    fn camelcase_field_names_in_json() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        let mut item = h("1", Colour::Yellow, 0, 1);
        item.note = Some("needs a primary source".into());
        f.set("/a.md".into(), vec![item]);
        f.save(dir.path()).unwrap();

        let raw = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(raw.contains("\"startLine\""));
        assert!(raw.contains("\"endLine\""));
        assert!(raw.contains("\"startOffset\""));
        assert!(raw.contains("\"createdAt\""));
        assert!(raw.contains("\"updatedAt\""));
        assert!(raw.contains("\"note\""));
    }

    #[test]
    fn omits_note_field_in_json_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        f.set("/a.md".into(), vec![h("1", Colour::Yellow, 0, 1)]);
        f.save(dir.path()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(!raw.contains("\"note\""));
    }

    #[test]
    fn load_missing_file_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.file.files.is_empty());
        assert!(loaded.legacy.is_none());
    }

    #[test]
    fn load_corrupt_file_is_preserved_before_falling_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let original = "{not json";
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, original).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.file.files.is_empty());
        assert!(loaded.legacy.is_none());
        assert!(!path.exists());

        let preserved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("highlights.json.corrupt-"));
        let preserved = preserved.expect("corrupt backup present");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&preserved)).unwrap(),
            original
        );
    }

    #[test]
    fn unknown_colour_is_treated_as_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"version":2,"files":{"/a.md":[{"id":"1","colour":"green","anchor":{"startLine":0,"endLine":1,"startOffset":0,"length":1,"hash":"x"},"createdAt":"t","updatedAt":"t"}]}}"#,
        )
        .unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.file.files.is_empty());
        assert!(!path.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.ok()
                .is_some_and(|e| e.file_name().to_string_lossy().starts_with("highlights.json.corrupt-"))
        }));
    }

    #[test]
    fn atomic_save_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        f.set("/a.md".into(), vec![h("1", Colour::Yellow, 0, 1)]);
        f.save(dir.path()).unwrap();

        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["highlights.json".to_string()]);
    }

    #[test]
    fn serialized_file_never_contains_the_passage() {
        // The only way an anchor comes into existence is from a passage;
        // build one the way the app does (reference + one-way hash, no
        // text) and prove the on-disk JSON carries none of it.
        let passage = "the quick brown fox jumps over the lazy dog";
        let note = "check the wording here";
        let item = Highlight {
            id: "id-1".into(),
            colour: Colour::Pink,
            anchor: Anchor {
                start_line: 10,
                end_line: 11,
                start_offset: 0,
                length: passage.len() as u32,
                // one-way reference; the value itself is irrelevant here
                hash: "deadbeef01234567".into(),
            },
            note: Some(note.into()),
            created_at: "2026-04-29T00:00:00.000Z".into(),
            updated_at: "2026-04-29T00:00:00.000Z".into(),
        };
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        f.set("/a.md".into(), vec![item]);
        f.save(dir.path()).unwrap();

        let raw = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(!raw.contains(passage));
        assert!(!raw.contains("quick brown fox"));
        assert!(raw.contains(note));
    }

    #[test]
    fn load_legacy_v1_returns_it_for_migration() {
        let dir = tempfile::tempdir().unwrap();
        let v1 = r#"{"version":1,"files":{"/a.md":[{"id":"1","filePath":"/a.md","colour":"yellow","sourceStartLine":3,"sourceEndLine":5,"passage":"Run npm install","occurrence":0,"section":"Install","createdAt":"2026-04-29T00:00:00.000Z","note":"do it twice"}]}}"#;
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, v1).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.file.files.is_empty());
        let legacy = loaded.legacy.expect("v1 parsed");
        let items = legacy.files.get("/a.md").unwrap();
        assert_eq!(items[0].passage, "Run npm install");
        assert_eq!(items[0].note.as_deref(), Some("do it twice"));
        // The file on disk is untouched by the load.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), v1);
    }

    #[test]
    fn saving_replaces_legacy_v1_and_keeps_no_backup() {
        // The reference-only rule: no v1 passage text may survive on disk
        // after the first save, so the replacement must not preserve a copy.
        let dir = tempfile::tempdir().unwrap();
        let v1 = r#"{"version":1,"files":{"/a.md":[{"id":"1","filePath":"/a.md","colour":"yellow","sourceStartLine":0,"sourceEndLine":1,"passage":"some text","occurrence":0,"section":"","createdAt":"t"}]}}"#;
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, v1).unwrap();

        let mut f = HighlightsFile::default();
        f.set("/a.md".into(), vec![h("1", Colour::Yellow, 0, 1)]);
        f.save(dir.path()).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"version\": 2"));
        assert!(!raw.contains("some text"));
        // Only the v2 file remains — no legacy-v1 backup was written.
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["highlights.json".to_string()]);
    }

    #[test]
    fn set_with_empty_list_removes_the_key() {
        let mut f = HighlightsFile::default();
        f.set("/a.md".into(), vec![h("1", Colour::Yellow, 0, 1)]);
        assert_eq!(f.files.len(), 1);
        // Clearing a file's highlights is just setting an empty list.
        f.set("/a.md".into(), vec![]);
        assert!(f.files.is_empty());
    }

    #[test]
    fn legacy_serialization_uses_upstream_field_names() {
        let mut legacy = LegacyHighlightsFile {
            version: 1,
            files: HashMap::new(),
        };
        legacy.files.insert(
            "/a.md".into(),
            vec![LegacyHighlight {
                id: "1".into(),
                file_path: "/a.md".into(),
                colour: "yellow".into(),
                source_start_line: 3,
                source_end_line: 5,
                passage: "Run npm install".into(),
                occurrence: 0,
                section: "Install".into(),
                created_at: "2026-04-29T00:00:00.000Z".into(),
                note: Some("twice".into()),
            }],
        );
        let raw = serde_json::to_string(&legacy).unwrap();
        assert!(raw.contains("\"filePath\""));
        assert!(raw.contains("\"sourceStartLine\""));
        assert!(raw.contains("\"sourceEndLine\""));
        assert!(raw.contains("\"passage\""));
        assert!(raw.contains("\"occurrence\""));
        assert!(raw.contains("\"createdAt\""));
        // Round-trips through our own serialization.
        let back: LegacyHighlightsFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            back.files.get("/a.md").unwrap()[0].passage,
            "Run npm install"
        );
    }
}
