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
   * Persist every path not yet saved and wait for every save queue to drain,
   * re-checking until every path is on disk or a pass makes no progress.
   * Resolves `{ ok }`: `true` when everything was saved, `false` when a save
   * kept failing (the window close is then cancelled, not forced). Called on
   * a window-close flush request and, fire-and-forget, on unmount.
   */
  flush: () => Promise<{ ok: boolean }>;
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

/**
 * Save state for one document path. `gen` bumps on every mutation, `sent` is
 * the newest generation known to be on disk, `tail` is the end of the path's
 * save queue, and `notified` limits a failure streak to one notification.
 */
interface PathWriter {
  gen: number;
  sent: number;
  notified: boolean;
  tail: Promise<void>;
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

  // The authoritative highlights state. Every change goes through `commit`,
  // which updates this ref synchronously and then React state, so a save
  // queued right after a mutation always reads the list that includes it.
  const byFileRef = React.useRef<Record<string, Highlight[]>>({});
  const commit = React.useCallback((next: Record<string, Highlight[]>) => {
    byFileRef.current = next;
    setByFile(next);
  }, []);

  // Per-path load status (ref: not render-driving, read by gating checks).
  const loadStatusRef = React.useRef<Map<string, HighlightLoadStatus>>(new Map());
  const writersRef = React.useRef<Map<string, PathWriter>>(new Map());
  const undoTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    localStorage.setItem(ACTIVE_COLOUR_KEY, activeColour);
  }, [activeColour]);

  React.useEffect(() => {
    localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "true" : "false");
  }, [panelOpen]);

  // Load the per-installation key (Tauri only). Anchoring/relocation are
  // gated on this, so it must resolve before a highlight can be anchored; a
  // failed read (a rejection, or a value that is not 32 hex digits) leaves it
  // null and anchoring stays disabled. `fetchKey` is self-guarded: it only
  // actually calls `getHighlightsKey` while the key is not yet available and
  // no read is in flight, so it is cheap and idempotent. It is called once on
  // mount and retried on every `loadFile`, so a transient failure — or a key
  // created after first launch — recovers without a restart. A failure is
  // reported at most once per streak (reset on a successful read), mirroring
  // the save-failure notification pattern above.
  const keyAvailableRef = React.useRef(false);
  const keyInFlightRef = React.useRef(false);
  const keyNotifiedRef = React.useRef(false);
  const fetchKey = React.useCallback(() => {
    if (!inTauri()) return;
    if (keyAvailableRef.current || keyInFlightRef.current) return;
    keyInFlightRef.current = true;
    tauri
      .getHighlightsKey()
      .then((hex) => {
        const key = hexToBytes16(hex);
        if (key) {
          keyAvailableRef.current = true;
          keyNotifiedRef.current = false;
          setHighlightsKey(key);
        } else if (!keyNotifiedRef.current) {
          keyNotifiedRef.current = true;
          notifyApp("Highlights are unavailable: the highlights key could not be read.");
        }
      })
      .catch((err) => {
        if (!keyNotifiedRef.current) {
          keyNotifiedRef.current = true;
          notifyApp("Highlights are unavailable: the highlights key could not be read.");
          console.error("failed to load the highlights key", err);
        }
      })
      .finally(() => {
        keyInFlightRef.current = false;
      });
  }, []);

  React.useEffect(() => {
    fetchKey();
  }, [fetchKey]);

  // --- Saving: one save queue per path ---------------------------------
  //
  // Every mutation bumps the path's generation and appends one save to the
  // path's queue (a promise chain). A queued save sends the path's current
  // list only if its generation is newer than the last one persisted, so a
  // burst of mutations coalesces into at most one save per in-flight period,
  // and an edit made during a save is sent by the save queued behind it.
  // There are no timers and nothing to register or unregister: the queue
  // tail is replaced synchronously, before any queued work can run. A failed
  // save leaves the generation unsent; the next mutation or a flush retries
  // it, with one notification per failure streak.

  const writerFor = React.useCallback((path: string): PathWriter => {
    let w = writersRef.current.get(path);
    if (!w) {
      w = { gen: 0, sent: 0, notified: false, tail: Promise.resolve() };
      writersRef.current.set(path, w);
    }
    return w;
  }, []);

  const saveIfNewer = React.useCallback(async (path: string, w: PathWriter): Promise<void> => {
    if (w.sent >= w.gen) return;
    const items = byFileRef.current[path];
    if (items === undefined) {
      // No list for this path (never loaded): nothing to persist.
      w.sent = w.gen;
      return;
    }
    const gen = w.gen;
    try {
      // The whole list goes to the backend; an empty list is a real write
      // (it deletes the path's highlights).
      await tauri.saveHighlights(path, items);
    } catch (err) {
      if (!w.notified) {
        w.notified = true;
        notifyApp(
          `Couldn't save highlights for ${basenameOf(path)}. Will retry on the next change or when you close the window.`,
        );
        console.error("failed to save highlights", err);
      }
      return;
    }
    w.sent = Math.max(w.sent, gen);
    w.notified = false;
  }, []);

  /** Append one save to the path's queue; resolves when it has run. Never rejects. */
  const enqueueSave = React.useCallback(
    (path: string): Promise<void> => {
      const w = writerFor(path);
      w.tail = w.tail.then(() => saveIfNewer(path, w)).catch(() => {});
      return w.tail;
    },
    [writerFor, saveIfNewer],
  );

  const markChanged = React.useCallback(
    (path: string) => {
      writerFor(path).gen += 1;
      void enqueueSave(path);
    },
    [writerFor, enqueueSave],
  );

  const flush = React.useCallback(async (): Promise<{ ok: boolean }> => {
    // Queue one save behind every path that is not yet persisted (this also
    // retries failed ones) and wait for every queue to drain. Then re-check:
    // a path can be edited while we wait (bumping its `gen`), or a save can
    // fail, so we loop until every path has `sent === gen` (ok) or a whole
    // pass makes no progress (ok:false — a save that keeps failing). The
    // iteration cap is a defensive bound for a pathological stream of edits
    // during the flush; in practice a close means no new edits arrive.
    for (let pass = 0; ; pass++) {
      const before = new Map<string, number>();
      const tails: Promise<void>[] = [];
      for (const [path, w] of writersRef.current) {
        before.set(path, w.sent);
        tails.push(w.sent < w.gen ? enqueueSave(path) : w.tail);
      }
      await Promise.all(tails);
      const allSent = [...writersRef.current.values()].every((w) => w.sent === w.gen);
      if (allSent) return { ok: true };
      const progress = [...writersRef.current.entries()].some(
        ([path, w]) => w.sent > (before.get(path) ?? 0),
      );
      if (!progress || pass > 16) return { ok: false };
    }
  }, [enqueueSave]);

  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  // --- Loading (F3) ----------------------------------------------------

  const loadFile = React.useCallback((path: string) => {
    // Retry the per-installation key if it is still unavailable (it gates
    // anchoring). `fetchKey` is self-guarded — a no-op once the key has
    // landed — so this costs nothing on the common path.
    fetchKey();
    const status = loadStatusRef.current.get(path);
    // Idempotent while loaded or already in flight; re-fetch from
    // "unloaded" or a previously-"failed" read (the retry path).
    if (status === "loaded" || status === "loading") return;
    loadStatusRef.current.set(path, "loading");
    tauri
      .getHighlights(path)
      .then((result) => {
        loadStatusRef.current.set(path, "loaded");
        const prev = byFileRef.current;
        // A mutation can only set this key once the path is "loaded", so this
        // is the first writer; keep any pre-existing value as a guard. An
        // empty result keeps the key absent (no highlights on this path).
        if (prev[path] !== undefined || result.highlights.length === 0) return;
        commit({ ...prev, [path]: result.highlights });
      })
      .catch((err) => {
        // A failed load stays "failed" (retriable), never "loaded": the
        // caller must not anchor/relayout against an empty list it actually
        // failed to read.
        loadStatusRef.current.set(path, "failed");
        notifyApp(`Couldn't load highlights for ${basenameOf(path)}. They'll be retried when you open it again.`);
        console.error("failed to load highlights", err);
      });
  }, [commit, fetchKey]);

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
      commit({ ...byFileRef.current, [path]: [...list, h] });
      markChanged(path);
    },
    [commit, markChanged],
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
      commit({
        ...byFileRef.current,
        [path]: items.map((h) =>
          h.id === id ? { ...h, ...patch, updatedAt: new Date().toISOString() } : h,
        ),
      });
      markChanged(path);
    },
    [commit, markChanged],
  );

  const removeHighlight = React.useCallback(
    (path: string, id: string) => {
      if (!isMutable(path)) return;
      const items = byFileRef.current[path] ?? [];
      const removed = items.find((h) => h.id === id);
      if (!removed) return;
      // Keep an *empty* list when the last one is removed (F1): the save
      // must still issue `save_highlights(path, [])` so the deletion is
      // persisted; an absent key would be skipped.
      commit({ ...byFileRef.current, [path]: items.filter((h) => h.id !== id) });
      setLastDeleted({ path, highlight: removed });
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => {
        undoTimerRef.current = null;
        setLastDeleted(null);
      }, UNDO_WINDOW_MS);
      markChanged(path);
    },
    [commit, markChanged],
  );

  const undoDelete = React.useCallback(() => {
    if (!lastDeleted) return;
    const { path, highlight } = lastDeleted;
    if (!isMutable(path)) return;
    // Restoring a deleted highlight is an addition: it must not push the
    // file past its limit (a new highlight added while the undo window ran
    // can fill the last slot). Refuse with the same notification as
    // `addHighlight` and keep `lastDeleted` (and its timer), so the user
    // can retry after the blocking highlight is removed.
    const list = byFileRef.current[path] ?? [];
    if (list.length >= MAX_HIGHLIGHTS_PER_FILE) {
      notifyApp(
        `Can't add more highlights to ${basenameOf(path)} (the ${MAX_HIGHLIGHTS_PER_FILE}-per-file limit is reached).`,
      );
      return;
    }
    const restored: Highlight = { ...highlight, updatedAt: new Date().toISOString() };
    commit({ ...byFileRef.current, [path]: [...(byFileRef.current[path] ?? []), restored] });
    setLastDeleted(null);
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    markChanged(path);
  }, [lastDeleted, commit, markChanged]);

  // --- Close / unmount flushing (F7) -----------------------------------

  // On unmount, retry anything not yet persisted (fire-and-forget; a
  // synchronous unmount cannot await). The close-flush below is the awaited
  // version for window close.
  React.useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
      void flushRef.current();
    };
  }, []);

  // Intercept the main window's first close request. Rust emits this right
  // after `api.prevent_close()`. We acknowledge it immediately (so Rust drops
  // its 2-second "frontend dead" fallback and starts a 30-second ceiling),
  // then flush: on success we confirm the close (Rust destroys the window);
  // on failure we cancel it (the window stays open; `attempted` stays set on
  // Rust, so closing again closes for real) and tell the user to close again.
  React.useEffect(() => {
    if (!inTauri()) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    onHighlightsFlushRequest(() => {
      if (disposed) return;
      void (async () => {
        try {
          await tauri.ackCloseRequest();
        } catch {
          // the ack failed: Rust's 2-second fallback will destroy the window
        }
        const { ok } = (await flushRef.current?.()) ?? { ok: false };
        if (ok) {
          try {
            await tauri.confirmClose();
          } catch {
            // the 30-second ceiling destroys the window either way
          }
        } else {
          try {
            await tauri.cancelClose();
          } catch {
            // the 30-second ceiling destroys the window either way
          }
          notifyApp("Couldn't save highlights. Close the window again to close without saving.");
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
