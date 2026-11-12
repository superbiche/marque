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
import { tauri, type SearchResult, type Folder } from "@/lib/tauri";
import { rankActions } from "@/lib/actionSearch";
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
  const [results, setResults] = useState<SearchResult[]>([]);
  // The query `results` was computed for. The file group renders only when
  // it equals the current query, so a batch for an earlier query is neither
  // shown nor selectable while the new query's search is still in flight.
  const [resultsQuery, setResultsQuery] = useState("");
  const { setTheme } = useTheme();
  const { zoomIn, zoomOut, zoomReset } = usePreferences();

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await tauri.searchFiles(query, 50);
        if (!cancelled) {
          setResults(r);
          setResultsQuery(query);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setResultsQuery(query);
        }
      }
    }, 25);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

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

  // Empty query: every visible action, in definition order. Typed query: the
  // best matches first, capped — actions stay findable while typing, and a
  // short list sits above the (Rust-ranked) file results.
  const visibleActions = actions.filter((a) => a.visible);
  const byId = new Map(visibleActions.map((a) => [a.id, a]));
  const shownActions = rankActions(query, visibleActions)
    .map((r) => byId.get(r.id))
    .filter((a): a is PaletteAction => a != null)
    .slice(0, query.trim() ? MAX_ACTION_RESULTS : undefined);

  return (
    // `shouldFilter: false`: each source owns its results — files are
    // pre-ranked by nucleo in Rust, actions by rankActions above. With the
    // default on, cmdk would re-filter and re-rank the file results in JS
    // (its scorer is not nucleo's and can disagree with it).
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ shouldFilter: false }}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search files or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {shownActions.length > 0 && (
          <CommandGroup heading="Actions">
            {shownActions.map((a) => {
              const Icon = a.icon;
              return (
                <CommandItem key={a.id} value={a.id} onSelect={a.run}>
                  <Icon className="mr-2 h-4 w-4" />
                  {a.label}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {query === "" && folders.length > 0 && (
          <CommandGroup heading="Jump to Folder">
            {folders.map((f) => (
              <CommandItem
                key={f.id}
                value={`folder ${f.name}`}
                onSelect={() => {
                  onJumpToFolder(f.id);
                  onOpenChange(false);
                }}
              >
                <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{f.name}</span>
                <span className="ml-2 max-w-[20ch] truncate text-xs text-muted-foreground">
                  {f.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        // Only files for the current query: a batch computed for an earlier
        // query stays in state (its new search is still in flight) but must
        // not be rendered or selectable in the meantime.
        {resultsQuery === query && results.length > 0 && (
          <CommandGroup heading="Files">
            {results.map((r) => (
              <CommandItem
                key={r.absolute_path}
                value={`${r.folder_name}/${r.relative_path}`}
                onSelect={() => {
                  onOpenChange(false);
                  onOpenFile(r.absolute_path);
                }}
              >
                <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 truncate">
                  <div className="truncate font-medium">{r.relative_path.split("/").pop()}</div>
                  <div className="truncate text-xs text-muted-foreground">{r.relative_path}</div>
                </div>
                <Badge variant="secondary" className="ml-2 shrink-0">{r.folder_name}</Badge>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
