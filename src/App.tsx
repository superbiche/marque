import { useEffect, useMemo, useReducer, useState, useCallback, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { PreferencesProvider, usePreferences } from "@/lib/preferences";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FolderSidebar } from "@/components/FolderSidebar";
import { Pane } from "@/components/Pane";
import { TableOfContents } from "@/components/TableOfContents";
import { Toolbar } from "@/components/Toolbar";
import { CommandPalette } from "@/components/CommandPalette";
import { Notifications, notifyApp } from "@/components/Notifications";
import {
  tauri,
  onCliTarget,
  onFolderChanged,
  onFileChanged,
  onMenuAction,
  type AnnotatedFolder,
  type MenuActionId,
} from "@/lib/tauri";
import { isMacOS, nativeMenuOwnsKey } from "@/lib/menuShortcuts";
import {
  createInitialState,
  reduce,
  getActivePane,
  getActiveTab,
  type SplitDirection,
  type TabState,
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

// Cap on how long the print flow waits for the light re-render, so a missed
// render callback can never leave the print button doing nothing.
const PRINT_RENDER_TIMEOUT_MS = 4000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function AppShell() {
  const [state, dispatch] = useReducer(reduce, undefined, () => createInitialState(WELCOME));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [pendingFragment, setPendingFragment] = useState<{ path: string; fragment: string } | null>(null);
  const [folders, setFolders] = useState<AnnotatedFolder[]>([]);
  const [pinnedFiles, setPinnedFiles] = useState<string[]>([]);
  // True once a pin/unpin response has been applied — from then on the
  // backend-returned lists are authoritative over the initial load.
  const pinsMutatedRef = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(state.tabs);
  const activeTabRef = useRef<TabState | undefined>(undefined);
  const { resolved, setPrintLight } = useTheme();
  const {
    contentZoomIn, contentZoomOut, contentZoomReset,
    sidebarLeftWidth, sidebarRightWidth,
    setSidebarWidth, resetSidebarWidth,
  } = usePreferences();

  const activeTab = getActiveTab(state);
  const activePane = getActivePane(state);
  const isSplit = state.panes.length > 1;

  useEffect(() => {
    tabsRef.current = state.tabs;
  }, [state.tabs]);

  // The toolbar is memoized, so its handlers have to stay identity-stable while
  // the active tab (and its watcher-refreshed source) changes underneath them.
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

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
      tauri.listPinnedFiles().then((pinned) => {
        // A pin/unpin response carries the newer list; don't let a slow
        // initial load overwrite it.
        if (!pinsMutatedRef.current) setPinnedFiles(pinned);
      }).catch((err) => {
        console.error("failed to load pinned files", err);
      });
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
      for (const tab of Object.values(tabsRef.current)) {
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
  }, []);

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

  // Print always goes out on the light theme: Shiki and mermaid bake theme
  // colors into the rendered markup, so a dark document has to be re-rendered
  // in light before the dialog opens. window.print() blocks until the dialog is
  // dismissed, and this webview never fires beforeprint/afterprint.
  const printingRef = useRef(false);
  const renderWaitersRef = useRef<{ paneId: string; resolve: () => void }[]>([]);

  const handleContentRendered = useCallback((paneId: string) => {
    // A highlight pass already in flight when we flip resolves while the root is
    // still dark. Ignoring those keeps us from printing the stale dark markup.
    if (document.documentElement.classList.contains("dark")) return;
    renderWaitersRef.current = renderWaitersRef.current.filter((waiter) => {
      if (waiter.paneId !== paneId) return true;
      waiter.resolve();
      return false;
    });
  }, []);

  const handlePrint = useCallback(async () => {
    if (printingRef.current) return;
    printingRef.current = true;
    const goLight = resolved === "dark";
    try {
      if (goLight) {
        const paneId = state.activePaneId;
        const rendered = new Promise<boolean>((resolve) => {
          const waiter = { paneId, resolve: () => resolve(true) };
          renderWaitersRef.current.push(waiter);
          window.setTimeout(() => {
            renderWaitersRef.current = renderWaitersRef.current.filter((w) => w !== waiter);
            resolve(false);
          }, PRINT_RENDER_TIMEOUT_MS);
        });
        setPrintLight(true);
        if (!(await rendered)) {
          // Printing whatever is in the DOM at this point could emit raw,
          // half-highlighted markup — abort visibly instead.
          notifyApp("Print cancelled: the document did not finish re-rendering for print.");
          return;
        }
      }
      await nextFrame();
      await nextFrame();
      window.print();
    } finally {
      if (goLight) setPrintLight(false);
      printingRef.current = false;
    }
  }, [resolved, setPrintLight, state.activePaneId]);

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

  const handlePickFile = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
    });
    if (typeof picked === "string") openFile(picked);
  }, [openFile]);

  const handleSplit = useCallback((direction: SplitDirection) => {
    dispatch({ type: "SPLIT", direction });
  }, []);
  const handleCloseSplit = useCallback(() => dispatch({ type: "CLOSE_SPLIT" }), []);
  const handleJumpToFolder = useCallback((folderId: string) => {
    sidebarRef.current
      ?.querySelector(`#folder-${cssEscape(folderId)}`)
      ?.scrollIntoView({ block: "start" });
  }, []);
  const handleSelectTab = useCallback((paneId: string, tabId: string) => {
    dispatch({ type: "SWITCH_TAB", paneId, tabId });
  }, []);
  const handleCloseTab = useCallback((paneId: string, tabId: string) => {
    dispatch({ type: "CLOSE_TAB", paneId, tabId });
  }, []);
  const handleFocusPane = useCallback((paneId: string) => {
    dispatch({ type: "FOCUS_PANE", paneId });
  }, []);
  const handleSearchClose = useCallback(() => setSearchPaneId(null), []);
  const handleFind = useCallback(() => setSearchPaneId(state.activePaneId), [state.activePaneId]);
  const handleOpenPalette = useCallback(() => setPaletteOpen(true), []);
  const handleFragmentHandled = useCallback(() => setPendingFragment(null), []);

  const revealFile = useCallback(async (filePath?: string) => {
    if (!filePath) {
      notifyApp("No file to show: this tab is not backed by a file on disk.");
      return;
    }
    try {
      await tauri.revealInFileManager(filePath);
    } catch (err) {
      console.error("failed to reveal file", err);
      notifyApp("Could not open the file location.");
    }
  }, []);

  const copyToClipboard = useCallback(async (text: string | undefined, message: string) => {
    if (text === undefined) {
      notifyApp("Nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notifyApp(message);
    } catch (err) {
      console.error("failed to write to clipboard", err);
      notifyApp("Could not copy to the clipboard.");
    }
  }, []);

  const handleCopyContent = useCallback((source?: string) => {
    void copyToClipboard(source, "Content copied");
  }, [copyToClipboard]);
  const handleCopyPath = useCallback((filePath?: string) => {
    void copyToClipboard(filePath, "Path copied");
  }, [copyToClipboard]);
  const handleRevealFile = useCallback((filePath?: string) => {
    void revealFile(filePath);
  }, [revealFile]);
  const handleRevealActiveFile = useCallback(() => {
    void revealFile(activeTabRef.current?.filePath);
  }, [revealFile]);
  const handleCopyActiveContent = useCallback(() => {
    void copyToClipboard(activeTabRef.current?.source, "Content copied");
  }, [copyToClipboard]);

  const handlePinFile = useCallback(async (path: string) => {
    try {
      const pinned = await tauri.pinFile(path);
      pinsMutatedRef.current = true;
      setPinnedFiles(pinned);
    } catch (err) {
      console.error("failed to pin file", err);
      notifyApp("Could not pin the file.");
    }
  }, []);

  const handleUnpinFile = useCallback(async (path: string) => {
    try {
      const pinned = await tauri.unpinFile(path);
      pinsMutatedRef.current = true;
      setPinnedFiles(pinned);
    } catch (err) {
      console.error("failed to unpin file", err);
      notifyApp("Could not unpin the file.");
    }
  }, []);

  // Single action dispatcher shared by the keydown handler and the native
  // macOS menu, which emits the same ids via a `menu://action` event
  // (see `src-tauri/src/menu.rs`).
  const handleAppAction = useCallback((id: MenuActionId) => {
    switch (id) {
      case "palette":
        setPaletteOpen((v) => !v);
        break;
      case "open_file":
        void handlePickFile();
        break;
      case "find":
        setSearchPaneId(state.activePaneId);
        break;
      case "print":
        void handlePrint();
        break;
      case "split_right":
        dispatch({ type: "SPLIT", direction: "vertical" });
        break;
      case "split_down":
        dispatch({ type: "SPLIT", direction: "horizontal" });
        break;
      case "close_tab":
        if (activePane.activeTabId) {
          dispatch({ type: "CLOSE_TAB", tabId: activePane.activeTabId, paneId: activePane.id });
        }
        break;
      case "close_split":
        handleCloseSplit();
        break;
      case "zoom_in":
        contentZoomIn();
        break;
      case "zoom_out":
        contentZoomOut();
        break;
      case "zoom_reset":
        contentZoomReset();
        break;
      case "reveal":
        handleRevealActiveFile();
        break;
      case "copy_markdown":
        handleCopyActiveContent();
        break;
    }
  }, [
    state.activePaneId,
    handlePickFile,
    handlePrint,
    activePane,
    handleCloseSplit,
    contentZoomIn,
    contentZoomOut,
    contentZoomReset,
    handleRevealActiveFile,
    handleCopyActiveContent,
  ]);

  // The menu listener registers once; the ref keeps it from holding a stale
  // dispatcher (the other event listeners above use identity-stable callbacks,
  // which this one is not).
  const appActionRef = useRef(handleAppAction);
  useEffect(() => {
    appActionRef.current = handleAppAction;
  }, [handleAppAction]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const off = await onMenuAction((id) => appActionRef.current(id));
      unlisten = off;
    })();
    return () => unlisten?.();
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const mac = isMacOS();
    const onKey = (e: KeyboardEvent) => {
      // On macOS the native menu owns these accelerators: AppKit runs the
      // menu's action (and preventDefault stops webview built-ins such as
      // the ⌘F find bar), so reacting here too would fire it twice.
      if (nativeMenuOwnsKey(mac, e)) {
        e.preventDefault();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === "k") {
        e.preventDefault();
        handleAppAction("palette");
      } else if (meta && k === "o") {
        e.preventDefault();
        handleAppAction("open_file");
      } else if (meta && k === "f") {
        e.preventDefault();
        handleAppAction("find");
      } else if (meta && k === "p") {
        e.preventDefault();
        handleAppAction("print");
      } else if (meta && e.key === "\\") {
        // The backslash key reports "|" when Shift is held, so this branch is
        // unshifted-only: the ⌘⇧\ (horizontal) twin of the old code never
        // matched, so Split Right is all it could ever dispatch.
        e.preventDefault();
        handleAppAction("split_right");
      } else if (meta && k === "w") {
        e.preventDefault();
        handleAppAction("close_tab");
      } else if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        handleAppAction("zoom_in");
      } else if (meta && e.key === "-") {
        e.preventDefault();
        handleAppAction("zoom_out");
      } else if (meta && k === "0") {
        e.preventDefault();
        handleAppAction("zoom_reset");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleAppAction]);

  const pinnedPaths = useMemo(() => new Set(pinnedFiles), [pinnedFiles]);

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
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onFocusPane={handleFocusPane}
        searchOpen={searchPaneId === pane.id}
        onSearchClose={handleSearchClose}
        onOpenLink={openLink}
        fragment={fragment}
        onFragmentHandled={handleFragmentHandled}
        onContentRendered={handleContentRendered}
        onRevealFile={handleRevealFile}
        onCopyContent={handleCopyContent}
        onCopyPath={handleCopyPath}
        pinnedPaths={pinnedPaths}
        onPinFile={handlePinFile}
        onUnpinFile={handleUnpinFile}
      />
    );
  };

  return (
    <div className="app-root flex h-full">
      <div ref={sidebarRef} className="print-hide flex h-full min-h-0 shrink-0" style={{ width: sidebarLeftWidth }}>
        <FolderSidebar
          folders={folders}
          activePath={activeTab?.filePath}
          onOpenFile={openFile}
          onOpenPalette={handleOpenPalette}
          pinnedFiles={pinnedFiles}
          pinnedPaths={pinnedPaths}
          onPinFile={handlePinFile}
          onUnpinFile={handleUnpinFile}
          onRevealFile={handleRevealFile}
          onCopyPath={handleCopyPath}
        />
      </div>
      <ResizeHandle
        side="left"
        onResize={(w) => setSidebarWidth("left", w)}
        onReset={() => resetSidebarWidth("left")}
      />
      <div className="app-main-column flex min-w-0 flex-1 flex-col">
        <Toolbar
          filePath={activeTab?.filePath}
          onOpenFile={handlePickFile}
          onSplit={handleSplit}
          onCloseSplit={handleCloseSplit}
          isSplit={isSplit}
          onFind={handleFind}
          onPrint={handlePrint}
          onRevealFile={handleRevealActiveFile}
          onCopyContent={handleCopyActiveContent}
        />
        <div className="app-body-row flex min-h-0 flex-1">
          <main className="app-main min-w-0 flex-1">
            <div
              className={cn(
                "app-split flex h-full",
                state.split === "horizontal" ? "flex-col" : "flex-row"
              )}
            >
              {state.panes.map((p, i) => (
                <div
                  key={p.id}
                  className="app-pane-slot flex min-h-0 min-w-0 flex-1"
                  data-pane-focused={p.id === state.activePaneId}
                >
                  {renderPane(p.id)}
                  {i < state.panes.length - 1 && (
                    <div
                      className={cn(
                        "print-hide shrink-0 bg-border",
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
              <aside className="print-hide hidden shrink-0 border-l bg-card/30 lg:block" style={{ width: sidebarRightWidth }}>
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
