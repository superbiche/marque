import { useEffect, useRef, useState } from "react";
import type { PaletteItem, PaletteSource } from "@/lib/paletteSources";

export interface PaletteGroup {
  source: PaletteSource;
  items: PaletteItem[];
}

/** An async source's latest result, tagged with the query it answers. */
interface Answered {
  query: string;
  items: PaletteItem[];
}

/**
 * Run the palette's sources for `query` and return one group per source, in
 * source order.
 *
 * This is the one place that keeps results and queries together: a sync
 * source is searched during render, and an async source's result is exposed
 * only while the query it was computed for is still the current one. A batch
 * for an earlier query (its successor still in flight) is neither shown nor
 * selectable.
 *
 * Async searches restart when the query, `open` or the set of async source
 * ids changes, not when a source object is merely rebuilt by a parent render:
 * the latest source objects are read through a ref when the debounce fires.
 */
export function usePaletteResults(
  sources: readonly PaletteSource[],
  query: string,
  open: boolean,
): PaletteGroup[] {
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const sourcesRef = useRef(sources);
  // Declared before the search effect, so it runs first after each commit.
  useEffect(() => {
    sourcesRef.current = sources;
  });

  const asyncIds = sources
    .filter((s) => s.kind === "async")
    .map((s) => s.id)
    .join("\n");

  useEffect(() => {
    if (!open) return;
    const pending: { controller: AbortController; timer: ReturnType<typeof setTimeout> }[] = [];
    for (const id of asyncIds ? asyncIds.split("\n") : []) {
      const initial = sourcesRef.current.find((s) => s.id === id);
      if (!initial || initial.kind !== "async") continue;
      const controller = new AbortController();
      const record = (items: PaletteItem[]) => {
        if (controller.signal.aborted) return;
        setAnswered((prev) => ({ ...prev, [id]: { query, items } }));
      };
      const timer = setTimeout(() => {
        const source = sourcesRef.current.find((s) => s.id === id);
        if (!source || source.kind !== "async") return;
        let result: Promise<PaletteItem[]>;
        try {
          result = source.search(query, controller.signal);
        } catch {
          record([]);
          return;
        }
        Promise.resolve(result).then(record, () => record([]));
      }, initial.debounceMs);
      pending.push({ controller, timer });
    }
    return () => {
      for (const p of pending) {
        clearTimeout(p.timer);
        p.controller.abort();
      }
    };
  }, [asyncIds, query, open]);

  return sources.map((source) => {
    if (source.kind === "sync") {
      let items: PaletteItem[];
      try {
        items = source.search(query);
      } catch {
        items = [];
      }
      return { source, items };
    }
    const latest = answered[source.id];
    return { source, items: latest && latest.query === query ? latest.items : [] };
  });
}
