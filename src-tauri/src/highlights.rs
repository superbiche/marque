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
//! (they are listed as not found; their notes are kept). The selected text
//! itself is never written; only the user's own `note` is stored.
//!
//! **Load-time filtering (F10):** every stored entry must pass the same
//! checks `save_highlights` enforces (plus the note-length cap); each path
//! is capped at `MAX_HIGHLIGHTS_PER_FILE` entries; non-absolute path keys
//! are dropped. When anything is dropped the *original* file is first
//! *copied* (never renamed) to `highlights.json.invalid-<timestamp>`
//! (0600 on Unix) so a later save cannot destroy the user's data, and the
//! *filtered* store is written back over the live file — but only when the
//! filtering changed it — so the next load is clean.
//!
//! **Read safety:** a load takes `RMW_LOCK` (the same lock a save's
//! read-modify-write holds) and a clean store is never rewritten, so a read
//! can never interleave with a save or clobber one that just landed.
//!
//! **Key handling (S3):** an existing valid key file is tightened to 0600
//! before use (a failed tightening is a hard error — the key is not used);
//! its temp file is removed if stale and created fresh (0600,
//! fail-if-exists); every corrupt/invalid backup is 0600 on Unix.

use crate::error::AppResult;
use anyhow::Context;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
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
/// A path holds at most this many highlights; `load` drops what is over
/// it (the frontend mirrors this constant for early UI feedback).
pub const MAX_HIGHLIGHTS_PER_FILE: usize = 2000;
/// A stored note must not exceed this many characters; `load` drops what
/// is over it.
pub const MAX_NOTE_CHARS: usize = 4_000;

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
    ///
    /// F10: on top of entry validation, a path holds at most
    /// `MAX_HIGHLIGHTS_PER_FILE` entries (the excess is truncated), notes
    /// over `MAX_NOTE_CHARS` characters are dropped (via `entry_problem`),
    /// and non-absolute path keys are dropped. When anything is dropped
    /// the *original* file is first *copied* (never renamed) to
    /// `highlights.json.invalid-<timestamp>` (0600 on Unix) so a later
    /// save cannot destroy the user's data, and the *filtered* store is
    /// then written back over the live file atomically, so the next load
    /// is clean and a re-filtering backup does not accumulate on every
    /// load. A failure of that write-back fails the load: the live file
    /// stays as found and the original remains in the backup.
    ///
    /// The write-back happens only when the filtering actually changed the
    /// store; a clean store is read and returned untouched, so a plain read
    /// can never write a stale snapshot over a save that just landed.
    ///
    /// Callers that already hold `RMW_LOCK` must use this (never the
    /// locking `load` — a double lock would deadlock: parking_lot mutexes
    /// are not reentrant).
    pub fn load_unlocked(dir: &Path) -> AppResult<HighlightsFile> {
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
                // F10: drop what no longer passes the save-time contract.
                // (a) non-absolute path keys — saves only ever write
                //     absolute paths, so these are hand-edits or leftovers;
                // (b) over the per-path cap (truncated);
                // (c) entries failing `entry_problem`, including notes
                //     over `MAX_NOTE_CHARS`.
                let mut dropped_paths = 0;
                file.files.retain(|path, _| {
                    let keep = Path::new(path).is_absolute();
                    if !keep {
                        dropped_paths += 1;
                    }
                    keep
                });
                let mut truncated = 0;
                let mut dropped_entries = 0;
                for list in file.files.values_mut() {
                    if list.len() > MAX_HIGHLIGHTS_PER_FILE {
                        truncated += list.len() - MAX_HIGHLIGHTS_PER_FILE;
                        list.truncate(MAX_HIGHLIGHTS_PER_FILE);
                    }
                    let before = list.len();
                    list.retain(|h| match entry_problem(h) {
                        Some(problem) => {
                            eprintln!(
                                "marque: highlights: dropped an invalid entry ({problem}) at \
                                 line {}, offset {}",
                                h.anchor.start_line, h.anchor.start_offset
                            );
                            false
                        }
                        None => true,
                    });
                    dropped_entries += before - list.len();
                }
                // When anything is dropped, keep the original as a 0600
                // *copy* (not a rename) so a later save cannot destroy the
                // user's data; the filtered store is written back over
                // the live file below so the next load is clean.
                if dropped_paths + truncated + dropped_entries > 0 {
                    // No backup, no load: a filtered store that could not be
                    // preserved must never reach a save that would make the
                    // loss permanent.
                    let backup = copy_with_suffix(&p, "invalid").with_context(|| {
                        format!(
                            "{} holds invalid highlights and could not be backed up",
                            p.display()
                        )
                    })?;
                    eprintln!(
                        "marque: highlights: filtered on load ({} invalid entries, {} over \
                         the per-file cap, {} non-absolute paths); the original was kept at {}",
                        dropped_entries,
                        truncated,
                        dropped_paths,
                        backup.display()
                    );
                }
                // Drop paths left empty by the filtering (or empty in the
                // file itself — a hand-edit a save would never write).
                let keys_before = file.files.len();
                file.files.retain(|_, list| !list.is_empty());
                let changed =
                    dropped_paths + truncated + dropped_entries > 0 || file.files.len() != keys_before;
                // Only when the filtering changed the store does it replace
                // the live file (same atomic path as a normal save); a
                // failure fails the load, so the file is left as found and
                // the original stays in the backup. A clean store is never
                // rewritten: a read must not write a snapshot back over a
                // save that landed after it read.
                if changed {
                    file.save(dir)?;
                }
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
    /// rename over the target. The temp file is created 0600 on Unix so
    /// the live file — which holds notes — is owner-only like its backups.
    /// Durability: the temp is `sync_all`-ed before the rename and the
    /// containing directory is fsynced after it (Unix), so a power loss
    /// cannot leave a renamed-but-unsynced live file or a lost file entry.
    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir).with_context(|| {
            format!("creating highlights directory {}", dir.display())
        })?;
        let _guard = SAVE_LOCK.lock();
        let p = dir.join(FILE_NAME);
        let tmp = dir.join(format!("{FILE_NAME}.tmp.{}", std::process::id()));
        let raw =
            serde_json::to_string_pretty(self).context("serializing the highlights store")?;
        // A stale temp from a crashed earlier save is replaced, not
        // appended to; `create_new` then fails if it is recreated in
        // between.
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true);
        opts.create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts
            .open(&tmp)
            .with_context(|| format!("opening temp file {}", tmp.display()))?;
        f.write_all(raw.as_bytes())
            .with_context(|| format!("writing temp file {}", tmp.display()))?;
        // Sync the temp before the rename: a crash must not leave a
        // renamed-but-unwritten live file. Drop the handle before the
        // rename — on Windows an open handle on the source can block a
        // replace-rename.
        f.sync_all()
            .with_context(|| format!("syncing temp file {}", tmp.display()))?;
        drop(f);
        std::fs::rename(&tmp, &p).with_context(|| {
            format!(
                "renaming temp file {} over {}",
                tmp.display(),
                p.display()
            )
        })?;
        // A rename only updates a directory entry: syncing the directory
        // makes the new live file survive a power loss.
        fsync_dir(dir);
        Ok(())
    }

    /// `load_unlocked`, serialized with `update_path` (and with other
    /// loads) by `RMW_LOCK`: a read — `get_highlights`,
    /// `list_highlighted_paths` — can never interleave with a save's
    /// read-modify-write, and it never writes a clean store back, so it
    /// cannot clobber a save that just landed.
    pub fn load(dir: &Path) -> AppResult<HighlightsFile> {
        let _guard = RMW_LOCK.lock();
        Self::load_unlocked(dir)
    }

    /// Read-modify-write for one document path, serialized across the
    /// process: two concurrent callers (rapid edits, two panes) each do
    /// load → set → save, and without the lock the second save would
    /// clobber the first's update. It holds `RMW_LOCK` over
    /// `load_unlocked` — never the locking `load`, which would deadlock,
    /// parking_lot mutexes not being reentrant — and over `save`.
    pub fn update_path(dir: &Path, path: String, highlights: Vec<Highlight>) -> AppResult<()> {
        let _guard = RMW_LOCK.lock();
        let mut file = Self::load_unlocked(dir)?;
        file.set(path, highlights);
        file.save(dir)
    }
}

/// `load`/`save` can be called from concurrent command tasks; the
/// rename-based write is atomic on its own, but the read-modify-write must
/// be serialized so concurrent saves to different paths cannot lose each
/// other. `RMW_LOCK` is held for the whole load → set → save and also for
/// plain loads, which write the store back only when their filtering
/// changed it — a read of a clean store is never a write. `SAVE_LOCK`
/// serializes bare `save` calls taken on their own.
static SAVE_LOCK: Mutex<()> = Mutex::new(());
static RMW_LOCK: Mutex<()> = Mutex::new(());

/// Tighten a secret-bearing file (the key, its temp file, every
/// corrupt/invalid backup) to owner-only 0600 on Unix; a no-op elsewhere.
/// A permission failure is a propagated error, never swallowed.
fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path)?;
        let mode = (meta.permissions().mode() & !0o777) | 0o600;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Fsync the directory itself so a rename (or a new entry) in it survives
/// a power loss. Best effort, and never fails the save: the file's bytes
/// were already `sync_all`-ed, so a refused directory fsync risks only the
/// directory entry, not the data. Filesystems that cannot sync a directory
/// refuse with EINVAL (22 on Linux and macOS) or an unsupported operation
/// (`ErrorKind::Unsupported`: ENOSYS/EOPNOTSUPP); those are ignored. A real
/// I/O error is logged and the save completes.
#[cfg(unix)]
fn fsync_dir(dir: &Path) {
    use std::io::ErrorKind;
    let result = std::fs::OpenOptions::new()
        .read(true)
        .open(dir)
        .and_then(|d| d.sync_all());
    if let Err(e) = result {
        let expected = e.raw_os_error() == Some(22) || e.kind() == ErrorKind::Unsupported;
        if !expected {
            eprintln!(
                "marque: highlights: could not sync directory {}: {e} (the file itself was \
                 synced; only the directory entry may not be durable)",
                dir.display()
            );
        }
    }
}

/// Off-Unix there is no portable directory fsync; the file-level
/// `sync_all` in each write path is the durability contract.
#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) {}

fn preserve_corrupt(path: &Path) -> AppResult<PathBuf> {
    preserve_with_suffix(path, "corrupt")
}

/// Move `path` to `path` with a `.suffix-<timestamp>` suffix, then
/// restrict the backup to owner-only 0600 (Unix) — it may hold user notes,
/// which can be sensitive.
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
            restrict_to_owner(&candidate)?;
            // The rename only updates a directory entry: sync the
            // directory so the backup survives a power loss.
            if let Some(dir) = path.parent() {
                fsync_dir(dir);
            }
            return Ok(candidate);
        }
        trial += 1;
    }
}

/// Copy `path` to `path` with a `.suffix-<timestamp>` suffix, then restrict
/// the copy to owner-only 0600 (Unix). A copy, never a rename: the live
/// file must stay in place for the F10 flow, where `load` filters it and
/// every subsequent load re-filters it, while the original is preserved
/// against later saves.
fn copy_with_suffix(path: &Path, suffix: &str) -> AppResult<PathBuf> {
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
            // Create the copy owner-only before any byte lands in it.
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut dest = opts.open(&candidate)?;
            let mut src = std::fs::File::open(path)?;
            std::io::copy(&mut src, &mut dest)?;
            dest.sync_all()?;
            restrict_to_owner(&candidate)?;
            // The copy created a new directory entry: sync the directory
            // so the backup survives a power loss.
            if let Some(dir) = path.parent() {
                fsync_dir(dir);
            }
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
/// The key file is created on the first call: any stale temp file from a
/// crashed run is removed, then a fresh temp file (0600 on Unix,
/// fail-if-exists) is written and renamed into place, so the key is never
/// observable with broader permissions and no other process can plant a
/// file under the temp name. An existing valid key file is tightened to
/// 0600 before use; a failed tightening is a hard error and the key is
/// not used. A file that is not exactly 32 lowercase hex characters is
/// backed up to `highlights.key.corrupt-<timestamp>` (0600 on Unix — it
/// may hold a previously working key, i.e. a secret) and replaced; the
/// warning names the situation only, never the file contents.
pub fn get_key(dir: &Path) -> AppResult<String> {
    let _guard = KEY_LOCK.lock();
    std::fs::create_dir_all(dir)?;
    let path = dir.join(KEY_NAME);
    let existing = std::fs::read_to_string(&path).ok().filter(|k| is_valid_key(k));
    if let Some(key) = existing {
        // A key file that drifted to a wider mode is tightened before use;
        // a failed tightening is a hard error — the key is not used.
        restrict_to_owner(&path)?;
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
    // Never inherit a stale temp file from a crashed run (it may hold a
    // key, or be a world-writable target someone planted): remove it,
    // then create the temp fresh and fail if it exists again.
    let _ = std::fs::remove_file(&tmp);
    // Write to a temp file with the final mode before renaming it into
    // place, so the key is never observable with broader permissions.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true);
    opts.create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&tmp)
        .with_context(|| format!("opening key temp file {}", tmp.display()))?;
    file.write_all(key.as_bytes())
        .with_context(|| format!("writing key temp file {}", tmp.display()))?;
    // Same durability contract as `save`: sync the key temp before the
    // rename, and the directory after it. Drop the handle before the
    // rename — on Windows an open handle on the source can block a
    // replace-rename.
    file.sync_all()
        .with_context(|| format!("syncing key temp file {}", tmp.display()))?;
    drop(file);
    std::fs::rename(&tmp, &path).with_context(|| {
        format!(
            "renaming key temp file {} over {}",
            tmp.display(),
            path.display()
        )
    })?;
    fsync_dir(dir);
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
            // The backup may hold a previously working key (a secret), so
            // tightening it to 0600 is part of the contract; a failure
            // propagates instead of being swallowed.
            restrict_to_owner(&candidate)?;
            // The rename only updates a directory entry: sync the
            // directory so the backup survives a power loss.
            if let Some(dir) = path.parent() {
                fsync_dir(dir);
            }
            return Ok(Some(candidate));
        }
        trial += 1;
    }
}

/// Structural validation for a stored entry. The file is user-mutable
/// (hand-edited, merged across machines), so every entry is checked on
/// load and again on save. The note cap is checked here too, so load and
/// save share one rule (F10). Returns a category label only — the message
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
    if h.note
        .as_deref()
        .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
    {
        return Some("note too long");
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Absolute on every platform: Windows needs a drive prefix, and the
    /// load filter drops non-absolute keys.
    #[cfg(windows)]
    const DOC_A: &str = r"C:\a.md";
    #[cfg(not(windows))]
    const DOC_A: &str = "/a.md";
    #[cfg(windows)]
    const DOC_ABS: &str = r"C:\abs\doc.md";
    #[cfg(not(windows))]
    const DOC_ABS: &str = "/abs/doc.md";

    #[cfg(windows)]
    fn doc_path(name: &str) -> String {
        format!(r"C:\{name}")
    }
    #[cfg(not(windows))]
    fn doc_path(name: &str) -> String {
        format!("/{name}")
    }

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
            DOC_A.into(),
            vec![
                h("1", Colour::Yellow, 0, 1),
                h("2", Colour::Blue, 3, 4),
            ],
        );
        f.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        let items = loaded.get(DOC_A);
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
        f.set(DOC_A.into(), vec![item]);
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
        f.set(DOC_A.into(), vec![h("1", Colour::Yellow, 0, 1)]);
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
        f.set(DOC_A.into(), vec![h("1", Colour::Yellow, 0, 1)]);
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
        f.set(DOC_A.into(), vec![item]);
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
                        doc_path(&format!("file-{}.md", id)),
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
            let items = loaded.get(&doc_path(&format!("file-{}.md", i)));
            assert_eq!(items.len(), 1, "path for file-{} was lost", i);
            assert_eq!(items[0].id, id(&i.to_string()));
        }
    }

    /// A load of a store the filtering leaves unchanged must not rewrite
    /// the file: a read that re-serialized on every call would let an
    /// older snapshot clobber a save that landed after it read (the F10
    /// write-back happens only when the filtering changed the store).
    #[test]
    fn a_clean_store_is_never_rewritten_by_load() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = HighlightsFile::default();
        f.set(DOC_A.into(), vec![h("1", Colour::Yellow, 0, 1)]);
        f.save(dir.path()).unwrap();

        let path = dir.path().join(FILE_NAME);
        let before = std::fs::read_to_string(&path).unwrap();
        let mtime_before = std::fs::metadata(&path).unwrap().modified().unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(loaded.get(DOC_A).len(), 1);

        // Untouched: the same bytes, the same mtime (a rename-based
        // rewrite changes both), and no invalid backup.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            mtime_before
        );
        assert!(invalid_backups(dir.path()).is_empty());
    }

    /// A concurrent plain read (`load`) must never lose an `update_path`
    /// whose save lands after the read's snapshot was taken: the read is
    /// serialized with the update by `RMW_LOCK` and writes nothing back.
    /// Stress: one reader load-looping while N rapid updates race it; the
    /// last update must be the one on disk.
    #[test]
    fn a_concurrent_load_never_clobbers_an_update_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let doc = doc_path("doc.md");
        let stop = Arc::new(AtomicBool::new(false));

        // A reader doing what get_highlights / list_highlighted_paths do:
        // plain loads, in a tight loop.
        let reader_stop = Arc::clone(&stop);
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            while !reader_stop.load(Ordering::Relaxed) {
                let _ = HighlightsFile::load(&reader_path);
            }
        });

        // N rapid updates to the same path.
        let n = 50;
        for i in 0..n {
            let mut e = h("1", Colour::Yellow, 0, 1);
            e.anchor.start_line = i;
            e.anchor.end_line = i + 1;
            HighlightsFile::update_path(&path, doc.clone(), vec![e]).unwrap();
        }

        stop.store(true, Ordering::Relaxed);
        reader.join().unwrap();

        let loaded = HighlightsFile::load(&path).unwrap();
        let items = loaded.get(&doc);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].anchor.start_line, n as u32 - 1);
    }

    #[test]
    fn set_with_empty_list_removes_the_key() {
        let mut f = HighlightsFile::default();
        f.set(DOC_A.into(), vec![h("1", Colour::Yellow, 0, 1)]);
        assert_eq!(f.files.len(), 1);
        // Clearing a file's highlights is just setting an empty list.
        f.set(DOC_A.into(), vec![]);
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

    #[cfg(unix)]
    #[test]
    fn a_valid_key_with_a_wider_mode_is_tightened_before_use() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEY_NAME);
        std::fs::write(&path, "0123456789abcdef0123456789abcdef\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let key = get_key(dir.path()).unwrap();
        // The same key is reused (not regenerated)…
        assert_eq!(key, "0123456789abcdef0123456789abcdef");
        // …and the file is now owner-only, with no corrupt backup.
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![KEY_NAME.to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_key_temp_file_is_removed_before_creation() {
        let dir = tempfile::tempdir().unwrap();
        // A leftover temp from a crashed run, left with a wide mode.
        let tmp = dir.path().join(format!("{KEY_NAME}.tmp.{}", std::process::id()));
        std::fs::write(&tmp, "stale secret bytes\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();

        let key = get_key(dir.path()).unwrap();
        assert_eq!(key.len(), 32);
        let path = dir.path().join(KEY_NAME);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), key);
        // The stale temp is consumed by the rename: nothing is left behind,
        // and the new key file is owner-only.
        assert!(!tmp.exists());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
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
    fn entry_validation_rejects_an_over_long_note_and_keeps_a_max_length_one() {
        let mut e = valid_entry();
        e.note = Some("a".repeat(MAX_NOTE_CHARS));
        assert_eq!(entry_problem(&e), None);
        e.note = Some("a".repeat(MAX_NOTE_CHARS + 1));
        assert_eq!(entry_problem(&e), Some("note too long"));
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
        file.set(DOC_A.into(), vec![bad, good]);
        file.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        let items = loaded.get(DOC_A);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id("3"));
    }

    #[test]
    fn load_drops_the_path_when_all_entries_are_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let mut bad = h("2", Colour::Blue, 3, 4);
        bad.anchor.hash = "nope".into();
        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), vec![bad]);
        file.save(dir.path()).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(loaded.files.is_empty());
    }

    // --- F10: load-time filtering with original backup ---

    fn invalid_backups(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("highlights.json.invalid-"))
            .collect()
    }

    #[cfg(unix)]
    fn assert_owner_only(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    /// A filtered store whose original cannot be preserved is not loaded,
    /// so no later save can make the loss permanent. The write-back of the
    /// filtered store cannot happen either, so the live file stays exactly
    /// as found.
    #[cfg(unix)]
    #[test]
    fn load_fails_when_the_invalid_backup_cannot_be_written() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut long = h("2", Colour::Blue, 3, 4);
        long.note = Some("a".repeat(MAX_NOTE_CHARS + 1));
        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), vec![long, h("1", Colour::Yellow, 0, 1)]);
        file.save(dir.path()).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        // A read-only directory: the backup copy cannot be created.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let probe = dir.path().join("probe");
        let writable = std::fs::write(&probe, b"x").is_ok(); // true when running as root
        let result = HighlightsFile::load(dir.path());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        if writable {
            return; // permissions are not enforced for this user; nothing to assert
        }
        assert!(result.is_err(), "load must fail when the backup cannot be written");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(invalid_backups(dir.path()).is_empty());
    }

    #[test]
    fn load_drops_an_over_long_note_and_keeps_the_original_as_an_invalid_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut short = h("1", Colour::Yellow, 0, 1);
        short.note = Some("a".repeat(MAX_NOTE_CHARS)); // exactly the cap: kept
        let mut long = h("2", Colour::Blue, 3, 4);
        long.note = Some("a".repeat(MAX_NOTE_CHARS + 1)); // one over: dropped
        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), vec![long, short]);
        file.save(dir.path()).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        let items = loaded.get(DOC_A);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id("1"));
        assert_eq!(items[0].note, Some("a".repeat(MAX_NOTE_CHARS)));

        // The live file is replaced by the filtered store (one entry);
        // only the backup still holds both.
        let live: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(live["files"][DOC_A].as_array().unwrap().len(), 1);

        // A single owner-only copy of the original.
        let backups = invalid_backups(dir.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
        #[cfg(unix)]
        assert_owner_only(&backups[0]);
    }

    /// A load that filters invalid entries writes the filtered store back
    /// over the live file, so a second load of the now-clean file makes no
    /// further backup (previously the original was re-filtered, and
    /// re-backed up, on every load).
    #[test]
    fn a_second_load_of_a_filtered_store_makes_no_further_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut bad = h("2", Colour::Blue, 3, 4);
        bad.anchor.hash = "nope".into();
        let good = h("3", Colour::Pink, 5, 6);
        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), vec![bad, good]);
        file.save(dir.path()).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        let first = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(first.get(DOC_A).len(), 1);
        assert_eq!(first.get(DOC_A)[0].id, id("3"));

        // The live file now holds the filtered store only.
        let live: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(live["files"][DOC_A].as_array().unwrap().len(), 1);

        let second = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(second.get(DOC_A).len(), 1);
        assert_eq!(second.get(DOC_A)[0].id, id("3"));

        // Exactly one backup (the original, from the first load), and the
        // live file was not touched by the second load.
        let backups = invalid_backups(dir.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
    }

    /// The live file is owner-only: the save's temp file is created 0600
    /// on Unix, so even a permissive umask cannot widen it. A stale temp
    /// from a crashed earlier save is replaced, not left behind.
    #[cfg(unix)]
    #[test]
    fn save_creates_the_live_file_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(format!("{FILE_NAME}.tmp.{}", std::process::id()));
        std::fs::write(&stale, "stale bytes").unwrap();

        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), vec![h("1", Colour::Yellow, 0, 1)]);
        file.save(dir.path()).unwrap();

        let live = dir.path().join(FILE_NAME);
        assert_eq!(
            std::fs::metadata(&live).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!stale.exists());
    }

    #[test]
    fn load_truncates_a_path_over_the_per_file_cap_and_keeps_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let list: Vec<Highlight> = (0..=MAX_HIGHLIGHTS_PER_FILE)
            .map(|i| {
                let mut e = h("", Colour::Blue, 0, 1);
                // Distinct, well-formed UUIDs per entry.
                e.id = id(&format!("{i:08x}"));
                e.anchor.start_offset = i as u32;
                e
            })
            .collect();
        let mut file = HighlightsFile::default();
        file.set(DOC_A.into(), list);
        file.save(dir.path()).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert_eq!(loaded.get(DOC_A).len(), MAX_HIGHLIGHTS_PER_FILE);

        // The live file is replaced by the truncated list.
        let live: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            live["files"][DOC_A].as_array().unwrap().len(),
            MAX_HIGHLIGHTS_PER_FILE
        );

        let backups = invalid_backups(dir.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
        #[cfg(unix)]
        assert_owner_only(&backups[0]);
    }

    #[test]
    fn load_drops_non_absolute_path_keys_and_keeps_absolute_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut file = HighlightsFile::default();
        file.set("relative/doc.md".into(), vec![h("1", Colour::Yellow, 0, 1)]);
        file.set(DOC_ABS.into(), vec![h("2", Colour::Blue, 0, 1)]);
        file.save(dir.path()).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        let loaded = HighlightsFile::load(dir.path()).unwrap();
        assert!(!loaded.files.contains_key("relative/doc.md"));
        assert_eq!(loaded.get(DOC_ABS).len(), 1);
        assert_eq!(loaded.get(DOC_ABS)[0].id, id("2"));

        // The live file is replaced by the filtered store.
        let live: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(live["files"].as_object().unwrap().contains_key(DOC_ABS));
        assert!(!live["files"].as_object().unwrap().contains_key("relative/doc.md"));

        let backups = invalid_backups(dir.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
        #[cfg(unix)]
        assert_owner_only(&backups[0]);
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
