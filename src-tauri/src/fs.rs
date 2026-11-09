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

/// Directory the asset protocol may serve so that images referenced by
/// `document` load: the registered folder that contains it when there is one
/// (so `../` references within the workspace work), otherwise the document's
/// own directory. Never the filesystem root.
pub fn asset_scope_dir(document: &Path, folder_root: Option<PathBuf>) -> Option<PathBuf> {
    let dir = folder_root.or_else(|| document.parent().map(Path::to_path_buf))?;
    (dir.parent().is_some()).then_some(dir)
}

/// Extend the asset protocol scope (read-only, in-memory, reset on restart)
/// so the webview can load local images next to an opened document.
pub fn grant_asset_scope(
    app: &AppHandle,
    document: &Path,
    folder_root: Option<PathBuf>,
) -> AppResult<()> {
    let Some(dir) = asset_scope_dir(document, folder_root) else {
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
    fn asset_scope_prefers_the_registered_folder_root() {
        let doc = Path::new("/home/u/repo/docs/guide.md");
        assert_eq!(
            asset_scope_dir(doc, Some(PathBuf::from("/home/u/repo"))),
            Some(PathBuf::from("/home/u/repo"))
        );
    }

    #[test]
    fn asset_scope_falls_back_to_the_document_directory() {
        let doc = Path::new("/home/u/notes/plan.md");
        assert_eq!(asset_scope_dir(doc, None), Some(PathBuf::from("/home/u/notes")));
    }

    #[test]
    fn asset_scope_never_grants_the_filesystem_root() {
        assert_eq!(asset_scope_dir(Path::new("/plan.md"), None), None);
        assert_eq!(asset_scope_dir(Path::new("/plan.md"), Some(PathBuf::from("/"))), None);
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
