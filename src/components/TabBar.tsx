import { ClipboardCopy, Copy, FolderOpen, Pin, PinOff, X } from "lucide-react";
import { memo } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { startFileDrag } from "@/lib/dragOut";
import { cn } from "@/lib/utils";
import type { PaneState, TabState } from "@/lib/workspace";

interface Props {
  pane: PaneState;
  tabs: Record<string, TabState>;
  isFocused: boolean;
  onSelect: (paneId: string, tabId: string) => void;
  onClose: (paneId: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
  onRevealFile: (filePath?: string) => void;
  onCopyContent: (source?: string) => void;
  onCopyPath: (filePath?: string) => void;
  pinnedPaths: ReadonlySet<string>;
  onPinFile: (path: string) => void;
  onUnpinFile: (path: string) => void;
}

function tabLabel(tab: TabState | undefined): string {
  if (!tab) return "";
  if (tab.title === "Welcome") return "Welcome";
  if (tab.filePath) {
    const parts = tab.filePath.split("/");
    return parts[parts.length - 1];
  }
  return tab.title;
}

export const TabBar = memo(function TabBar({
  pane,
  tabs,
  isFocused,
  onSelect,
  onClose,
  onFocusPane,
  onRevealFile,
  onCopyContent,
  onCopyPath,
  pinnedPaths,
  onPinFile,
  onUnpinFile,
}: Props) {
  return (
    <div
      onMouseDown={() => onFocusPane(pane.id)}
      className={cn(
        "print-hide flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-card/40 px-1 pt-1",
        !isFocused && "opacity-70"
      )}
    >
      {pane.tabIds.map((id) => {
        const tab = tabs[id];
        const active = id === pane.activeTabId;
        const pinned = Boolean(tab?.filePath && pinnedPaths.has(tab.filePath));
        return (
          <ContextMenu key={id}>
            <ContextMenuTrigger asChild>
              <div
                onClick={() => onSelect(pane.id, id)}
                draggable={Boolean(tab?.filePath)}
                onDragStart={(event) => {
                  if (!tab?.filePath) return;
                  event.preventDefault();
                  startFileDrag(tab.filePath);
                }}
                className={cn(
                  "group flex h-7 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2 text-xs",
                  active
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent"
                )}
              >
                <span className="max-w-[160px] truncate">{tabLabel(tab)}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(pane.id, id);
                  }}
                  className={cn(
                    "rounded p-0.5 hover:bg-muted",
                    !active && "opacity-0 group-hover:opacity-100"
                  )}
                  aria-label="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={!tab?.filePath}
                onSelect={() => onRevealFile(tab?.filePath)}
              >
                <FolderOpen />
                View file location
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!tab?.filePath}
                onSelect={() => {
                  if (!tab?.filePath) return;
                  if (pinned) onUnpinFile(tab.filePath);
                  else onPinFile(tab.filePath);
                }}
              >
                {pinned ? <PinOff /> : <Pin />}
                {pinned ? "Unpin file" : "Pin file"}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCopyContent(tab?.source)}>
                <Copy />
                Copy content
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!tab?.filePath}
                onSelect={() => onCopyPath(tab?.filePath)}
              >
                <ClipboardCopy />
                Copy path
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
});
