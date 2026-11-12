import * as React from "react";
import { tauri, onHighlightsFlushRequest } from "@/lib/tauri";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { notifyApp } from "@/components/Notifications";
import {
  DEFAULT_COLOUR,
  HIGHLIGHT_COLOURS,
  MAX_NOTE_LENGTH,
  MAX_HIGHLIGHTS_PER_FILE,
  hexToBytes16,
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

/**
 * Per-path load state. Replaces the old module-level `loadedPaths` set, which
 * marked a path "loaded" the instant a fetch was *requested* (so a failed or
 * still-pending fetch let mutations through, and a late fetch could clobber
 * local state). A path is only "loaded" once its read has actually landed.
 */
export type HighlightLoadStatus = "unloaded" | "loading" | "loaded" | "failed";

interface Ctx {
  /** Colour applied when the user picks a swatch-less action; persisted. */
  activeColour: HighlightColour;
  setActiveColour: (c: HighlightColour) => void;
  /** Whether the right-side review panel is open; persisted. */
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  /**
   * v2 highlights keyed by the document's absolute path. A key holds the
   * loaded list (possibly empty); a path that has never been loaded is
   * absent.
   */
  byFile: Record<string, Highlight[]>;
  /**
   * The per-installation 128-bit key (16 bytes) used to fingerprint passage
   * windows, or null until it is loaded (and always null outside Tauri, e.g.
   * in tests). Anchoring/relocation are disabled until this is non-null.
   */
  highlightsKey: Uint8Array | null;
  /** Load one document's highlights from disk. Re-fetches from "unloaded"/"failed". */
  loadFile: (path: string) => void;
  /** Load status for a path; "unloaded" if never requested. */
  getLoadStatus: (path: string) => HighlightLoadStatus;
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
  /**
   * Flush every pending (dirty) save, awaiting in-flight ones. Called before
   * a confirmed window close and, fire-and-forget, on unmount.
   */
  flush: () => Promise<void>;
}

const HighlightsContext = React.createContext<Ctx | null>(null);

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

function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function HighlightsProvider({ children }: { children: React.ReactNode }) {
  const [activeColour, setActiveColour] = React.useState<HighlightColour>(loadActive);
  const [panelOpen, setPanelOpen] = React.useState<boolean>(loadPanel);
  const [byFile, setByFile] = React.useState<Record<string, Highlight[]>>({});
  const [lastDeleted, setLastDeleted] = React.useState<LastDeleted | null>(null);
  const [highlightsKey, setHighlightsKey] = React.useState<Uint8Array | null>(null);

  // Mirror of byFile for the writer, which must read the state as it stands
  // when it fires (possibly several mutations in).
  const byFileRef = React.useRef<Record<string, Highlight[]>>({});
  byFileRef.current = byFile;

  // Per-path load status (ref: not render-driving, read by gating checks).
  const loadStatusRef = React.useRef<Map<string, HighlightLoadStatus>>(new Map());
  const saveTimersRef = React.useRef<Map<string, number>>(new Map());
  const inflightRef = React.useRef<Map<string, Promise<void>>>(new Map());
  // One serialized writer per path: `gen` bumps on every mutation; `sent` is
  // the generation last successfully persisted; `notified` keeps a failure
  // streak to one notification. A path is pending while `sent < gen`.
  const writerStateRef = React.useRef<Map<string, { gen: number; sent: number; notified: boolean }>>(new Map());
  const undoTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    localStorage.setItem(ACTIVE_COLOUR_KEY, activeColour);
  }, [activeColour]);

  React.useEffect(() => {
    localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "true" : "false");
  }, [panelOpen]);

  // Load the per-installation key once (Tauri only). Anchoring/relocation are
  // gated on this, so it must resolve before any highlight can be created or
  // resolved; a failure leaves it null and anchoring stays disabled.
  React.useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    tauri
      .getHighlightsKey()
      .then((hex) => {
        if (cancelled) return;
        const key = hexToBytes16(hex);
        if (key) setHighlightsKey(key);
      })
      .catch((err) => {
        if (!cancelled) console.error("failed to load the highlights key", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Saving (S1: one serialized writer per path) ----------------------

  // One writer per path, driven by a generation counter. A mutation bumps the
  // path's generation and resets the debounce; the writer persists the
  // *current* snapshot, records the generation it sent, and loops while the
  // generation moves on, so a mutation landing mid-save is never lost to a
  // stale in-flight snapshot (F9). A failure leaves the path pending (the
  // generation is not marked sent) and is retried by the next mutation or a
  // flush, notifying at most once per failure streak.
  const runWriter = React.useCallback((path: string): Promise<void> => {
    const existing = inflightRef.current.get(path);
    if (existing) return existing; // a writer for this path is already running

    const promise: Promise<void> = (async () => {
      for (;;) {
        const st = writerStateRef.current.get(path);
        if (!st || st.sent === st.gen) break; // clean
        const items = byFileRef.current[path];
        if (items === undefined) {
          // No list to persist (never landed a load); nothing to save.
          st.sent = st.gen;
          break;
        }
        // The whole list for this path goes to the backend; its
        // `save_highlights` is a read-modify-write serialized process-wide, so
        // concurrent saves from different documents cannot lose each other.
        // An empty list is a real write (it deletes the path's highlights).
        const sentGen = st.gen;
        try {
          await tauri.saveHighlights(path, items);
        } catch (err) {
          // Keep the path pending: do not advance `sent`, so the next
          // mutation or a flush retries it. Notify once per failure streak.
          if (!st.notified) {
            st.notified = true;
            notifyApp(
              `Couldn't save highlights for ${basenameOf(path)}. Will retry on the next change or when you close the window.`,
            );
            console.error("failed to save highlights", err);
          }
          break;
        }
        st.sent = sentGen;
        st.notified = false;
        // If the generation moved while we were in flight, loop and send the
        // newest snapshot; otherwise the loop's next check breaks.
      }
      inflightRef.current.delete(path);
    })();
    inflightRef.current.set(path, promise);
    return promise;
  }, []);

  const runWriterRef = React.useRef(runWriter);
  runWriterRef.current = runWriter;

  const scheduleSave = React.useCallback((path: string) => {
    const st = writerStateRef.current.get(path);
    if (!st) writerStateRef.current.set(path, { gen: 0, sent: 0, notified: false });
    const s = writerStateRef.current.get(path)!;
    s.gen += 1; // a new mutation: the path is pending until the writer catches up
    s.notified = false;
    const timers = saveTimersRef.current;
    const existing = timers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.set(
      path,
      window.setTimeout(() => {
        timers.delete(path);
        if (runWriterRef.current) void runWriterRef.current(path);
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);

  const flush = React.useCallback(async (): Promise<void> => {
    // Cancel pending debounce timers; we save immediately from here.
    const timers = saveTimersRef.current;
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    // Only paths with a pending generation (sent < gen) have anything to
    // persist. A loaded-but-never-mutated path already matches disk; a path
    // with no list is skipped by the writer. Await each writer until it is
    // clean or fails.
    const promises: Promise<void>[] = [];
    for (const [p, st] of writerStateRef.current) {
      if (st.sent !== st.gen) promises.push(runWriter(p));
    }
    await Promise.all(promises);
  }, [runWriter]);

  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  // --- Loading (F3) ----------------------------------------------------

  const loadFile = React.useCallback((path: string) => {
    const status = loadStatusRef.current.get(path);
    // Idempotent while loaded or already in flight; re-fetch from
    // "unloaded" or a previously-"failed" read (the retry path).
    if (status === "loaded" || status === "loading") return;
    loadStatusRef.current.set(path, "loading");
    tauri
      .getHighlights(path)
      .then((result) => {
        loadStatusRef.current.set(path, "loaded");
        setByFile((prev) => {
          // A mutation can only set this key once the path is "loaded", so
          // this is the first writer; keep any pre-existing value as a guard.
          if (prev[path] !== undefined) return prev;
          // An empty result keeps the key absent (no highlights on this path).
          if (result.highlights.length === 0) return prev;
          return { ...prev, [path]: result.highlights };
        });
      })
      .catch((err) => {
        // A failed load stays "failed" (retriable), never "loaded": the
        // caller must not anchor/relayout against an empty list it actually
        // failed to read.
        loadStatusRef.current.set(path, "failed");
        notifyApp(`Couldn't load highlights for ${basenameOf(path)}. They'll be retried when you open it again.`);
        console.error("failed to load highlights", err);
      });
  }, []);

  const getLoadStatus = React.useCallback(
    (path: string): HighlightLoadStatus => loadStatusRef.current.get(path) ?? "unloaded",
    [],
  );

  // Gate: mutations are refused until the path's load has actually landed
  // (and the key, for anchoring, is available). Creation is disabled while a
  // load is pending so a late fetch can never clobber local state.
  const isMutable = (path: string): boolean => loadStatusRef.current.get(path) === "loaded";

  // --- Mutations -------------------------------------------------------

  const addHighlight = React.useCallback(
    (path: string, h: Highlight) => {
      if (!isMutable(path)) return;
      const list = byFileRef.current[path] ?? [];
      if (list.length >= MAX_HIGHLIGHTS_PER_FILE) {
        notifyApp(
          `Can't add more highlights to ${basenameOf(path)} (the ${MAX_HIGHLIGHTS_PER_FILE}-per-file limit is reached).`,
        );
        return;
      }
      if ((h.note?.length ?? 0) > MAX_NOTE_LENGTH) {
        notifyApp(`Notes are limited to ${MAX_NOTE_LENGTH} characters.`);
        return;
      }
      setByFile((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), h] }));
      scheduleSave(path);
    },
    [scheduleSave],
  );

  const updateHighlight = React.useCallback(
    (path: string, id: string, patch: Partial<Pick<Highlight, "colour" | "note">>) => {
      if (!isMutable(path)) return;
      const items = byFileRef.current[path] ?? [];
      if (!items.some((h) => h.id === id)) return;
      if ((patch.note?.length ?? 0) > MAX_NOTE_LENGTH) {
        notifyApp(`Notes are limited to ${MAX_NOTE_LENGTH} characters.`);
        return;
      }
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
      if (!isMutable(path)) return;
      const items = byFileRef.current[path] ?? [];
      const removed = items.find((h) => h.id === id);
      if (!removed) return;
      setByFile((prev) => {
        const next = { ...prev };
        // Keep an *empty* list when the last one is removed (F1): the writer
        // must still issue `save_highlights(path, [])` so the deletion is
        // persisted; an absent key would be skipped by the writer.
        next[path] = (prev[path] ?? []).filter((h) => h.id !== id);
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
    if (!isMutable(path)) return;
    const restored: Highlight = { ...highlight, updatedAt: new Date().toISOString() };
    setByFile((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), restored] }));
    setLastDeleted(null);
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    scheduleSave(path);
  }, [lastDeleted, scheduleSave]);

  // --- Close / unmount flushing (F7) -----------------------------------

  // On unmount, fire any pending saves (fire-and-forget; a synchronous unmount
  // cannot await). The close-flush below is the awaited version for window
  // close.
  React.useEffect(() => {
    const timers = saveTimersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
      for (const [p, st] of writerStateRef.current) {
        if (st.sent !== st.gen && byFileRef.current[p] !== undefined) {
          void runWriterRef.current(p).catch(() => {});
        }
      }
    };
  }, []);

  // Intercept the main window's first close request (Rust emits this after
  // `api.prevent_close()` and before its 2-second fallback destroy). Await the
  // flush, then let the close through. A failed flush must not trap the close.
  React.useEffect(() => {
    if (!inTauri()) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    onHighlightsFlushRequest(() => {
      if (disposed) return;
      void (async () => {
        try {
          await flushRef.current?.();
        } catch {
          // a failed flush must not block the close
        }
        try {
          await tauri.confirmClose();
        } catch {
          // the Rust 2s fallback destroys the window either way
        }
      })();
    })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const value = React.useMemo<Ctx>(
    () => ({
      activeColour,
      setActiveColour,
      panelOpen,
      setPanelOpen,
      byFile,
      highlightsKey,
      loadFile,
      getLoadStatus,
      addHighlight,
      updateHighlight,
      removeHighlight,
      lastDeleted,
      undoDelete,
      flush,
    }),
    [
      activeColour,
      panelOpen,
      byFile,
      highlightsKey,
      lastDeleted,
      loadFile,
      getLoadStatus,
      addHighlight,
      updateHighlight,
      removeHighlight,
      undoDelete,
      flush,
    ],
  );

  return <HighlightsContext.Provider value={value}>{children}</HighlightsContext.Provider>;
}

export function useHighlights(): Ctx {
  const ctx = React.useContext(HighlightsContext);
  if (!ctx) throw new Error("useHighlights must be used within HighlightsProvider");
  return ctx;
}
