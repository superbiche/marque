use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024; // 25 MB

pub fn read_text<P: AsRef<Path>>(path: P) -> AppResult<String> {
    let path = path.as_ref();
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::Invalid(format!(
            "file too large: {} bytes (max {})",
            meta.len(),
            MAX_FILE_BYTES
        )));
    }
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| AppError::Invalid("file is not valid UTF-8".into()))
}

/// The real location of an opened document: symlinks resolved and `..`
/// segments collapsed. `None` when the filesystem cannot resolve it; the
/// caller then grants nothing rather than trusting the lexical path.
pub fn canonical_document_path(path: &str) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Directory the asset protocol may serve so that images referenced by
/// `document` load. The base is the registered folder that contains the
/// document, otherwise the document's own directory; when the base sits in a
/// git repository, the scope widens to that repository's root so `../`
/// references to files elsewhere in the repo work. A repository rooted at
/// `home` or one of its ancestors is ignored (dotfiles repositories), and the
/// filesystem root is never granted.
pub fn asset_scope_dir(
    document: &Path,
    folder_root: Option<PathBuf>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let base = folder_root.or_else(|| document.parent().map(Path::to_path_buf))?;
    let dir = crate::folder::find_git_repo_root(&base)
        .map(PathBuf::from)
        .filter(|repo| home.is_none_or(|home| !home.starts_with(repo)))
        .unwrap_or(base);
    (dir.parent().is_some()).then_some(dir)
}

/// Extend the asset protocol scope (read-only, in-memory, reset on restart)
/// so the webview can load local images next to an opened document.
pub fn grant_asset_scope(
    app: &AppHandle,
    document: &Path,
    folder_root: Option<PathBuf>,
) -> AppResult<()> {
    let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
    let Some(dir) = asset_scope_dir(document, folder_root, home.as_deref()) else {
        return Ok(());
    };
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| AppError::Invalid(format!("asset scope for {}: {e}", dir.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn canonical_document_path_resolves_dotdot_and_symlinks() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir_all(real.join("docs")).unwrap();
        fs::write(real.join("docs/guide.md"), "x").unwrap();
        let real_canon = real.canonicalize().unwrap();

        let dotdot = real.join("docs/../docs/guide.md");
        assert_eq!(
            canonical_document_path(dotdot.to_str().unwrap()),
            Some(real_canon.join("docs/guide.md"))
        );

        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(
                canonical_document_path(link.join("docs/guide.md").to_str().unwrap()),
                Some(real_canon.join("docs/guide.md"))
            );
        }

        let missing = dir.path().join("missing/../nope.md");
        assert_eq!(canonical_document_path(missing.to_str().unwrap()), None);
    }

    #[test]
    fn asset_scope_prefers_the_registered_folder_root() {
        let doc = Path::new("/home/u/repo/docs/guide.md");
        assert_eq!(
            asset_scope_dir(doc, Some(PathBuf::from("/home/u/repo")), None),
            Some(PathBuf::from("/home/u/repo"))
        );
    }

    #[test]
    fn asset_scope_falls_back_to_the_document_directory() {
        let doc = Path::new("/home/u/notes/plan.md");
        assert_eq!(asset_scope_dir(doc, None, None), Some(PathBuf::from("/home/u/notes")));
    }

    #[test]
    fn asset_scope_never_grants_the_filesystem_root() {
        assert_eq!(asset_scope_dir(Path::new("/plan.md"), None, None), None);
        assert_eq!(asset_scope_dir(Path::new("/plan.md"), Some(PathBuf::from("/")), None), None);
    }

    /// A document reached through a symlink to `/` must not grant the root:
    /// canonicalization lands the document at `/<name>`, whose parent is `/`.
    #[cfg(unix)]
    #[test]
    fn asset_scope_rejects_a_document_reached_through_a_root_symlink() {
        let dir = tempdir().unwrap();
        let rootlink = dir.path().join("rootlink");
        std::os::unix::fs::symlink("/", &rootlink).unwrap();
        // `/proc/version` exists on Linux and lives directly under `/`.
        let lexical = rootlink.join("proc/version");
        let document = canonical_document_path(lexical.to_str().unwrap()).unwrap();
        assert_eq!(document, PathBuf::from("/proc/version"));
        // `/proc` is a real directory: granted, bounded, not `/`.
        assert_eq!(asset_scope_dir(&document, None, None), Some(PathBuf::from("/proc")));
        // A file directly under `/` would have `/` as its directory: refused.
        assert_eq!(asset_scope_dir(Path::new("/guide.md"), None, None), None);
    }

    /// A temp repository `repo/` (with `.git/`) holding `repo/docs/guide.md`
    /// and `repo/assets/`; returns the canonical repo root.
    fn temp_repo(dir: &Path) -> PathBuf {
        let repo = dir.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("docs")).unwrap();
        fs::create_dir_all(repo.join("assets")).unwrap();
        fs::write(repo.join("docs/guide.md"), "x").unwrap();
        repo.canonicalize().unwrap()
    }

    #[test]
    fn asset_scope_widens_a_standalone_document_to_its_repository() {
        let dir = tempdir().unwrap();
        let repo = temp_repo(dir.path());
        assert_eq!(asset_scope_dir(&repo.join("docs/guide.md"), None, None), Some(repo));
    }

    #[test]
    fn asset_scope_widens_a_registered_subfolder_to_its_repository() {
        let dir = tempdir().unwrap();
        let repo = temp_repo(dir.path());
        assert_eq!(
            asset_scope_dir(&repo.join("docs/guide.md"), Some(repo.join("docs")), None),
            Some(repo)
        );
    }

    #[test]
    fn asset_scope_stops_at_the_nearest_repository() {
        let dir = tempdir().unwrap();
        let repo = temp_repo(dir.path());
        // A submodule or linked worktree marks its root with a `.git` file.
        let sub = repo.join("vendor/lib");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join(".git"), "gitdir: ../../.git/modules/lib").unwrap();
        fs::write(sub.join("README.md"), "x").unwrap();
        assert_eq!(asset_scope_dir(&sub.join("README.md"), None, None), Some(sub));
    }

    #[test]
    fn asset_scope_ignores_a_repository_at_home_or_above() {
        let dir = tempdir().unwrap();
        let home = temp_repo(dir.path());
        let doc = home.join("docs/guide.md");
        // `home` itself is a repository (a dotfiles checkout): not widened.
        assert_eq!(asset_scope_dir(&doc, None, Some(&home)), Some(home.join("docs")));
        // A repository above `home` is ignored as well.
        let below = home.join("docs");
        assert_eq!(asset_scope_dir(&doc, None, Some(&below)), Some(home.join("docs")));
    }

    #[test]
    fn asset_scope_keeps_the_document_directory_outside_a_repository() {
        let dir = tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("plan.md"), "x").unwrap();
        let notes = notes.canonicalize().unwrap();
        assert_eq!(asset_scope_dir(&notes.join("plan.md"), None, None), Some(notes));
    }

    #[test]
    fn reads_text_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "hello\n").unwrap();
        assert_eq!(read_text(&p).unwrap(), "hello\n");
    }

    #[test]
    fn rejects_non_utf8() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("bad.md");
        fs::write(&p, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(matches!(read_text(&p), Err(AppError::Invalid(_))));
    }

    #[test]
    fn missing_file_returns_io_err() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("missing.md");
        assert!(matches!(read_text(&p), Err(AppError::Io(_))));
    }
}
