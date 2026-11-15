/**
 * The command palette's source contract.
 *
 * The palette (`CommandPalette.tsx`) knows nothing about what it lists: it
 * renders one group per source, in the order the sources are given, and
 * `usePaletteResults` runs their searches. Adding a source (say, headings of
 * the current file) means writing one more `PaletteSource`, not editing the
 * palette.
 *
 * Each source owns its ranking: the palette runs cmdk with
 * `shouldFilter: false`, so items are shown in the order a source returns
 * them. A source returns `[]` to hide its group (e.g. "Jump to Folder" for a
 * non-empty query).
 */
import type { ReactNode } from "react";

/** One selectable row of a palette group. */
export interface PaletteItem {
  /** React key, unique within its source. */
  key: string;
  /** cmdk value; must be unique across every source shown at once. */
  value: string;
  /** Row content (icon, label, secondary text). */
  render: () => ReactNode;
  /** Runs on selection; it closes the palette itself when it should. */
  onSelect: () => void;
}

interface PaletteSourceBase {
  /** Stable and unique among the palette's sources. */
  id: string;
  /** Group heading. */
  heading: string;
}

/**
 * A source answered in memory. It is searched during render, so its group
 * always matches the current query.
 */
export interface SyncPaletteSource extends PaletteSourceBase {
  kind: "sync";
  search: (query: string) => PaletteItem[];
}

/**
 * A source answered elsewhere (e.g. Rust). It is searched `debounceMs` after
 * the query settles; a superseded search has its `signal` aborted and its
 * result dropped, and a rejection hides the group. Its group is shown only
 * once a result for the current query has arrived.
 */
export interface AsyncPaletteSource extends PaletteSourceBase {
  kind: "async";
  debounceMs: number;
  search: (query: string, signal: AbortSignal) => Promise<PaletteItem[]>;
}

export type PaletteSource = SyncPaletteSource | AsyncPaletteSource;
