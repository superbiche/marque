import { startDrag } from "@crabnebula/tauri-plugin-drag";
import dragIcon from "@/assets/drag-icon.png?inline";

/**
 * Start a native drag of a file out of the window (into a browser,
 * file manager, chat app, …). Call from a `dragstart` handler after
 * `event.preventDefault()` — the native drag replaces the HTML5 one.
 */
export function startFileDrag(absolutePath: string): void {
  void startDrag({ item: [absolutePath], icon: dragIcon }).catch((error) => {
    console.error("failed to start file drag", error);
  });
}
