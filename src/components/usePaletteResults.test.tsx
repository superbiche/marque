import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AsyncPaletteSource, PaletteItem, PaletteSource } from "@/lib/paletteSources";
import { usePaletteResults, type PaletteGroup } from "./usePaletteResults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (label: string): PaletteItem => ({
  key: label,
  value: label,
  render: () => label,
  onSelect: () => {},
});

/** A summary of the groups a render produced: `heading: label, label`. */
const summary = (groups: PaletteGroup[]) =>
  groups
    .filter((g) => g.items.length > 0)
    .map((g) => `${g.source.heading}: ${g.items.map((i) => i.value).join(", ")}`);

/**
 * An async source whose calls the test resolves or rejects by hand, one
 * pending call per query.
 */
function controlled(id: string, debounceMs = 0) {
  const calls = new Map<
    string,
    { resolve: (items: PaletteItem[]) => void; reject: (e: unknown) => void; signal: AbortSignal }
  >();
  let count = 0;
  const source: AsyncPaletteSource = {
    kind: "async",
    id,
    heading: id,
    debounceMs,
    search: (query, signal) => {
      count++;
      return new Promise<PaletteItem[]>((resolve, reject) => {
        calls.set(query, { resolve, reject, signal });
      });
    },
  };
  return { source, calls, count: () => count };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let container: HTMLDivElement;
let root: Root;
let rendered: PaletteGroup[][];
let queries: string[];

function Harness(props: { sources: readonly PaletteSource[]; query: string; open?: boolean }) {
  rendered.push(usePaletteResults(props.sources, props.query, props.open ?? true));
  queries.push(props.query);
  return null;
}

async function render(sources: readonly PaletteSource[], query: string, open = true) {
  await act(async () => {
    root.render(<Harness sources={sources} query={query} open={open} />);
  });
}

/** Let debounce timers fire and settled promises flush, inside act(). */
async function settle(ms = 5) {
  await act(async () => {
    await sleep(ms);
  });
}

const latest = () => summary(rendered[rendered.length - 1]);

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  rendered = [];
  queries = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("usePaletteResults", () => {
  it("answers a sync source for the current query on the same render", async () => {
    const sync: PaletteSource = {
      kind: "sync",
      id: "echo",
      heading: "Echo",
      search: (q) => [item(`echo:${q}`)],
    };
    await render([sync], "a");
    await render([sync], "ab");
    // Every render's sync items belong to the query it rendered with.
    expect(queries.length).toBeGreaterThanOrEqual(2);
    rendered.forEach((groups, i) => {
      expect(summary(groups)).toEqual([`Echo: echo:${queries[i]}`]);
    });
    expect(latest()).toEqual(["Echo: echo:ab"]);
  });

  it("never exposes an async result computed for an earlier query", async () => {
    const files = controlled("Files");
    await render([files.source], "a");
    await settle();
    expect(files.calls.has("a")).toBe(true);

    await render([files.source], "ab");
    await settle();
    // The earlier query's call resolves late: nothing is shown for it.
    await act(async () => files.calls.get("a")!.resolve([item("stale")]));
    expect(rendered.slice(-1).flatMap(summary)).toEqual([]);

    await act(async () => files.calls.get("ab")!.resolve([item("fresh")]));
    expect(latest()).toEqual(["Files: fresh"]);
  });

  it("hides the previous query's answer while the new query's search is in flight", async () => {
    const files = controlled("Files");
    await render([files.source], "a");
    await settle();
    await act(async () => files.calls.get("a")!.resolve([item("for-a")]));
    expect(latest()).toEqual(["Files: for-a"]);

    await render([files.source], "ab");
    expect(latest()).toEqual([]);
    await settle();
    expect(latest()).toEqual([]);
    await act(async () => files.calls.get("ab")!.resolve([item("for-ab")]));
    expect(latest()).toEqual(["Files: for-ab"]);
  });

  it("keeps the current answer when a superseded call resolves after it", async () => {
    const files = controlled("Files");
    await render([files.source], "a");
    await settle();
    await render([files.source], "ab");
    await settle();
    await act(async () => files.calls.get("ab")!.resolve([item("fresh")]));
    await act(async () => files.calls.get("a")!.resolve([item("stale")]));
    expect(latest()).toEqual(["Files: fresh"]);
  });

  it("aborts a superseded call's signal", async () => {
    const files = controlled("Files");
    await render([files.source], "a");
    await settle();
    const first = files.calls.get("a")!.signal;
    expect(first.aborted).toBe(false);
    await render([files.source], "ab");
    expect(first.aborted).toBe(true);
    await settle();
    expect(files.calls.get("ab")!.signal.aborted).toBe(false);
  });

  it("hides a rejecting source's group without affecting the others", async () => {
    const broken = controlled("Broken");
    const files = controlled("Files");
    const sync: PaletteSource = { kind: "sync", id: "s", heading: "Sync", search: () => [item("s1")] };
    const throwing: PaletteSource = {
      kind: "sync",
      id: "t",
      heading: "Throws",
      search: () => {
        throw new Error("boom");
      },
    };
    await render([sync, throwing, broken.source, files.source], "q");
    await settle();
    await act(async () => broken.calls.get("q")!.reject(new Error("rust said no")));
    await act(async () => files.calls.get("q")!.resolve([item("f1")]));
    expect(latest()).toEqual(["Sync: s1", "Files: f1"]);
  });

  it("renders an added source's group in source order with no runner change", async () => {
    const a = controlled("A");
    const b = controlled("B");
    const headings: PaletteSource = {
      kind: "sync",
      id: "headings",
      heading: "Headings",
      search: (q) => (q ? [item(`h:${q}`)] : []),
    };
    await render([a.source, headings, b.source], "x");
    await settle();
    await act(async () => b.calls.get("x")!.resolve([item("b1")]));
    await act(async () => a.calls.get("x")!.resolve([item("a1")]));
    expect(latest()).toEqual(["A: a1", "Headings: h:x", "B: b1"]);
  });

  it("does not restart an async search when a parent re-render rebuilds the source", async () => {
    const files = controlled("Files", 0);
    // A new source object with the same id, as a parent render would build.
    const rebuilt = (): AsyncPaletteSource => ({ ...files.source });
    await render([rebuilt()], "q");
    await settle();
    expect(files.count()).toBe(1);
    // Parent renders while the search is in flight.
    for (let i = 0; i < 3; i++) await render([rebuilt()], "q");
    await settle();
    expect(files.count()).toBe(1);
    expect(files.calls.get("q")!.signal.aborted).toBe(false);
    await act(async () => files.calls.get("q")!.resolve([item("f1")]));
    expect(latest()).toEqual(["Files: f1"]);
  });

  it("waits for the debounce, and runs nothing while closed", async () => {
    const files = controlled("Files", 25);
    await render([files.source], "q", false);
    await settle(40);
    expect(files.count()).toBe(0);

    await render([files.source], "q", true);
    await settle(5);
    expect(files.count()).toBe(0);
    await settle(40);
    expect(files.count()).toBe(1);
  });
});
