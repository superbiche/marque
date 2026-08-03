import { useEffect, useReducer, useState, useCallback, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ThemeProvider } from "@/lib/theme";
import { PreferencesProvider, usePreferences } from "@/lib/preferences";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FolderSidebar } from "@/components/FolderSidebar";
import { Pane } from "@/components/Pane";
import { TableOfContents } from "@/components/TableOfContents";
import { Toolbar } from "@/components/Toolbar";
import { CommandPalette } from "@/components/CommandPalette";
import { Notifications } from "@/components/Notifications";
import { tauri, onCliTarget, onFolderChanged, onFileChanged, type AnnotatedFolder } from "@/lib/tauri";
import {
  createInitialState,
  reduce,
  getActivePane,
  getActiveTab,
  type SplitDirection,
} from "@/lib/workspace";
import { cn } from "@/lib/utils";

const WELCOME = `# Welcome to Marque

A fast markdown viewer with folder support.

- Press **⌘K** to open the command palette and search files.
- Press **⌘O** to open a file. **⌘F** searches inside the open document.
- Add a folder from the sidebar; it stays available across sessions.
- **⌘\\** splits the active pane vertically. **⌘⇧\\** splits horizontally.
- Drop a file onto the window to open it as a new tab.

Launch from the terminal:

\`\`\`bash
marque README.md       # open a file
marque ./docs/         # open a folder (auto-saved)
\`\`\`
`;

function AppShell() {
  const [state, dispatch] = useReducer(reduce, undefined, () => createInitialState(WELCOME));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [pendingFragment, setPendingFragment] = useState<{ path: string; fragment: string } | null>(null);
  const [folders, setFolders] = useState<AnnotatedFolder[]>([]);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const {
    contentZoomIn, contentZoomOut, contentZoomReset,
    sidebarLeftWidth, sidebarRightWidth,
    setSidebarWidth, resetSidebarWidth,
  } = usePreferences();

  const activeTab = getActiveTab(state);
  const activePane = getActivePane(state);
  const isSplit = state.panes.length > 1;

  const refreshFolders = useCallback(async () => {
    const list = await tauri.listFoldersGrouped();
    setFolders(list);
    return list;
  }, []);

  const openFile = useCallback(async (path: string): Promise<boolean> => {
    try {
      const text = await tauri.readFile(path);
      const title = path.split("/").pop() ?? path;
      dispatch({ type: "OPEN_FILE", path, title, source: text });
      return true;
    } catch (err) {
      console.error("failed to read file", err);
      return false;
    }
  }, []);

  const openLink = useCallback(async (path: string, fragment?: string) => {
    setPendingFragment(fragment === undefined ? null : { path, fragment });
    const opened = await openFile(path);
    if (!opened) setPendingFragment(null);
  }, [openFile]);

  // Initial load.
  useEffect(() => {
    (async () => {
      const target = await tauri.getInitialTarget();
      if (target.kind === "file") openFile(target.path);
      refreshFolders();
    })();
  }, [openFile, refreshFolders]);

  // Keep App-level folders in sync whenever folders are added/removed/changed.
  useEffect(() => {
    const off = onFolderChanged(() => {
      refreshFolders();
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [refreshFolders]);

  // Re-read open files when they change on disk.
  useEffect(() => {
    const off = onFileChanged(async (paths) => {
      for (const tab of Object.values(state.tabs)) {
        if (tab.filePath && paths.includes(tab.filePath)) {
          try {
            const text = await tauri.readFile(tab.filePath);
            dispatch({ type: "UPDATE_TAB_SOURCE", tabId: tab.id, source: text });
          } catch {
            // File may have been deleted; ignore
          }
        }
      }
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [state.tabs]);

  // CLI re-target via single-instance.
  useEffect(() => {
    const off = onCliTarget(async (t) => {
      if (t.kind === "file") openFile(t.path);
      if (t.kind === "folder") {
        const list = await refreshFolders();
        const folderId = list.find((folder) => folder.path === t.path)?.id;
        if (folderId) {
          setTimeout(() => {
            sidebarRef.current
              ?.querySelector(`#folder-${cssEscape(folderId)}`)
              ?.scrollIntoView({ block: "start" });
          }, 100);
        }
      }
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [openFile, refreshFolders]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (meta && k === "o") {
        e.preventDefault();
        handlePickFile();
      } else if (meta && k === "f") {
        e.preventDefault();
        setSearchPaneId(state.activePaneId);
      } else if (meta && e.key === "\\") {
        e.preventDefault();
        dispatch({ type: "SPLIT", direction: e.shiftKey ? "horizontal" : "vertical" });
      } else if (meta && k === "w") {
        e.preventDefault();
        const tabId = activePane.activeTabId;
        if (tabId) dispatch({ type: "CLOSE_TAB", tabId, paneId: activePane.id });
      } else if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        contentZoomIn();
      } else if (meta && e.key === "-") {
        e.preventDefault();
        contentZoomOut();
      } else if (meta && k === "0") {
        e.preventDefault();
        contentZoomReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.activePaneId, activePane.activeTabId, activePane.id, contentZoomIn, contentZoomOut, contentZoomReset]);

  // File drop opens as new tab.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const off = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths.length > 0) {
          openFile(e.payload.paths[0]);
        }
      });
      unlisten = off;
    })();
    return () => unlisten?.();
  }, [openFile]);

  const handlePickFile = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
    });
    if (typeof picked === "string") openFile(picked);
  };

  const handleSplit = (d: SplitDirection) => dispatch({ type: "SPLIT", direction: d });
  const handleCloseSplit = () => dispatch({ type: "CLOSE_SPLIT" });
  const handleJumpToFolder = (folderId: string) => {
    sidebarRef.current
      ?.querySelector(`#folder-${cssEscape(folderId)}`)
      ?.scrollIntoView({ block: "start" });
  };

  const renderPane = (paneId: string) => {
    const pane = state.panes.find((p) => p.id === paneId)!;
    const paneTab = pane.activeTabId ? state.tabs[pane.activeTabId] : undefined;
    const fragment = pendingFragment && pendingFragment.path === paneTab?.filePath
      ? pendingFragment.fragment
      : undefined;
    return (
      <Pane
        key={pane.id}
        pane={pane}
        tabs={state.tabs}
        isFocused={pane.id === state.activePaneId}
        onSelectTab={(tabId) => dispatch({ type: "SWITCH_TAB", paneId: pane.id, tabId })}
        onCloseTab={(tabId) => dispatch({ type: "CLOSE_TAB", tabId, paneId: pane.id })}
        onFocusPane={() => dispatch({ type: "FOCUS_PANE", paneId: pane.id })}
        searchOpen={searchPaneId === pane.id}
        onSearchClose={() => setSearchPaneId(null)}
        onOpenLink={openLink}
        fragment={fragment}
        onFragmentHandled={() => setPendingFragment(null)}
      />
    );
  };

  return (
    <div className="flex h-full">
      <div ref={sidebarRef} className="flex h-full min-h-0 shrink-0" style={{ width: sidebarLeftWidth }}>
        <FolderSidebar
          folders={folders}
          activePath={activeTab?.filePath}
          onOpenFile={openFile}
          onOpenPalette={() => setPaletteOpen(true)}
        />
      </div>
      <ResizeHandle
        side="left"
        onResize={(w) => setSidebarWidth("left", w)}
        onReset={() => resetSidebarWidth("left")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          filePath={activeTab?.filePath}
          onOpenFile={handlePickFile}
          onSplit={handleSplit}
          onCloseSplit={handleCloseSplit}
          isSplit={isSplit}
          onFind={() => setSearchPaneId(state.activePaneId)}
        />
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1">
            <div
              className={cn(
                "flex h-full",
                state.split === "horizontal" ? "flex-col" : "flex-row"
              )}
            >
              {state.panes.map((p, i) => (
                <div key={p.id} className="flex min-h-0 min-w-0 flex-1">
                  {renderPane(p.id)}
                  {i < state.panes.length - 1 && (
                    <div
                      className={cn(
                        "shrink-0 bg-border",
                        state.split === "horizontal" ? "h-px w-full" : "h-full w-px"
                      )}
                    />
                  )}
                </div>
              ))}
            </div>
          </main>
          {!isSplit && (
            <>
              <ResizeHandle
                side="right"
                onResize={(w) => setSidebarWidth("right", w)}
                onReset={() => resetSidebarWidth("right")}
                className="hidden lg:flex"
              />
              <aside className="hidden shrink-0 border-l bg-card/30 lg:block" style={{ width: sidebarRightWidth }}>
                <TableOfContents source={activeTab?.source ?? ""} />
              </aside>
            </>
          )}
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenFile={openFile}
        onSplit={handleSplit}
        onCloseSplit={handleCloseSplit}
        isSplit={isSplit}
        folders={folders}
        onJumpToFolder={handleJumpToFolder}
      />
    </div>
  );
}

function cssEscape(s: string): string {
  // Minimal escape for use in attribute selectors with UUID-like ids.
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export default function App() {
  return (
    <ThemeProvider>
      <PreferencesProvider>
        <TooltipProvider delayDuration={300}>
          <AppShell />
          <Notifications />
        </TooltipProvider>
      </PreferencesProvider>
    </ThemeProvider>
  );
}
