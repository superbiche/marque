import * as React from "react";
import { tauri } from "@/lib/tauri";
import {
  DEFAULT_COLOUR,
  HIGHLIGHT_COLOURS,
  type Highlight,
  type HighlightColour,
} from "@/lib/highlights";

const ACTIVE_COLOUR_KEY = "marque:highlights:activeColour";
const PANEL_OPEN_KEY = "marque:highlights:panelOpen";

/** Debounce between a highlight mutation and its `save_highlights` call. */
const SAVE_DEBOUNCE_MS = 300;

/** Window during which a deleted highlight can be restored from the panel. */
export const UNDO_WINDOW_MS = 5000;

export interface LastDeleted {
  path: string;
  highlight: Highlight;
}

interface Ctx {
  /** Colour applied when the user picks a swatch-less action; persisted. */
  activeColour: HighlightColour;
  setActiveColour: (c: HighlightColour) => void;
  /** Whether the right-side review panel is open; persisted. */
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  /**
   * v2 highlights keyed by the document's absolute path. Loaded lazily per
   * path (the backend has no whole-store read in the v2 model); a key is
   * absent for a path with no highlights.
   */
  byFile: Record<string, Highlight[]>;
  /** Load one document's highlights from disk. Idempotent. */
  loadFile: (path: string) => void;
  addHighlight: (path: string, h: Highlight) => void;
  updateHighlight: (
    path: string,
    id: string,
    patch: Partial<Pick<Highlight, "colour" | "note">>,
  ) => void;
  removeHighlight: (path: string, id: string) => void;
  /** The last deleted highlight, or null once the undo window lapses. */
  lastDeleted: LastDeleted | null;
  /** Restore the last deleted highlight (5-second window). */
  undoDelete: () => void;
}

const HighlightsContext = React.createContext<Ctx | null>(null);

/**
 * Paths already requested from the backend. A path stays "loaded" for the
 * session: `get_highlights` is the only v2 read surface and the backend
 * never notifies about highlight changes, so a re-fetch could only ever
 * lose local, not-yet-persisted state.
 */
const loadedPaths = new Set<string>();

function isColour(v: unknown): v is HighlightColour {
  return typeof v === "string" && (HIGHLIGHT_COLOURS as readonly string[]).includes(v);
}

function loadActive(): HighlightColour {
  if (typeof window === "undefined") return DEFAULT_COLOUR;
  const raw = localStorage.getItem(ACTIVE_COLOUR_KEY);
  return isColour(raw) ? raw : DEFAULT_COLOUR;
}

function loadPanel(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(PANEL_OPEN_KEY) === "true";
}

export function HighlightsProvider({ children }: { children: React.ReactNode }) {
  const [activeColour, setActiveColour] = React.useState<HighlightColour>(loadActive);
  const [panelOpen, setPanelOpen] = React.useState<boolean>(loadPanel);
  const [byFile, setByFile] = React.useState<Record<string, Highlight[]>>({});
  const [lastDeleted, setLastDeleted] = React.useState<LastDeleted | null>(null);

  // Mirror of byFile for the debounced writer, which must read the state as
  // it stands when the timer fires (possibly several mutations in).
  const byFileRef = React.useRef<Record<string, Highlight[]>>({});
  byFileRef.current = byFile;

  const saveTimers = React.useRef<Map<string, number>>(new Map());
  const undoTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    localStorage.setItem(ACTIVE_COLOUR_KEY, activeColour);
  }, [activeColour]);

  React.useEffect(() => {
    localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "true" : "false");
  }, [panelOpen]);

  const scheduleSave = React.useCallback((path: string) => {
    const timers = saveTimers.current;
    const existing = timers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.set(
      path,
      window.setTimeout(() => {
        timers.delete(path);
        const items = byFileRef.current[path];
        if (items === undefined) return;
        // The whole list for this path goes to the backend; its
        // `save_highlights` is a read-modify-write serialized process-wide,
        // so rapid saves from different documents cannot lose each other.
        tauri
          .saveHighlights(path, items)
          .catch((err) => console.error("failed to save highlights", err));
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);

  const loadFile = React.useCallback((path: string) => {
    if (loadedPaths.has(path)) return;
    loadedPaths.add(path);
    tauri
      .getHighlights(path)
      .then((result) => {
        if (result.highlights.length === 0) return; // keep the key absent
        setByFile((prev) => {
          // If the user already added highlights here before the read
          // landed, the local state wins (the save carries both).
          if (prev[path] !== undefined) return prev;
          return { ...prev, [path]: result.highlights };
        });
      })
      .catch((err) => console.error("failed to load highlights", err));
  }, []);

  const addHighlight = React.useCallback(
    (path: string, h: Highlight) => {
      setByFile((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), h] }));
      scheduleSave(path);
    },
    [scheduleSave],
  );

  const updateHighlight = React.useCallback(
    (path: string, id: string, patch: Partial<Pick<Highlight, "colour" | "note">>) => {
      const items = byFileRef.current[path] ?? [];
      if (!items.some((h) => h.id === id)) return;
      setByFile((prev) => ({
        ...prev,
        [path]: (prev[path] ?? []).map((h) =>
          h.id === id ? { ...h, ...patch, updatedAt: new Date().toISOString() } : h,
        ),
      }));
      scheduleSave(path);
    },
    [scheduleSave],
  );

  const removeHighlight = React.useCallback(
    (path: string, id: string) => {
      const items = byFileRef.current[path] ?? [];
      const removed = items.find((h) => h.id === id);
      if (!removed) return;
      setByFile((prev) => {
        const next = { ...prev };
        const rest = (prev[path] ?? []).filter((h) => h.id !== id);
        if (rest.length === 0) delete next[path];
        else next[path] = rest;
        return next;
      });
      setLastDeleted({ path, highlight: removed });
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => {
        undoTimerRef.current = null;
        setLastDeleted(null);
      }, UNDO_WINDOW_MS);
      scheduleSave(path);
    },
    [scheduleSave],
  );

  const undoDelete = React.useCallback(() => {
    if (!lastDeleted) return;
    const { path, highlight } = lastDeleted;
    const restored: Highlight = { ...highlight, updatedAt: new Date().toISOString() };
    setByFile((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), restored] }));
    setLastDeleted(null);
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    scheduleSave(path);
  }, [lastDeleted, scheduleSave]);

  const value = React.useMemo<Ctx>(
    () => ({
      activeColour,
      setActiveColour,
      panelOpen,
      setPanelOpen,
      byFile,
      loadFile,
      addHighlight,
      updateHighlight,
      removeHighlight,
      lastDeleted,
      undoDelete,
    }),
    [
      activeColour,
      panelOpen,
      byFile,
      lastDeleted,
      loadFile,
      addHighlight,
      updateHighlight,
      removeHighlight,
      undoDelete,
    ],
  );

  return <HighlightsContext.Provider value={value}>{children}</HighlightsContext.Provider>;
}

export function useHighlights(): Ctx {
  const ctx = React.useContext(HighlightsContext);
  if (!ctx) throw new Error("useHighlights must be used within HighlightsProvider");
  return ctx;
}
