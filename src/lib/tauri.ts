import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Highlight } from "./highlights";

export type InitialTarget =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "none" };

export interface Folder {
  id: string;
  name: string;
  path: string;
  added_at: string;
  /** User-defined sidebar group label; absent/empty keeps repository grouping. */
  group?: string | null;
}

export interface AnnotatedFolder extends Folder {
  repo_root: string | null;
  repo_name: string | null;
}

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  modified: number;
  children: TreeNode[];
}

export interface IndexedFile {
  folder_id: string;
  folder_name: string;
  absolute_path: string;
  relative_path: string;
}

export interface SearchResult extends IndexedFile {
  score: number;
}

export interface SettingsLoadStatus {
  corrupt_settings_path: string | null;
}

export interface WatchLimit {
  folder_id: string;
  folder_name: string;
  watched: number;
  limit: number;
}

export const tauri = {
  getInitialTarget: () => invoke<InitialTarget>("get_initial_target"),
  setInitialTarget: (target: InitialTarget) => invoke<void>("set_initial_target", { target }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  listFolders: () => invoke<Folder[]>("list_folders"),
  listFoldersGrouped: () => invoke<AnnotatedFolder[]>("list_folders_grouped"),
  addFolder: (path: string) => invoke<Folder>("add_folder", { path }),
  removeFolder: (id: string) => invoke<void>("remove_folder", { id }),
  setFolderGroup: (folderIds: string[], group: string | null) =>
    invoke<Folder[]>("set_folder_group", { folderIds, group }),
  readFolderTree: (id: string) => invoke<TreeNode>("read_folder_tree", { id }),
  searchFiles: (query: string, limit = 50) =>
    invoke<SearchResult[]>("search_files", { args: { query, limit } }),
  getRecentFiles: () => invoke<string[]>("get_recent_files"),
  listPinnedFiles: () => invoke<string[]>("list_pinned_files"),
  pinFile: (path: string) => invoke<string[]>("pin_file", { path }),
  unpinFile: (path: string) => invoke<string[]>("unpin_file", { path }),
  saveTheme: (theme: string) => invoke<void>("save_theme", { theme }),
  savePreferences: (prefs: PreferencesPayload) =>
    invoke<void>("save_preferences", { prefs }),
  loadPreferences: () => invoke<PreferencesPayload>("load_preferences"),
  getSettingsLoadStatus: () => invoke<SettingsLoadStatus>("get_settings_load_status"),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  getHighlights: (path: string) => invoke<GetHighlightsResult>("get_highlights", { path }),
  saveHighlights: (path: string, highlights: Highlight[]) =>
    invoke<void>("save_highlights", { path, highlights }),
  listHighlightedPaths: () => invoke<string[]>("list_highlighted_paths"),
  /** The per-installation 128-bit key (32 lowercase hex) used to fingerprint
   *  passage windows. Generated once on first use and stored in
   *  `highlights.key`; it never appears in highlights.json. */
  getHighlightsKey: () => invoke<string>("get_highlights_key"),
  /**
   * Acknowledge a window-close flush request the moment it is received: this
   * tells the backend the frontend is alive, which suppresses its 2-second
   * "frontend dead" fallback and starts a 30-second ceiling instead. Called
   * first in the `highlights://flush-request` handler, before the flush.
   */
  ackCloseRequest: () => invoke<void>("ack_close_request"),
  /**
   * Final word on a window close: the backend intercepts the first close
   * request, emits `highlights://flush-request`, waits for an ack and then a
   * flush. After awaiting its highlights flush the frontend calls this to let
   * the close through (and to stop the 30-second ceiling). See
   * `onHighlightsFlushRequest`.
   */
  confirmClose: () => invoke<void>("confirm_close"),
  /**
   * Cancel a window close after a failed highlights flush: stops the
   * 30-second ceiling without closing the window. The backend's close
   * guard moves to `DiscardAllowed`, so a later close request closes for
   * real ("close without saving").
   */
  cancelClose: () => invoke<void>("cancel_close"),
  /**
   * Re-arm the close guard after new edits were accepted following a
   * cancelled close: the guard's `DiscardAllowed` phase ("close again
   * closes for real, without saving") must not outlive those edits —
   * the store calls this on the first accepted mutation after a
   * cancelled close, and the backend moves the guard back to `Idle`, so
   * a later close request intercepts and asks for a fresh flush.
   */
  rearmCloseGuard: () => invoke<void>("rearm_close_guard"),
};

/**
 * Result of `get_highlights`: the v2 reference-only highlights for one
 * document path (empty when none).
 */
export interface GetHighlightsResult {
  version: number;
  highlights: Highlight[];
}

export interface PreferencesPayload {
  zoom: number | null;
  content_zoom: number | null;
  content_width: string | null;
  content_font: string | null;
  sidebar_left_width: number | null;
  sidebar_right_width: number | null;
  copy_as_markdown: boolean | null;
  sidebar_group_by_repo: boolean | null;
  sidebar_sort_by_modified: boolean | null;
}

export function onFolderChanged(cb: (folderId: string) => void): Promise<UnlistenFn> {
  return listen<string>("folder://changed", (e) => cb(e.payload));
}

export function onFileChanged(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("file://changed", (e) => cb(e.payload));
}

export function onCliTarget(cb: (t: InitialTarget) => void): Promise<UnlistenFn> {
  return listen<InitialTarget>("cli://target", (e) => cb(e.payload));
}

export function onFolderWatchLimit(cb: (limit: WatchLimit) => void): Promise<UnlistenFn> {
  return listen<WatchLimit>("folder://watch-limit", (e) => cb(e.payload));
}

/**
 * Fired by the backend when the main window's first close request is
 * intercepted so the frontend can flush pending highlights before the window
 * is destroyed (see `confirmClose`). The payload is a no-op token.
 */
export function onHighlightsFlushRequest(cb: () => void): Promise<UnlistenFn> {
  return listen("highlights://flush-request", () => cb());
}

/**
 * Ids the native macOS menu can emit (see `src-tauri/src/menu.rs`).
 * `help_github`, `close_window` and `quit` are handled in Rust and never
 * arrive.
 */
export type MenuActionId =
  | "open_file"
  | "close_tab"
  | "reveal"
  | "copy_markdown"
  | "print"
  | "palette"
  | "find"
  | "split_right"
  | "split_down"
  | "close_split"
  | "zoom_in"
  | "zoom_out"
  | "zoom_reset";

export function onMenuAction(cb: (id: MenuActionId) => void): Promise<UnlistenFn> {
  return listen<MenuActionId>("menu://action", (e) => cb(e.payload));
}

/**
 * URL the webview may load for a local file, through the Tauri asset protocol.
 * The backend extends the protocol scope when a document is opened
 * (`read_file`), so only files next to an opened document resolve. Returns
 * `null` outside the Tauri runtime (tests, plain browsers).
 */
export function toAssetUrl(absolutePath: string): string | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return convertFileSrc(absolutePath);
}
