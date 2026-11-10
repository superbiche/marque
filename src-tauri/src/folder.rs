use crate::error::AppResult;
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_IGNORES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    ".venv",
    "__pycache__",
];

pub const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdx"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Last modified time in ms since epoch. For directories, the newest descendant.
    #[serde(default)]
    pub modified: u64,
    #[serde(default)]
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexedFile {
    pub folder_id: String,
    pub folder_name: String,
    pub absolute_path: String,
    pub relative_path: String,
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MARKDOWN_EXTS.iter().any(|m| m.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

pub fn is_ignored_dirname(name: &str) -> bool {
    name.starts_with('.') || DEFAULT_IGNORES.contains(&name)
}

/// True when a path below `root` has a hidden or default-ignored component.
/// The root itself is allowed so a selected hidden-named folder still has a
/// usable empty/loading representation.
pub fn has_ignored_component(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    relative.components().any(|component| {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        is_ignored_dirname(&name.to_string_lossy())
    })
}

/// The shared walk policy for tree construction and watcher directory
/// enumeration. It intentionally uses the ignore crate's own gitignore
/// handling instead of reproducing it from path names.
fn folder_walk_builder(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !(entry.depth() > 0 && is_ignored_dirname(&name))
        });
    builder
}

pub fn folder_walk(root: &Path) -> ignore::Walk {
    folder_walk_builder(root).build()
}

/// Build the tree of markdown files for a folder root.
/// Empty directories (no markdown descendants) are pruned.
pub fn build_tree(root: &Path) -> AppResult<TreeNode> {
    let files = collect_markdown_files_parallel(root);
    Ok(build_tree_from_files(root, files))
}

fn collect_markdown_files_parallel(root: &Path) -> Vec<(PathBuf, u64)> {
    let (sender, receiver) = mpsc::channel();
    folder_walk_builder(root).build_parallel().run(|| {
        let sender = sender.clone();
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() && is_markdown(path) {
                    let _ = sender.send((path.to_path_buf(), file_modified(path)));
                }
            }
            WalkState::Continue
        })
    });
    drop(sender);

    let mut files: Vec<_> = receiver.into_iter().collect();
    files.sort();
    files
}

#[cfg(test)]
fn build_tree_serial(root: &Path) -> TreeNode {
    let mut files = folder_walk(root)
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.is_file() && is_markdown(path))
                .then(|| (path.to_path_buf(), file_modified(path)))
        })
        .collect::<Vec<_>>();
    files.sort();
    build_tree_from_files(root, files)
}

fn build_tree_from_files(root: &Path, files: Vec<(PathBuf, u64)>) -> TreeNode {
    let root_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("folder")
        .to_string();

    let mut root_map = TreeMap::default();

    for (f, modified) in files {
        let rel = match f.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        insert_path(&mut root_map, rel, modified);
    }

    let mut root_node = into_tree_node(root_name, root.to_path_buf(), true, root_map);
    sort_tree(&mut root_node);
    root_node
}

#[derive(Default)]
struct TreeMap {
    children: BTreeMap<String, TreeMap>,
    /// The file's own mtime for leaf (file) nodes. Directories always keep
    /// 0 here; their `TreeNode` timestamp is the newest descendant, computed
    /// during conversion.
    modified: u64,
}

fn insert_path(node: &mut TreeMap, rel: &Path, modified: u64) {
    if rel.as_os_str().is_empty() {
        return;
    }
    let mut current = node;
    for component in rel.components() {
        let name = component.as_os_str().to_string_lossy().into_owned();
        current = current.children.entry(name).or_default();
    }
    current.modified = modified;
}

fn into_tree_node(name: String, path: PathBuf, is_dir: bool, tree: TreeMap) -> TreeNode {
    let mut children = Vec::with_capacity(tree.children.len());
    let mut newest = tree.modified;
    for (name, subtree) in tree.children {
        let child_path = path.join(&name);
        let child = into_tree_node(
            name,
            child_path,
            !subtree.children.is_empty(),
            subtree,
        );
        if child.modified > newest {
            newest = child.modified;
        }
        children.push(child);
    }
    TreeNode {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        modified: newest,
        children,
    }
}

/// A file's last-modified time in ms since the Unix epoch. Uses
/// `std::fs::metadata`, which follows symlinks: a linked `.md` file reports
/// its target's mtime.
fn file_modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(to_epoch_ms)
        .unwrap_or(0)
}

fn to_epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sort_tree(node: &mut TreeNode) {
    node.children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    for c in &mut node.children {
        sort_tree(c);
    }
}

/// Flatten the tree into IndexedFile entries (markdown files only).
pub fn flatten_files(
    folder_id: &str,
    folder_name: &str,
    folder_root: &Path,
    node: &TreeNode,
    out: &mut Vec<IndexedFile>,
) {
    if node.is_dir {
        for c in &node.children {
            flatten_files(folder_id, folder_name, folder_root, c, out);
        }
    } else {
        let abs = PathBuf::from(&node.path);
        let rel = abs
            .strip_prefix(folder_root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| node.name.clone());
        out.push(IndexedFile {
            folder_id: folder_id.to_string(),
            folder_name: folder_name.to_string(),
            absolute_path: node.path.clone(),
            relative_path: rel,
        });
    }
}

/// Walk up from `start` looking for a `.git` directory.
/// Stops at the user's home directory (inclusive) or filesystem root,
/// whichever comes first. Never walks above home.
pub fn find_git_repo_root(start: &Path) -> Option<String> {
    let ceiling = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut dir = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };
    loop {
        if dir.join(".git").exists() {
            return dir.to_str().map(String::from);
        }
        if dir == ceiling || !dir.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, "x").unwrap();
    }

    #[test]
    fn detects_markdown_extensions() {
        assert!(is_markdown(Path::new("a.md")));
        assert!(is_markdown(Path::new("a.MARKDOWN")));
        assert!(is_markdown(Path::new("a.mdx")));
        assert!(!is_markdown(Path::new("a.txt")));
        assert!(!is_markdown(Path::new("a")));
    }

    #[test]
    fn tree_includes_only_markdown() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("a.md"));
        touch(&dir.path().join("b.txt"));
        touch(&dir.path().join("sub/c.md"));
        let tree = build_tree(dir.path()).unwrap();
        let mut files = Vec::new();
        flatten_files("v", "folder", dir.path(), &tree, &mut files);
        let names: Vec<_> = files.iter().map(|f| f.relative_path.clone()).collect();
        assert!(names.iter().any(|n| n.ends_with("a.md")));
        assert!(names.iter().any(|n| n.ends_with("c.md")));
        assert!(!names.iter().any(|n| n.ends_with("b.txt")));
    }

    #[test]
    fn tree_skips_default_ignores_and_hidden() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("ok.md"));
        touch(&dir.path().join("node_modules/x.md"));
        touch(&dir.path().join(".git/y.md"));
        touch(&dir.path().join(".hidden/z.md"));
        let tree = build_tree(dir.path()).unwrap();
        let mut files = Vec::new();
        flatten_files("v", "folder", dir.path(), &tree, &mut files);
        let rels: Vec<_> = files.iter().map(|f| f.relative_path.clone()).collect();
        assert_eq!(rels, vec!["ok.md".to_string()]);
    }

    #[test]
    fn tree_directories_sorted_before_files() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("z_root.md"));
        touch(&dir.path().join("a_dir/inner.md"));
        let tree = build_tree(dir.path()).unwrap();
        assert_eq!(tree.children.len(), 2);
        assert!(tree.children[0].is_dir);
        assert_eq!(tree.children[0].name, "a_dir");
        assert_eq!(tree.children[1].name, "z_root.md");
    }

    fn set_mtime(p: &Path, ms: u64) {
        let f = fs::File::options().write(true).open(p).unwrap();
        let times =
            fs::FileTimes::new().set_modified(UNIX_EPOCH + std::time::Duration::from_millis(ms));
        f.set_times(times).unwrap();
    }

    #[test]
    fn tree_records_modified_and_dirs_use_newest_descendant() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("sub/old.md");
        let new = dir.path().join("sub/deep/new.md");
        let root_file = dir.path().join("root.md");
        touch(&old);
        touch(&new);
        touch(&root_file);
        set_mtime(&old, 1_000_000);
        set_mtime(&new, 3_000_000);
        set_mtime(&root_file, 2_000_000);

        let tree = build_tree(dir.path()).unwrap();
        let sub = tree.children.iter().find(|c| c.name == "sub").unwrap();
        let deep = sub.children.iter().find(|c| c.name == "deep").unwrap();
        let root_md = tree.children.iter().find(|c| c.name == "root.md").unwrap();
        assert_eq!(root_md.modified, 2_000_000);
        assert_eq!(deep.modified, 3_000_000);
        assert_eq!(sub.modified, 3_000_000);
        assert_eq!(tree.modified, 3_000_000);
    }

    #[cfg(unix)]
    #[test]
    fn tree_uses_symlink_target_modified() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("elsewhere/target.md");
        touch(&target);
        set_mtime(&target, 5_000_000);
        std::os::unix::fs::symlink(&target, dir.path().join("link.md")).unwrap();

        let tree = build_tree(dir.path()).unwrap();
        let link = tree.children.iter().find(|c| c.name == "link.md").unwrap();
        assert_eq!(link.modified, 5_000_000);
    }

    #[test]
    fn parallel_tree_matches_serial_tree() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("root.md"));
        touch(&dir.path().join("docs/a.md"));
        touch(&dir.path().join("docs/deep/b.markdown"));
        touch(&dir.path().join("node_modules/ignored.md"));
        assert_eq!(build_tree(dir.path()).unwrap(), build_tree_serial(dir.path()));
    }

    #[test]
    fn tree_handles_wide_directories() {
        let dir = tempdir().unwrap();
        for index in 0..200 {
            touch(&dir.path().join(format!("wide/file-{index:03}.md")));
        }
        let tree = build_tree(dir.path()).unwrap();
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].name, "wide");
        assert!(tree.children[0].is_dir);
        assert_eq!(tree.children[0].children.len(), 200);
        assert_eq!(tree.children[0].children[0].name, "file-000.md");
        assert_eq!(tree.children[0].children[199].name, "file-199.md");
    }

    #[test]
    fn tree_preserves_relative_path_in_indexed_files() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("docs/guide/intro.md"));
        let tree = build_tree(dir.path()).unwrap();
        let mut files = Vec::new();
        flatten_files("f1", "myfolder", dir.path(), &tree, &mut files);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].folder_id, "f1");
        assert_eq!(files[0].folder_name, "myfolder");
        assert_eq!(
            files[0].relative_path.replace('\\', "/"),
            "docs/guide/intro.md"
        );
    }

    #[test]
    fn find_git_repo_root_finds_repo() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::create_dir_all(dir.path().join("sub/deep")).unwrap();
        let result = find_git_repo_root(&dir.path().join("sub/deep"));
        assert_eq!(result, Some(dir.path().to_str().unwrap().to_string()));
    }

    #[test]
    fn find_git_repo_root_at_root_itself() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        let result = find_git_repo_root(dir.path());
        assert_eq!(result, Some(dir.path().to_str().unwrap().to_string()));
    }

    #[test]
    fn find_git_repo_root_none_when_no_git() {
        // The filesystem root is never below a repository root. This avoids
        // assuming that the shared test runner's /tmp has no .git directory.
        let result = find_git_repo_root(Path::new("/"));
        assert_eq!(result, None);
    }
}
