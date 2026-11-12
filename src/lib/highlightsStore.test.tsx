/**
 * Store-level tests for the highlights store (marky PR #9 repair round 1).
 *
 * Covers the store-side behaviour of the findings:
 * - F1: deleting the last highlight of a document persists `[]` for its path.
 * - F3: mutations are gated on the load having actually landed (pending and
 *   failed loads both refuse; a failed load is retried on the next load).
 * - F6: the per-note and per-file limits are enforced before the mutation.
 * - F7: `flush()` saves every stored path (dirty or clean) and the
 *   close-request flow awaits the flush before letting the close through —
 *   including when the save fails.
 * - F2: the one-shot load of the per-installation key (Tauri side of the
 *   keyed fingerprints).
 *
 * The Tauri boundary is mocked (`@/lib/tauri`) and the notification surface
 * is mocked (`@/components/Notifications`); the provider is mounted with
 * react-dom/client + React.act under happy-dom. `window.__TAURI_INTERNALS__`
 * is defined before the store module runs, so the Tauri-only effects (the
 * one-shot key load and the close-flush listener) run here too.
 *
 * The store's timers are the happy-dom window's own `window.setTimeout`,
 * which vitest's fake timers do not replace (the environment installs bound
 * copies on the global), so these tests wait on real time — the save
 * debounce is 300 ms.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightsProvider, useHighlights } from "@/lib/highlightsStore";
import { MAX_HIGHLIGHTS_PER_FILE, MAX_NOTE_LENGTH, type Highlight } from "@/lib/highlights";

const m = vi.hoisted(() => {
  // The Tauri marker, defined before the store module evaluates: its
  // Tauri-only effects (one-shot key load, close-flush listener) run when it
  // is present.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // React 19's act() requires this flag.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const flushListeners: Array<() => void> = [];
  return {
    flushListeners,
    getHighlights: vi.fn(),
    saveHighlights: vi.fn(),
    getHighlightsKey: vi.fn(),
    confirmClose: vi.fn(),
    notifyApp: vi.fn(),
    onHighlightsFlushRequest: (cb: () => void) => {
      flushListeners.push(cb);
      return Promise.resolve(() => {});
    },
  };
});

vi.mock("@/lib/tauri", () => ({
  tauri: {
    getHighlights: (path: string) => m.getHighlights(path),
    saveHighlights: (path: string, highlights: unknown) => m.saveHighlights(path, highlights),
    getHighlightsKey: () => m.getHighlightsKey(),
    confirmClose: () => m.confirmClose(),
  },
  onHighlightsFlushRequest: (cb: () => void) => m.onHighlightsFlushRequest(cb),
}));

vi.mock("@/components/Notifications", () => ({
  notifyApp: (message: string) => m.notifyApp(message),
}));

type Store = ReturnType<typeof useHighlights>;

/** A valid 32-hex key: bytes 0x00..0x0f. */
const KEY_HEX = "000102030405060708090a0b0c0d0e0f";

const A = "/docs/a.md";
const B = "/docs/b.md";
const C = "/docs/c.md";

function makeHighlight(id: string, overrides: Partial<Highlight> = {}): Highlight {
  return {
    id,
    colour: "yellow",
    anchor: { startLine: 1, endLine: 2, startOffset: 0, length: 5, hash: "0".repeat(16) },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Let the store's 300 ms save debounce fire and the resulting save settle. */
async function drainSaves() {
  await sleep(330);
  await act(async () => {
    await sleep(0);
  });
}

async function mount(): Promise<{ ctx: Store; unmount: () => void }> {
  const box: { ctx?: Store } = {};
  function Probe(): null {
    box.ctx = useHighlights();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      <HighlightsProvider>
        <Probe />
      </HighlightsProvider>,
    );
  });
  // Let the one-shot key-load effect's promise chain settle.
  await act(async () => {
    await sleep(0);
  });
  return {
    get ctx(): Store {
      expect(box.ctx).toBeTruthy();
      return box.ctx!;
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** Fetch one document's highlights from the (mocked) disk and let it land. */
async function loadFile(ctx: Store, path: string, disk: Highlight[]) {
  m.getHighlights.mockImplementationOnce(() => Promise.resolve({ version: 2, highlights: disk }));
  await act(async () => {
    ctx.loadFile(path);
    await sleep(0);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.flushListeners.length = 0;
  m.getHighlights.mockImplementation(() => Promise.resolve({ version: 2, highlights: [] }));
  m.saveHighlights.mockImplementation(() => Promise.resolve());
  m.getHighlightsKey.mockImplementation(() => Promise.resolve(KEY_HEX));
  m.confirmClose.mockImplementation(() => Promise.resolve());
  // The store logs load/save failures; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key loading (F2, store side)", () => {
  it("loads the 128-bit key once on mount and exposes 16 bytes", async () => {
    const app = await mount();
    expect(m.getHighlightsKey).toHaveBeenCalledTimes(1);
    expect(app.ctx.highlightsKey).toBeInstanceOf(Uint8Array);
    expect([...(app.ctx.highlightsKey as Uint8Array)]).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
    app.unmount();
  });

  it("keeps the key null when the value is not 32 hex digits", async () => {
    m.getHighlightsKey.mockImplementationOnce(() => Promise.resolve("zz"));
    const app = await mount();
    expect(app.ctx.highlightsKey).toBeNull();
    app.unmount();
  });

  it("keeps the key null when the load fails", async () => {
    m.getHighlightsKey.mockImplementationOnce(() => Promise.reject(new Error("no key file")));
    const app = await mount();
    expect(app.ctx.highlightsKey).toBeNull();
    app.unmount();
  });
});

describe("F1: deleting the last highlight persists an empty list", () => {
  it("saving [] for the path when the last one is removed", async () => {
    const app = await mount();
    const h = makeHighlight("h1");
    await loadFile(app.ctx, A, [h]);
    expect(app.ctx.byFile[A]).toEqual([h]);

    act(() => app.ctx.removeHighlight(A, "h1"));

    // The key stays in byFile as an *empty* list: the writer skips absent
    // keys, so only a present-empty list reaches save_highlights.
    expect(app.ctx.byFile[A]).toEqual([]);
    expect(app.ctx.lastDeleted).toEqual({ path: A, highlight: h });

    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, []);
    app.unmount();
  });

  it("saving the remainder when one of several is removed", async () => {
    const app = await mount();
    const h1 = makeHighlight("h1");
    const h2 = makeHighlight("h2");
    await loadFile(app.ctx, A, [h1, h2]);

    act(() => app.ctx.removeHighlight(A, "h1"));
    expect(app.ctx.byFile[A]).toEqual([h2]);

    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [h2]);
    app.unmount();
  });
});

describe("F3: mutations are gated on the load having landed", () => {
  it("refuses mutations while a load is pending; the disk list is authoritative; then merges", async () => {
    const app = await mount();
    const disk = makeHighlight("hDisk");
    let resolve: ((r: { version: number; highlights: Highlight[] }) => void) | undefined;
    m.getHighlights.mockImplementationOnce(
      () =>
        new Promise<{ version: number; highlights: Highlight[] }>((r) => {
          resolve = r;
        }),
    );

    await act(async () => {
      app.ctx.loadFile(A);
      await sleep(0);
    });
    expect(app.ctx.getLoadStatus(A)).toBe("loading");

    // Pending: no creation, no local entry, no save.
    act(() => app.ctx.addHighlight(A, makeHighlight("h2")));
    expect(app.ctx.byFile[A]).toBeUndefined();
    expect(m.saveHighlights).not.toHaveBeenCalled();

    // The load lands with the disk list (no local state was clobbered).
    resolve!({ version: 2, highlights: [disk] });
    await act(async () => {
      await sleep(0);
    });
    expect(app.ctx.getLoadStatus(A)).toBe("loaded");
    expect(app.ctx.byFile[A]).toEqual([disk]);

    // Now mutations are allowed and merge onto the disk list.
    act(() => app.ctx.addHighlight(A, makeHighlight("h2")));
    expect(app.ctx.byFile[A]).toEqual([disk, makeHighlight("h2")]);

    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [disk, makeHighlight("h2")]);
    app.unmount();
  });

  it("a failed load stays failed, is reported, refuses mutations, and is retried", async () => {
    const app = await mount();
    const disk = makeHighlight("hDisk");
    m.getHighlights.mockImplementationOnce(() => Promise.reject(new Error("disk error")));

    await act(async () => {
      app.ctx.loadFile(A);
      await sleep(0);
    });
    expect(app.ctx.getLoadStatus(A)).toBe("failed");
    expect(app.ctx.byFile[A]).toBeUndefined();
    expect(m.notifyApp).toHaveBeenCalledWith(
      "Couldn't load highlights for a.md. They'll be retried when you open it again.",
    );

    // A failed path is still not mutable.
    act(() => app.ctx.addHighlight(A, makeHighlight("h2")));
    expect(app.ctx.byFile[A]).toBeUndefined();

    // The retry: the next load re-fetches from the "failed" state.
    await loadFile(app.ctx, A, [disk]);
    expect(app.ctx.getLoadStatus(A)).toBe("loaded");
    expect(app.ctx.byFile[A]).toEqual([disk]);

    act(() => app.ctx.addHighlight(A, makeHighlight("h2")));
    expect(app.ctx.byFile[A]).toEqual([disk, makeHighlight("h2")]);
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [disk, makeHighlight("h2")]);
    app.unmount();
  });

  it("an empty disk list marks the path loaded without an entry; an add creates one", async () => {
    const app = await mount();
    await loadFile(app.ctx, A, []);
    expect(app.ctx.getLoadStatus(A)).toBe("loaded");
    expect(app.ctx.byFile[A]).toBeUndefined(); // no entry: nothing on disk

    const h = makeHighlight("h1");
    act(() => app.ctx.addHighlight(A, h));
    expect(app.ctx.byFile[A]).toEqual([h]);

    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [h]);
    app.unmount();
  });

  it("a load in flight is not re-fetched; a loaded path is not re-fetched", async () => {
    const app = await mount();
    expect(app.ctx.getLoadStatus(A)).toBe("unloaded");

    let resolve: ((r: { version: number; highlights: Highlight[] }) => void) | undefined;
    m.getHighlights.mockImplementationOnce(
      () =>
        new Promise<{ version: number; highlights: Highlight[] }>((r) => {
          resolve = r;
        }),
    );
    await act(async () => {
      app.ctx.loadFile(A);
      await sleep(0);
    });
    expect(app.ctx.getLoadStatus(A)).toBe("loading");

    // A second call while the first is in flight: no duplicate fetch.
    await act(async () => {
      app.ctx.loadFile(A);
      await sleep(0);
    });
    expect(m.getHighlights).toHaveBeenCalledTimes(1);

    // The load lands: now loaded, and further calls are no-ops too.
    resolve!({ version: 2, highlights: [makeHighlight("h1")] });
    await act(async () => {
      await sleep(0);
    });
    expect(app.ctx.getLoadStatus(A)).toBe("loaded");
    await act(async () => {
      app.ctx.loadFile(A);
      await sleep(0);
    });
    expect(m.getHighlights).toHaveBeenCalledTimes(1);
    app.unmount();
  });
});

describe("F6: limits are enforced before the mutation", () => {
  it("refuses a note over the 4000-character limit on add and on update", async () => {
    const app = await mount();
    await loadFile(app.ctx, A, []);

    act(() => app.ctx.addHighlight(A, makeHighlight("h1", { note: "x".repeat(MAX_NOTE_LENGTH + 1) })));
    expect(app.ctx.byFile[A]).toBeUndefined();
    expect(m.notifyApp).toHaveBeenCalledWith(`Notes are limited to ${MAX_NOTE_LENGTH} characters.`);

    // Exactly at the limit is allowed.
    const h = makeHighlight("h1", { note: "x".repeat(MAX_NOTE_LENGTH) });
    act(() => app.ctx.addHighlight(A, h));
    expect(app.ctx.byFile[A]).toEqual([h]);

    act(() => app.ctx.updateHighlight(A, "h1", { note: "y".repeat(MAX_NOTE_LENGTH + 1) }));
    expect(app.ctx.byFile[A]).toEqual([h]); // unchanged
    expect(m.notifyApp).toHaveBeenCalledWith(`Notes are limited to ${MAX_NOTE_LENGTH} characters.`);
    expect(m.saveHighlights).not.toHaveBeenCalled(); // nothing valid was ever saved
    app.unmount();
  });

  it("refuses the per-file cap (2000 highlights)", async () => {
    const app = await mount();
    const many = Array.from({ length: MAX_HIGHLIGHTS_PER_FILE }, (_, i) => makeHighlight(`h${i}`));
    await loadFile(app.ctx, A, many);
    expect(app.ctx.byFile[A]?.length).toBe(MAX_HIGHLIGHTS_PER_FILE);

    act(() => app.ctx.addHighlight(A, makeHighlight("overflow")));
    expect(app.ctx.byFile[A]?.length).toBe(MAX_HIGHLIGHTS_PER_FILE); // unchanged
    expect(m.notifyApp).toHaveBeenCalledWith(
      `Can't add more highlights to a.md (the ${MAX_HIGHLIGHTS_PER_FILE}-per-file limit is reached).`,
    );
    expect(m.saveHighlights).not.toHaveBeenCalled();
    app.unmount();
  });
});

describe("F7: the close flush", () => {
  it("flush() saves every stored path (dirty and clean) and awaits in-flight saves", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    const c1 = makeHighlight("c1");
    await loadFile(app.ctx, A, [a1]);
    await loadFile(app.ctx, B, []); // loaded, empty: no entry
    await loadFile(app.ctx, C, [c1]); // clean: never mutated

    act(() => app.ctx.addHighlight(A, a2)); // A dirty; its debounce is pending
    expect(m.saveHighlights).not.toHaveBeenCalled();

    await act(async () => {
      await app.ctx.flush();
    });

    expect(m.saveHighlights).toHaveBeenCalledTimes(2);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [a1, a2]);
    expect(m.saveHighlights).toHaveBeenCalledWith(C, [c1]); // clean paths included
    for (const call of m.saveHighlights.mock.calls) expect(call[0]).not.toBe(B);

    // The flush cleared A's debounce timer: nothing more saves after.
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("a close within the 300 ms debounce saves the pending change, then lets the close through", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    act(() => app.ctx.addHighlight(A, a2)); // debounce pending
    expect(m.saveHighlights).not.toHaveBeenCalled();

    // Rust intercepted the first close request and emitted the flush request.
    expect(m.flushListeners.length).toBe(1);
    m.flushListeners[0]();
    await act(async () => {
      await sleep(0);
      await sleep(0);
    });

    expect(m.saveHighlights).toHaveBeenCalledTimes(1); // immediate, not after 300 ms
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [a1, a2]);
    expect(m.confirmClose).toHaveBeenCalledTimes(1); // the close is let through

    // The debounce timer was cleared by the flush: no second save.
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("a failed flush does not trap the close, and the next mutation retries the save", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    act(() => app.ctx.addHighlight(A, a2));

    m.saveHighlights.mockImplementation(() => Promise.reject(new Error("disk on fire")));
    m.flushListeners[0]();
    await act(async () => {
      await sleep(0);
      await sleep(0);
    });
    expect(m.confirmClose).toHaveBeenCalledTimes(1); // not trapped
    expect(m.notifyApp).toHaveBeenCalledWith(
      "Couldn't save highlights for a.md. Will retry on the next change or when you close the window.",
    );

    // The path is still dirty: the next mutation saves it.
    m.saveHighlights.mockImplementation(() => Promise.resolve());
    act(() => app.ctx.updateHighlight(A, "a2", { colour: "pink" }));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenLastCalledWith(
      A,
      expect.arrayContaining([expect.objectContaining({ id: "a2", colour: "pink" })]),
    );
    app.unmount();
  });
});
