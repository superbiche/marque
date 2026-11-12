//! Highlights persistence.
//!
//! Highlights are keyed by the absolute file path of the markdown document
//! they belong to, in a single JSON file at `<settings_dir>/highlights.json`
//! (next to `settings.json`), so they survive across sessions without any
//! permission outside marque's own config directory.
//!
//! **The file stores references only, never document content.** Each
//! highlight pins its passage with a line range, a character window in the
//! block's normalized text, and a one-way SipHash-2-4 64-bit hash of the
//! normalized passage. The hash is keyed by a per-installation 128-bit key
//! in `<settings_dir>/highlights.key` (created on first use, mode 0600 on
//! Unix) so the same passage hashes differently on each machine; copying
//! `highlights.json` without the key leaves the highlights unresolvable
//! (their notes are kept). The selected text itself is never written; only
//! the user's own `note` is stored.

use crate::error::AppResult;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "highlights.json";
const KEY_NAME: &str = "highlights.key";
pub const CURRENT_VERSION: u32 = 2;

/// A stored window must fit in these bounds; anything else is a corrupt or
/// hand-edited entry and is rejected. The frontend mirrors them in
/// `src/lib/highlights.ts` for early feedback.
pub const MAX_PASSAGE_LENGTH: u32 = 100_000;
pub const MAX_START_OFFSET: u32 = 10_000_000;

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
    /// does not parse as v2 is preserved as
    /// `highlights.json.corrupt-<timestamp>` and never overwritten
    /// silently. Any other shape (including a stray upstream marky v1
    /// file — marky wrote under its own app data directory, so a v1 file
    /// cannot legitimately appear at this path) goes through the same
    /// corrupt-file path.
    ///
    /// Entries that deserialise but fail structural validation (bad id,
    /// hash, range or timestamp — a hand-edited file) are dropped with a
    /// warning that names only the category and the entry's position,
    /// never the value (which may hold anything); the rest of the store is
    /// kept. Warnings never echo `serde_json` error text either, because
    /// it quotes the offending string.
    pub fn load(dir: &Path) -> AppResult<HighlightsFile> {
        let p = dir.join(FILE_NAME);
        if !p.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&p)?;
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(error) => {
                let backup = preserve_corrupt(&p)?;
                eprintln!(
                    "marque: highlights file {} did not parse (line {}, column {}) and was \
                     preserved at {}",
                    p.display(),
                    error.line(),
                    error.column(),
                    backup.display()
                );
                return Ok(Self::default());
            }
        };
        match serde_json::from_value::<HighlightsFile>(value) {
            Ok(mut file) => {
                if file.version != CURRENT_VERSION {
                    let backup = preserve_corrupt(&p)?;
                    eprintln!(
                        "marque: highlights file {} is not a v{CURRENT_VERSION} store and was \
                         preserved at {}",
                        p.display(),
                        backup.display()
                    );
                    return Ok(Self::default());
                }
                let mut invalid = 0;
                file.files.retain(|_path, list| {
                    list.retain(|h| match entry_problem(h) {
                        Some(problem) => {
                            invalid += 1;
                            eprintln!(
                                "marque: highlights: dropped an invalid entry ({problem}) at \
                                 line {}, offset {}",
                                h.anchor.start_line, h.anchor.start_offset
                            );
                            false
                        }
                        None => true,
                    });
                    !list.is_empty()
                });
                Ok(file)
            }
            Err(_) => {
                let backup = preserve_corrupt(&p)?;
                eprintln!(
                    "marque: highlights file {} is not a valid v2 store and was preserved at {}",
                    p.display(),
                    backup.display()
                );
                Ok(Self::default())
            }
        }
    }

    /// Atomic write: serialize to a temp file in the same directory, then
    /// rename over the target.
    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        let _guard = SAVE_LOCK.lock();
        let p = dir.join(FILE_NAME);
        let tmp = dir.join(format!("{FILE_NAME}.tmp.{}", std::process::id()));
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }

    /// Read-modify-write for one document path, serialized across the
    /// process: two concurrent callers (rapid edits, two panes) each do
    /// load → set → save, and without the lock the second save would
    /// clobber the first's update.
    pub fn update_path(dir: &Path, path: String, highlights: Vec<Highlight>) -> AppResult<()> {
        let _guard = RMW_LOCK.lock();
        let mut file = Self::load(dir)?;
        file.set(path, highlights);
        file.save(dir)
    }
}

/// `load`/`save` can be called from concurrent command tasks; the
/// rename-based write is atomic on its own, but the read-modify-write must
/// be serialized so concurrent saves to different paths cannot lose each
/// other. `RMW_LOCK` is held for the whole load → set → save; `SAVE_LOCK`
/// serializes bare `save` calls taken on their own.
static SAVE_LOCK: Mutex<()> = Mutex::new(());
static RMW_LOCK: Mutex<()> = Mutex::new(());

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

/// Serialises the key-file access process-wide: two concurrent first calls
/// (e.g. two panes opening at once) must share one key instead of racing to
/// generate two different ones.
static KEY_LOCK: Mutex<()> = Mutex::new(());

/// The SipHash key for passage hashing: a per-installation random 128-bit
/// key, persisted as 32 lowercase hex characters at
/// `<settings_dir>/highlights.key`. The key never appears in
/// `highlights.json` (references-only rule).
///
/// The key file is created on the first call (temp file + rename, mode
/// 0600 on Unix). A file that is not exactly 32 lowercase hex characters
/// is backed up to `highlights.key.corrupt-<timestamp>` (mode 0600 — it may
/// hold a previously working key, i.e. a secret) and replaced; the
/// warning names the situation only, never the file contents.
pub fn get_key(dir: &Path) -> AppResult<String> {
    let _guard = KEY_LOCK.lock();
    std::fs::create_dir_all(dir)?;
    let path = dir.join(KEY_NAME);
    let existing = std::fs::read_to_string(&path).ok().filter(|k| is_valid_key(k));
    if let Some(key) = existing {
        return Ok(key.trim().to_string());
    }

    // Missing or unreadable/corrupt: preserve what was there, if any.
    let backup = preserve_corrupt_key(&path)?;
    if let Some(backup) = backup {
        eprintln!(
            "marque: highlights key file {} was missing or invalid and was replaced at {}; \
             previously keyed highlights will no longer resolve",
            path.display(),
            backup.display()
        );
    }
    let key = generate_key();
    let tmp = dir.join(format!("{KEY_NAME}.tmp.{}", std::process::id()));
    // Write to a temp file with the final mode before renaming it into
    // place, so the key is never observable with broader permissions.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(key.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, &key)?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(key)
}

/// Exactly 32 lowercase hex characters (surrounding whitespace allowed).
fn is_valid_key(key: &str) -> bool {
    let key = key.trim();
    key.len() == 32 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Generate a random 128-bit key as two v4 UUIDs XOR-mixed with a 7-byte
/// offset. Every output byte combines two independent UUID bytes at
/// different positions (7 is odd, so `(i + 7) % 16 != i` for every
/// `i`), and each v4 UUID byte is uniformly random — v4's fixed
/// version/variant bits only constrain two operand bytes, and each of
/// those is XORed with a fully random byte from the other UUID. So every
/// output bit is uniformly distributed: the full 128 bits, not 122.
fn generate_key() -> String {
    let a = uuid::Uuid::new_v4().into_bytes();
    let b = uuid::Uuid::new_v4().into_bytes();
    (0..16)
        .map(|i| format!("{:02x}", a[i] ^ b[(i + 7) % 16]))
        .collect()
}

/// Back up an existing-but-invalid key file to
/// `highlights.key.corrupt-<timestamp>` (mode 0600 on Unix — it may hold a
/// previously working key, which is a secret). Returns the backup path
/// (or `None` when no file was present, i.e. first run).
fn preserve_corrupt_key(path: &Path) -> AppResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut trial = 0_u32;
    loop {
        let label = if trial == 0 {
            format!("{KEY_NAME}.corrupt-{timestamp}")
        } else {
            format!("{KEY_NAME}.corrupt-{timestamp}-{trial}")
        };
        let candidate = path.with_file_name(label);
        if !candidate.exists() {
            std::fs::rename(path, &candidate)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600));
            }
            return Ok(Some(candidate));
        }
        trial += 1;
    }
}

/// Structural validation for a stored entry. The file is user-mutable
/// (hand-edited, merged across machines), so every entry is checked on
/// load and again on save. Returns a category label only — the message
/// built from it must never echo the entry's values.
pub fn entry_problem(h: &Highlight) -> Option<&'static str> {
    if h.id.parse::<uuid::Uuid>().is_err() {
        return Some("bad id");
    }
    if h.anchor
        .hash
        .len()
        != 16
        || !h.anchor.hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Some("bad hash");
    }
    if h.anchor.start_line >= h.anchor.end_line {
        return Some("inverted line range");
    }
    if h.anchor.length < 1 || h.anchor.length > MAX_PASSAGE_LENGTH {
        return Some("out-of-range length");
    }
    if h.anchor.start_offset > MAX_START_OFFSET {
        return Some("out-of-range offset");
    }
    for ts in [&h.created_at, &h.updated_at] {
        if ts.len() > 40 || !looks_like_rfc3339(ts) {
            return Some("bad timestamp");
        }
    }
    None
}

/// RFC 3339 *shape* check (`YYYY-MM-DDTHH:MM:SS[.frac][Z|±HH:MM]`). Values
/// that parse as the shape but are impossible dates (month 13) are not
/// rejected: the field is a reference, not an assertion, and `toISOString`
/// output always round-trips this shape.
fn looks_like_rfc3339(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 40 {
        return false;
    }
    let d = |i: usize| b[i].is_ascii_digit();
    if !(d(0) && d(1) && d(2) && d(3) && b[4] == b'-' && d(5) && d(6) && b[7] == b'-' && d(8)
        && d(9) && b[10] == b'T' && d(11) && d(12) && b[13] == b':' && d(14) && d(15) && b[16]
        == b':'
        && d(17)
        && d(18))
    {
        return false;
    }
    let rest = &s[19..];
    let zone = if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return false;
        }
        &frac[digits..]
    } else {
        rest
    };
    if zone == "Z" || zone == "z" {
        return true;
    }
    let z = zone.as_bytes();
    z.len() == 6
        && (z[0] == b'+' || z[0] == b'-')
        && z[1].is_ascii_digit()
        && z[2].is_ascii_digit()
        && z[3] == b':'
        && z[4].is_ascii_digit()
        && z[5].is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic valid UUID derived from the label, so entries
    /// survive the load-time validation that requires UUID-shaped ids.
    fn id(label: &str) -> String {
        let n = u32::from_str_radix(label, 16u32).unwrap_or(0);
        format!("00000000-0000-0000-0000-{n:012x}")
    }

    fn h(label: &str, colour: Colour, start_line: u32, end_line: u32) -> Highlight {
        Highlight {
            id: id(label),
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
        assert_eq!(loaded.version, CURRENT_VERSION);
        assert!(loaded.files.is_empty());
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
        let items = loaded.get("/a.md");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, id("1"));
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
        assert!(loaded.files.is_empty());
    }

    #[test]
    fn load_corrupt_file_is_preserved_before_falling_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let original = "{not json";
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, original).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.files.is_empty());
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
        assert!(loaded.files.is_empty());
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
    fn load_v1_file_is_treated_as_corrupt() {
        // A stray upstream marky v1 file (which stores passage text) cannot
        // legitimately appear at this path — marky wrote under its own app
        // data directory — so it goes through the corrupt-file path:
        // preserved, and the store falls back to the empty default.
        let dir = tempfile::tempdir().unwrap();
        let v1 = r#"{"version":1,"files":{"/a.md":[{"id":"1","filePath":"/a.md","colour":"yellow","sourceStartLine":3,"sourceEndLine":5,"passage":"Run npm install","occurrence":0,"section":"Install","createdAt":"2026-04-29T00:00:00.000Z","note":"do it twice"}]}}"#;
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, v1).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.files.is_empty());
        assert!(!path.exists());

        let preserved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("highlights.json.corrupt-"))
            .expect("corrupt backup present");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(preserved)).unwrap(),
            v1
        );
    }

    #[test]
    fn concurrent_update_path_to_different_paths_keeps_both() {
        // save_highlights does load → set → save on the whole file; two
        // concurrent callers writing different paths must not lose each
        // other's update.
        let dir = tempfile::tempdir().unwrap();
        let n = 8;
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let path = dir.path().to_path_buf();
                std::thread::spawn(move || {
                    let id = i;
                    HighlightsFile::update_path(
                        &path,
                        format!("/file-{}.md", id),
                        vec![h(&id.to_string(), Colour::Blue, 0, 1)],
                    )
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(loaded.files.len(), n);
        for i in 0..n {
            let items = loaded.get(&format!("/file-{}.md", i));
            assert_eq!(items.len(), 1, "path for file-{} was lost", i);
            assert_eq!(items[0].id, id(&i.to_string()));
        }
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

    // --- key-file management ---

    #[test]
    fn generated_key_is_32_lowercase_hex() {
        let dir = tempfile::tempdir().unwrap();
        let key = get_key(dir.path()).unwrap();
        assert_eq!(key.len(), 32);
        assert!(key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }

    #[test]
    fn key_is_stable_across_calls() {
        let dir = tempfile::tempdir().unwrap();
        let first = get_key(dir.path()).unwrap();
        let second = get_key(dir.path()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn key_file_is_created_next_to_the_store() {
        let dir = tempfile::tempdir().unwrap();
        get_key(dir.path()).unwrap();
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(entries.contains(&KEY_NAME.to_string()), "{entries:?}");
    }

    #[cfg(unix)]
    #[test]
    fn key_file_mode_is_0600() {
        let dir = tempfile::tempdir().unwrap();
        get_key(dir.path()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(dir.path().join(KEY_NAME)).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn invalid_key_file_is_backed_up_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_NAME);
        std::fs::write(&path, "definitely not a key\n").unwrap();

        let key = get_key(dir.path()).unwrap();
        assert_eq!(key.len(), 32);
        assert!(key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        // The path is recreated with the new key; the old content lives on
        // only in the backup.
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), key);

        let preserved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("highlights.key.corrupt-"))
            .expect("corrupt key backup present");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&preserved)).unwrap(),
            "definitely not a key\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn corrupt_key_backup_is_mode_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_NAME);
        std::fs::write(&path, "zz").unwrap();
        get_key(dir.path()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let backup = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("highlights.key.corrupt-"))
            .unwrap();
        assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn valid_stored_key_is_reused_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_NAME);
        std::fs::write(&path, "0123456789abcdef0123456789abcdef\n").unwrap();
        let key = get_key(dir.path()).unwrap();
        assert_eq!(key, "0123456789abcdef0123456789abcdef");
        assert!(path.exists());
    }

    // --- entry validation (contract hardening) ---

    fn valid_entry() -> Highlight {
        h("1", Colour::Yellow, 0, 1)
    }

    #[test]
    fn entry_validation_accepts_a_well_formed_entry() {
        assert_eq!(entry_problem(&valid_entry()), None);
    }

    #[test]
    fn entry_validation_rejects_each_category() {
        // id
        let mut e = valid_entry();
        e.id = "not-a-uuid".into();
        assert_eq!(entry_problem(&e), Some("bad id"));
        // hash: wrong length
        let mut e = valid_entry();
        e.anchor.hash = "0123456789abcde".into();
        assert_eq!(entry_problem(&e), Some("bad hash"));
        // hash: uppercase
        let mut e = valid_entry();
        e.anchor.hash = "0123456789ABCDEF".into();
        assert_eq!(entry_problem(&e), Some("bad hash"));
        // hash: non-hex
        let mut e = valid_entry();
        e.anchor.hash = "zz23456789abcdef".into();
        assert_eq!(entry_problem(&e), Some("bad hash"));
        // inverted line range (start == end)
        let mut e = valid_entry();
        e.anchor.end_line = 0;
        assert_eq!(entry_problem(&e), Some("inverted line range"));
        // length 0
        let mut e = valid_entry();
        e.anchor.length = 0;
        assert_eq!(entry_problem(&e), Some("out-of-range length"));
        // length above the bound
        let mut e = valid_entry();
        e.anchor.length = MAX_PASSAGE_LENGTH + 1;
        assert_eq!(entry_problem(&e), Some("out-of-range length"));
        // offset above the bound
        let mut e = valid_entry();
        e.anchor.start_offset = MAX_START_OFFSET + 1;
        assert_eq!(entry_problem(&e), Some("out-of-range offset"));
        // timestamp: not RFC 3339 shaped
        let mut e = valid_entry();
        e.created_at = "yesterday".into();
        assert_eq!(entry_problem(&e), Some("bad timestamp"));
        // timestamp: too long
        let mut e = valid_entry();
        e.updated_at = format!("2026-04-29T00:00:00.{}", "0".repeat(40));
        assert_eq!(entry_problem(&e), Some("bad timestamp"));
        // timestamp: missing zone
        let mut e = valid_entry();
        e.created_at = "2026-04-29T00:00:00".into();
        assert_eq!(entry_problem(&e), Some("bad timestamp"));
    }

    #[test]
    fn rfc3339_shape_accepts_iso_and_offset_forms() {
        assert!(looks_like_rfc3339("2026-04-29T00:00:00.000Z"));
        assert!(looks_like_rfc3339("2026-04-29T00:00:00Z"));
        assert!(looks_like_rfc3339("2026-04-29T00:00:00+02:00"));
        assert!(looks_like_rfc3339("2026-04-29T00:00:00.1-05:30"));
        assert!(!looks_like_rfc3339("2026-04-29T00:00:00."));
        assert!(!looks_like_rfc3339("2026-04-29 00:00:00Z"));
    }

    #[test]
    fn load_drops_invalid_entries_and_keeps_valid_ones() {
        let dir = tempfile::tempdir().unwrap();
        let mut bad = h("2", Colour::Blue, 3, 4); // id "2" is a valid UUID; break the hash
        bad.anchor.hash = "nope".into();
        let good = h("3", Colour::Pink, 5, 6);
        let mut file = HighlightsFile::default();
        file.set("/a.md".into(), vec![bad, good]);
        file.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        let items = loaded.get("/a.md");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id("3"));
    }

    #[test]
    fn load_drops_the_path_when_all_entries_are_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let mut bad = h("2", Colour::Blue, 3, 4);
        bad.anchor.hash = "nope".into();
        let mut file = HighlightsFile::default();
        file.set("/a.md".into(), vec![bad]);
        file.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.files.is_empty());
    }

    #[test]
    fn load_rejects_a_store_with_a_wrong_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"version":1,"files":{"/a.md":[{"id":"00000000-0000-0000-0000-000000000001","colour":"yellow","anchor":{"startLine":0,"endLine":1,"startOffset":0,"length":1,"hash":"0123456789abcdef"},"createdAt":"2026-04-29T00:00:00.000Z","updatedAt":"2026-04-29T00:00:00.000Z"}]}}"#,
        )
        .unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.files.is_empty());
        assert!(!path.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.ok()
                .is_some_and(|e| e.file_name().to_string_lossy().starts_with("highlights.json.corrupt-"))
        }));
    }
}
