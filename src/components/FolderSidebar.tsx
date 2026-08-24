import { memo, useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tauri, onFolderChanged, type AnnotatedFolder, type TreeNode } from "@/lib/tauri";
import { usePreferences } from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ClipboardCopy, Plus, X, ChevronDown, ChevronRight, ChevronsDownUp, FileText, FolderOpen, FolderTree, Pin, PinOff, Search, Layers, List } from "lucide-react";
import { FileTreeNode } from "@/components/FileTree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { startFileDrag } from "@/lib/dragOut";
import { cn } from "@/lib/utils";

interface Props {
  folders: AnnotatedFolder[];
  activePath?: string;
  onOpenFile: (absolutePath: string) => void;
  onOpenPalette: () => void;
  pinnedFiles: string[];
  pinnedPaths: ReadonlySet<string>;
  onPinFile: (path: string) => void;
  onUnpinFile: (path: string) => void;
  onRevealFile: (filePath?: string) => void;
  onCopyPath: (filePath?: string) => void;
}

interface RepoGroup {
  key: string;
  label: string;
  folders: AnnotatedFolder[];
}

function groupByRepo(folders: AnnotatedFolder[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>();
  for (const f of folders) {
    const key = f.repo_root ?? "__none__";
    const label = f.repo_name ?? "(no repo)";
    let group = map.get(key);
    if (!group) {
      group = { key, label, folders: [] };
      map.set(key, group);
    }
    group.folders.push(f);
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.key === "__none__") return 1;
    if (b.key === "__none__") return -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}

export const FolderSidebar = memo(function FolderSidebar({
  folders,
  activePath,
  onOpenFile,
  onOpenPalette,
  pinnedFiles,
  pinnedPaths,
  onPinFile,
  onUnpinFile,
  onRevealFile,
  onCopyPath,
}: Props) {
  const [trees, setTrees] = useState<Record<string, TreeNode>>({});
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const treesRef = useRef(trees);
  const collapsedRef = useRef(collapsed);
  const folderIdsRef = useRef(new Set<string>());
  const loadingTreeIdsRef = useRef(new Set<string>());
  const pendingForceIdsRef = useRef(new Set<string>());
  const { sidebarGroupByRepo, setSidebarGroupByRepo } = usePreferences();

  const loadTree = useCallback(async (folderId: string, force = false) => {
    if (loadingTreeIdsRef.current.has(folderId)) {
      if (force) pendingForceIdsRef.current.add(folderId);
      return;
    }
    if (!force && treesRef.current[folderId]) {
      return;
    }

    loadingTreeIdsRef.current.add(folderId);
    try {
      const tree = await tauri.readFolderTree(folderId);
      const next = { ...treesRef.current, [folderId]: tree };
      treesRef.current = next;
      setTrees((previous) => ({ ...previous, [folderId]: tree }));
    } catch {
      // unreadable folder
    } finally {
      loadingTreeIdsRef.current.delete(folderId);
      if (
        pendingForceIdsRef.current.delete(folderId) &&
        folderIdsRef.current.has(folderId)
      ) {
        void loadTree(folderId, true);
      }
    }
  }, []);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    const folderIds = new Set(folders.map((folder) => folder.id));
    folderIdsRef.current = folderIds;
    const next = Object.fromEntries(
      Object.entries(treesRef.current).filter(([folderId]) => folderIds.has(folderId))
    );
    if (Object.keys(next).length !== Object.keys(treesRef.current).length) {
      treesRef.current = next;
      setTrees(next);
    }
  }, [folders]);

  useEffect(() => {
    for (const folder of folders) {
      if (!collapsed[folder.id] && !treesRef.current[folder.id]) {
        void loadTree(folder.id);
      }
    }
  }, [collapsed, folders, loadTree]);

  useEffect(() => {
    const off = onFolderChanged((folderId) => {
      if (!folderIdsRef.current.has(folderId) || collapsedRef.current[folderId]) {
        if (!treesRef.current[folderId]) return;
        const { [folderId]: _, ...next } = treesRef.current;
        treesRef.current = next;
        setTrees(next);
        return;
      }

      void loadTree(folderId, true);
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [loadTree]);

  const handleToggleDir = useCallback((absolutePath: string) => {
    setExpandedDirs((previous) => {
      const next = new Set(previous);
      if (!next.delete(absolutePath)) next.add(absolutePath);
      return next;
    });
  }, []);

  const handleCollapseAll = useCallback((rootPath: string) => {
    const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
    setExpandedDirs((previous) => {
      const next = new Set<string>();
      for (const path of previous) {
        if (path !== rootPath && !path.startsWith(prefix)) next.add(path);
      }
      return next.size === previous.size ? previous : next;
    });
  }, []);

  const handleAdd = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      await tauri.addFolder(picked);
    }
  };

  const handleRemove = async (id: string) => {
    await tauri.removeFolder(id);
  };

  const renderFolder = (f: AnnotatedFolder) => {
    const tree = trees[f.id];
    const isCollapsed = collapsed[f.id];
    return (
      <div key={f.id} id={`folder-${f.id}`} className="group/folder mb-1">
        <div className="flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-accent">
          <button
            type="button"
            onClick={() => setCollapsed((c) => ({ ...c, [f.id]: !c[f.id] }))}
            className="flex flex-1 items-center gap-1 truncate text-left"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-xs font-semibold">{f.name}</span>
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => handleCollapseAll(f.path)}
                variant="ghost"
                size="icon"
                className={cn(
                  "h-5 w-5 opacity-0 transition-opacity",
                  "group-hover/folder:opacity-100"
                )}
              >
                <ChevronsDownUp className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Collapse all</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => handleRemove(f.id)}
                variant="ghost"
                size="icon"
                className={cn(
                  "h-5 w-5 opacity-0 transition-opacity",
                  "group-hover/folder:opacity-100"
                )}
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Remove from list</TooltipContent>
          </Tooltip>
        </div>
        {!isCollapsed && tree && (
          <FileTreeNode
            node={tree}
            isRoot
            activePath={activePath}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            onOpen={onOpenFile}
            pinnedPaths={pinnedPaths}
            onPinFile={onPinFile}
            onUnpinFile={onUnpinFile}
          />
        )}
      </div>
    );
  };

  const groups = groupByRepo(folders);

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r bg-card">
      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">Search files…</span>
          <kbd className="pointer-events-none inline-flex h-4 select-none items-center gap-0.5 rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground">
            <span className="text-xs">⌘</span>K
          </kbd>
        </button>
      </div>
      {pinnedFiles.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Pin className="h-3.5 w-3.5" />
            Pinned
          </div>
          <div className="max-h-48 shrink-0 overflow-y-auto px-1">
            {pinnedFiles.map((path) => {
              const name = path.split("/").pop() ?? path;
              const isActive = path === activePath;
              return (
                <ContextMenu key={path}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "group/pinned flex items-center gap-1 rounded px-1.5 py-0.5 text-sm hover:bg-accent",
                        isActive && "bg-accent text-accent-foreground"
                      )}
                    >
                      <button
                        type="button"
                        title={path}
                        onClick={() => onOpenFile(path)}
                        draggable
                        onDragStart={(event) => {
                          event.preventDefault();
                          startFileDrag(path);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{name}</span>
                      </button>
                      <Button
                        onClick={() => onUnpinFile(path)}
                        variant="ghost"
                        size="icon"
                        aria-label="Unpin file"
                        className={cn(
                          "h-5 w-5 opacity-0 transition-opacity",
                          "group-hover/pinned:opacity-100"
                        )}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => onUnpinFile(path)}>
                      <PinOff />
                      Unpin
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onRevealFile(path)}>
                      <FolderOpen />
                      View file location
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onCopyPath(path)}>
                      <ClipboardCopy />
                      Copy path
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </>
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FolderTree className="h-3.5 w-3.5" />
          Folders
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setSidebarGroupByRepo(!sidebarGroupByRepo)}
                variant="ghost"
                size="icon"
                className="h-6 w-6"
              >
                {sidebarGroupByRepo ? (
                  <List className="h-3.5 w-3.5" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarGroupByRepo ? "Flat view" : "Group by repository"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={handleAdd} variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Add folder</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {folders.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          No folders. Click + to add one.
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-1 pb-4">
          {sidebarGroupByRepo
            ? groups.map((group) => (
                <Collapsible
                  key={group.key}
                  open={!collapsedGroups[group.key]}
                  onOpenChange={(open) =>
                    setCollapsedGroups((c) => ({ ...c, [group.key]: !open }))
                  }
                >
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-accent">
                    {collapsedGroups[group.key] ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground/60">
                      {group.folders.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pl-1">
                      {group.folders.map(renderFolder)}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))
            : folders.map(renderFolder)}
        </div>
      </ScrollArea>
    </div>
  );
});
