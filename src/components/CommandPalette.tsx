import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { tauri, type Folder } from "@/lib/tauri";
import { rankActions } from "@/lib/actionSearch";
import type { PaletteSource } from "@/lib/paletteSources";
import { usePaletteResults } from "./usePaletteResults";
import type { LucideIcon } from "lucide-react";
import {
  FileText,
  Sun,
  Moon,
  FolderPlus,
  Monitor,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  FolderOpen,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Highlighter,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTheme, type Theme } from "@/lib/theme";
import { usePreferences } from "@/lib/preferences";
import type { SplitDirection } from "@/lib/workspace";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenFile: (path: string) => void;
  onSplit: (direction: SplitDirection) => void;
  onCloseSplit: () => void;
  isSplit: boolean;
  folders: Folder[];
  onJumpToFolder: (folderId: string) => void;
  onToggleHighlights?: () => void;
}

/** One palette action: the "actions" source, ranked by `rankActions`. */
interface PaletteAction {
  id: string;
  label: string;
  /** Extra match targets searched by the ranker (e.g. synonyms). */
  keywords?: readonly string[];
  icon: LucideIcon;
  run: () => void;
  /** Whether this action applies in the current state. */
  visible: boolean;
}

/** A typed query lists at most this many matching actions (above the files). */
const MAX_ACTION_RESULTS = 5;

export function CommandPalette({
  open,
  onOpenChange,
  onOpenFile,
  onSplit,
  onCloseSplit,
  isSplit,
  folders,
  onJumpToFolder,
  onToggleHighlights,
}: Props) {
  const [query, setQuery] = useState("");
  const { setTheme } = useTheme();
  const { zoomIn, zoomOut, zoomReset } = usePreferences();

  // Closing clears the query; the next opening starts empty.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const handleAddFolder = async () => {
    onOpenChange(false);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") await tauri.addFolder(picked);
  };

  const handleOpenFile = async () => {
    onOpenChange(false);
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
    });
    if (typeof picked === "string") onOpenFile(picked);
  };

  const setAppTheme = (t: Theme) => {
    setTheme(t);
    onOpenChange(false);
  };

  const handleSplit = (d: SplitDirection) => {
    onSplit(d);
    onOpenChange(false);
  };

  const handleCloseSplit = () => {
    onCloseSplit();
    onOpenChange(false);
  };

  // Definition order is the display order for an empty query and the
  // tie-break within a rank tier.
  const actions: PaletteAction[] = [
    { id: "open-file", label: "Open File…", icon: FileText, run: handleOpenFile, visible: true },
    {
      id: "add-folder",
      label: "Add Folder…",
      keywords: ["new folder", "workspace"],
      icon: FolderPlus,
      run: handleAddFolder,
      visible: true,
    },
    { id: "split-vertical", label: "Split Pane Vertically", icon: SplitSquareVertical, run: () => handleSplit("vertical"), visible: true },
    { id: "split-horizontal", label: "Split Pane Horizontally", icon: SplitSquareHorizontal, run: () => handleSplit("horizontal"), visible: true },
    { id: "close-split", label: "Close Split", icon: X, run: handleCloseSplit, visible: isSplit },
    {
      id: "toggle-highlights",
      label: "Toggle Highlights Panel",
      icon: Highlighter,
      run: () => {
        onToggleHighlights?.();
        onOpenChange(false);
      },
      visible: onToggleHighlights != null,
    },
    { id: "theme-light", label: "Theme: Light", icon: Sun, run: () => setAppTheme("light"), visible: true },
    { id: "theme-dark", label: "Theme: Dark", icon: Moon, run: () => setAppTheme("dark"), visible: true },
    { id: "theme-system", label: "Theme: System", icon: Monitor, run: () => setAppTheme("system"), visible: true },
    {
      id: "zoom-in",
      label: "Zoom In",
      keywords: ["bigger", "increase"],
      icon: ZoomIn,
      run: () => {
        zoomIn();
        onOpenChange(false);
      },
      visible: true,
    },
    {
      id: "zoom-out",
      label: "Zoom Out",
      keywords: ["smaller", "decrease"],
      icon: ZoomOut,
      run: () => {
        zoomOut();
        onOpenChange(false);
      },
      visible: true,
    },
    {
      id: "zoom-reset",
      label: "Reset Zoom",
      keywords: ["default zoom"],
      icon: RotateCcw,
      run: () => {
        zoomReset();
        onOpenChange(false);
      },
      visible: true,
    },
  ];

  // Group order is source order. Each source ranks its own results.
  const sources: PaletteSource[] = [
    {
      // Empty query: every visible action, in definition order. Typed query:
      // the best matches first, capped — actions stay findable while typing,
      // and a short list sits above the (Rust-ranked) file results.
      kind: "sync",
      id: "actions",
      heading: "Actions",
      search: (q) => {
        const visible = actions.filter((a) => a.visible);
        const byId = new Map(visible.map((a) => [a.id, a]));
        return rankActions(q, visible)
          .map((r) => byId.get(r.id))
          .filter((a): a is PaletteAction => a != null)
          .slice(0, q.trim() ? MAX_ACTION_RESULTS : undefined)
          .map((a) => {
            const Icon = a.icon;
            return {
              key: a.id,
              value: a.id,
              onSelect: a.run,
              render: () => (
                <>
                  <Icon className="mr-2 h-4 w-4" />
                  {a.label}
                </>
              ),
            };
          });
      },
    },
    {
      kind: "sync",
      id: "folders",
      heading: "Jump to Folder",
      search: (q) =>
        q !== ""
          ? []
          : folders.map((f) => ({
              key: f.id,
              value: `folder ${f.name}`,
              onSelect: () => {
                onJumpToFolder(f.id);
                onOpenChange(false);
              },
              render: () => (
                <>
                  <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="ml-2 max-w-[20ch] truncate text-xs text-muted-foreground">
                    {f.path}
                  </span>
                </>
              ),
            })),
    },
    {
      // Ranked by nucleo in Rust; shown in arrival order.
      kind: "async",
      id: "files",
      heading: "Files",
      debounceMs: 25,
      search: async (q) => {
        const results = await tauri.searchFiles(q, 50);
        return results.map((r) => ({
          key: r.absolute_path,
          value: `${r.folder_name}/${r.relative_path}`,
          onSelect: () => {
            onOpenChange(false);
            onOpenFile(r.absolute_path);
          },
          render: () => (
            <>
              <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 truncate">
                <div className="truncate font-medium">{r.relative_path.split("/").pop()}</div>
                <div className="truncate text-xs text-muted-foreground">{r.relative_path}</div>
              </div>
              <Badge variant="secondary" className="ml-2 shrink-0">{r.folder_name}</Badge>
            </>
          ),
        }));
      },
    },
  ];
  const groups = usePaletteResults(sources, query, open);

  return (
    // `shouldFilter: false`: each source owns its results — files are
    // pre-ranked by nucleo in Rust, actions by rankActions. With the default
    // on, cmdk would re-filter and re-rank them in JS (its scorer is not
    // nucleo's and can disagree with it).
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ shouldFilter: false }}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search files or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {groups.map(
          ({ source, items }) =>
            items.length > 0 && (
              <CommandGroup key={source.id} heading={source.heading}>
                {items.map((item) => (
                  <CommandItem key={item.key} value={item.value} onSelect={item.onSelect}>
                    {item.render()}
                  </CommandItem>
                ))}
              </CommandGroup>
            ),
        )}
      </CommandList>
    </CommandDialog>
  );
}
