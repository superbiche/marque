/**
 * Native macOS menu shortcut ownership.
 *
 * On macOS the app installs a native menu bar (see `src-tauri/src/menu.rs`)
 * whose accelerators AppKit runs before the webview gets a chance to react to
 * the key. The global keydown handler skips those keys so an action never
 * fires twice (once from the menu, once from the webview). On Linux and
 * Windows no native menu exists, so nothing is skipped and the webview
 * handler stays the sole owner of every shortcut.
 */

/**
 * Whether this webview is running on macOS, from the platform's own
 * `navigator` (no added dependency). `navigator.platform` is the primary
 * signal (WKWebView reports "MacIntel", even on Apple Silicon); the user-agent
 * test is the fallback for engines that leave `platform` empty (WebKitGTK).
 */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.platform === "string" && navigator.platform.startsWith("Mac")) return true;
  return /Macintosh|Mac OS X/i.test(navigator.userAgent);
}

/**
 * Whether the native macOS menu owns this key event, i.e. whether the
 * keydown handler must skip it (see the module docs).
 *
 * Pure on purpose: the platform flag is a parameter so the predicate is
 * unit-testable without a real webview. `isMacOS()` feeds it.
 */
export function nativeMenuOwnsKey(
  isMac: boolean,
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  if (!isMac || e.altKey || !e.metaKey) return false;
  const k = e.key.toLowerCase();
  if (e.ctrlKey) {
    // The only Command+Control accelerator the menu carries is the
    // predefined Fullscreen (⌃⌘F). The handler treats Control as Command,
    // so without this it would open Find while the menu toggles full screen.
    return !e.shiftKey && k === "f";
  }
  if (e.shiftKey) {
    // ⌘⇧\ (Split Down): the backslash key reports "|" when shifted.
    return e.key === "\\" || e.key === "|";
  }
  // ⌘ + the keys the menu binds: K, O, F, P, W, \, =, -, 0.
  return (
    k === "k" || k === "o" || k === "f" || k === "p" || k === "w" ||
    e.key === "\\" || k === "=" || k === "-" || k === "0"
  );
}
