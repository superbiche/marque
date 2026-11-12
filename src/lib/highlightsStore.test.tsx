/**
 * Store-level tests for the highlights store (marky PR #9 repair round 1).
 *
 * Covers the store-side behaviour of the findings:
 * - F1: deleting the last highlight of a document persists `[]` for its path.
 * - F3: mutations are gated on the load having actually landed (pending and
 *   failed loads both refuse; a failed load is retried on the next load).
 * - F6: the per-note and per-file limits are enforced before the mutation.
 * - F7: `flush()` saves pending (unsaved) paths, awaits in-flight saves, and
 *   the close-request flow awaits the flush before letting the close through
 *   — including when the save fails.
 * - F9/F12: one save queue per path, no debounce — every mutation queues a
 *   save that sends the path's current list if it is newer than the last one
 *   persisted. Oracles: the reviewer's lifecycle sequence (a no-op save must
 *   never stop later saves), an edit during a save, a flush during a save, a
 *   retry after a failure, and a burst of edits ending in the final list.
 * - F2: the one-shot load of the per-installation key (Tauri side of the
 *   keyed fingerprints).
 *
 * The Tauri boundary is mocked (`@/lib/tauri`) and the notification surface
 * is mocked (`@/components/Notifications`); the provider is mounted with
 * react-dom/client + React.act under happy-dom. `window.__TAURI_INTERNALS__`
 * is defined before the store module runs, so the Tauri-only effects (the
 * one-shot key load and the close-flush listener) run here too.
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
    ackCloseRequest: vi.fn(),
    confirmClose: vi.fn(),
    cancelClose: vi.fn(),
    rearmCloseGuard: vi.fn(),
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
    ackCloseRequest: () => m.ackCloseRequest(),
    confirmClose: () => m.confirmClose(),
    cancelClose: () => m.cancelClose(),
    rearmCloseGuard: () => m.rearmCloseGuard(),
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

/** Let queued saves run and settle. */
async function drainSaves() {
  await act(async () => {
    await sleep(0);
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
  m.ackCloseRequest.mockImplementation(() => Promise.resolve());
  m.confirmClose.mockImplementation(() => Promise.resolve());
  m.cancelClose.mockImplementation(() => Promise.resolve());
  m.rearmCloseGuard.mockImplementation(() => Promise.resolve());
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

  it("reports a key failure once (not per loadFile) and recovers when the read later succeeds", async () => {
    m.getHighlightsKey.mockImplementation(() => Promise.reject(new Error("no key file")));
    const app = await mount();
    await drainSaves(); // let the mount fetch's finally() release the in-flight guard
    // First (mount) attempt fails: one notification, key null.
    expect(m.getHighlightsKey).toHaveBeenCalledTimes(1);
    expect(app.ctx.highlightsKey).toBeNull();
    expect(m.notifyApp).toHaveBeenCalledTimes(1);
    expect(m.notifyApp).toHaveBeenCalledWith(
      "Highlights are unavailable: the highlights key could not be read. Reopen the document to try again.",
    );
    // A loadFile retries the read; still failing, it adds no second notification.
    await loadFile(app.ctx, A, []);
    expect(m.getHighlightsKey).toHaveBeenCalledTimes(2);
    expect(app.ctx.highlightsKey).toBeNull();
    expect(m.notifyApp).toHaveBeenCalledTimes(1);
    // Once the read succeeds (a key created since first launch), the retry
    // lands and no further notification is made.
    m.getHighlightsKey.mockImplementation(() => Promise.resolve(KEY_HEX));
    await loadFile(app.ctx, B, []);
    expect(m.getHighlightsKey).toHaveBeenCalledTimes(3);
    expect(app.ctx.highlightsKey).toBeInstanceOf(Uint8Array);
    expect(m.notifyApp).toHaveBeenCalledTimes(1);
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

  it("undoDelete refuses to restore over the per-file cap and keeps lastDeleted", async () => {
    const app = await mount();
    const many = Array.from({ length: MAX_HIGHLIGHTS_PER_FILE }, (_, i) => makeHighlight(`h${i}`));
    await loadFile(app.ctx, A, many);
    // Delete one (the undo target), then fill the freed slot with a new one so
    // the file is back at the cap.
    act(() => app.ctx.removeHighlight(A, "h0"));
    expect(app.ctx.byFile[A]?.length).toBe(MAX_HIGHLIGHTS_PER_FILE - 1);
    const extra = makeHighlight("extra");
    act(() => app.ctx.addHighlight(A, extra));
    expect(app.ctx.byFile[A]?.length).toBe(MAX_HIGHLIGHTS_PER_FILE);
    await drainSaves();

    // Restoring the deleted highlight would exceed the cap: refuse, keep it.
    act(() => app.ctx.undoDelete());
    expect(app.ctx.byFile[A]?.length).toBe(MAX_HIGHLIGHTS_PER_FILE); // unchanged
    expect(app.ctx.byFile[A]?.some((h) => h.id === "h0")).toBe(false);
    expect(m.notifyApp).toHaveBeenCalledWith(
      `Can't add more highlights to a.md (the ${MAX_HIGHLIGHTS_PER_FILE}-per-file limit is reached).`,
    );
    // lastDeleted is kept, so the undo stays available (the timer is not reset).
    expect(app.ctx.lastDeleted?.path).toBe(A);
    expect(app.ctx.lastDeleted?.highlight.id).toBe("h0");
    app.unmount();
  });
});

/** A save mock whose calls hang until released, one at a time, in order. */
function hangingSaves() {
  const releases: Array<(ok: boolean) => void> = [];
  m.saveHighlights.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        releases.push((ok) => (ok ? resolve() : reject(new Error("disk error"))));
      }),
  );
  return {
    async release(ok = true) {
      const r = releases.shift();
      expect(r).toBeTruthy();
      r!(ok);
      await drainSaves();
    },
    get pending() {
      return releases.length;
    },
  };
}

describe("F7: the close flush", () => {
  it("flush() saves nothing for clean paths and waits for queued saves", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    const c1 = makeHighlight("c1");
    await loadFile(app.ctx, A, [a1]);
    await loadFile(app.ctx, B, []); // loaded, empty: no entry
    await loadFile(app.ctx, C, [c1]); // clean: never mutated

    const saves = hangingSaves();
    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [a1, a2]);

    let flushed = false;
    const done = app.ctx.flush().then(() => {
      flushed = true;
    });
    await drainSaves();
    expect(flushed).toBe(false); // waits for A's save in flight

    await saves.release();
    await act(async () => {
      await done;
    });
    expect(flushed).toBe(true);
    // A's generation was saved; B and C were never mutated: one save total.
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("a close right after an edit saves it, then lets the close through", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    act(() => app.ctx.addHighlight(A, a2));
    // Rust intercepted the first close request and emitted the flush request.
    expect(m.flushListeners.length).toBe(1);
    m.flushListeners[0]();
    await drainSaves();

    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.saveHighlights).toHaveBeenCalledWith(A, [a1, a2]);
    expect(m.confirmClose).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("a failed close flush cancels (not confirms), tells the user to close again; the next mutation retries", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    m.saveHighlights.mockImplementation(() => Promise.reject(new Error("disk on fire")));
    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves(); // the edit's save fails: one streak notification
    expect(m.notifyApp).toHaveBeenCalledTimes(1);

    m.flushListeners[0]();
    await drainSaves();
    // Not trapped: the close is cancelled (the window stays open), not confirmed.
    expect(m.confirmClose).not.toHaveBeenCalled();
    expect(m.cancelClose).toHaveBeenCalledTimes(1);
    // The flush's retried save stayed silent (same streak); the failed close
    // does tell the user to close again to close without saving.
    expect(m.notifyApp).toHaveBeenCalledTimes(2);
    expect(m.notifyApp).toHaveBeenNthCalledWith(
      1,
      "Couldn't save highlights for a.md. Will retry on the next change or when you close the window.",
    );
    expect(m.notifyApp).toHaveBeenNthCalledWith(
      2,
      "Couldn't save highlights. Close the window again to close without saving.",
    );

    // The next mutation retries the save (which now succeeds).
    m.saveHighlights.mockImplementation(() => Promise.resolve());
    act(() => app.ctx.updateHighlight(A, "a2", { colour: "pink" }));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenLastCalledWith(
      A,
      expect.arrayContaining([expect.objectContaining({ id: "a2", colour: "pink" })]),
    );
    app.unmount();
  });

  it("flush re-checks and persists a path edited on a different path while it waits", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    const b1 = makeHighlight("b1");
    const b2 = makeHighlight("b2");
    await loadFile(app.ctx, A, [a1]);
    await loadFile(app.ctx, B, [b1]);

    const saves = hangingSaves();
    act(() => app.ctx.addHighlight(A, a2)); // A's save hangs
    await drainSaves();

    let ok: boolean | undefined;
    const done = app.ctx.flush().then((r) => {
      ok = r.ok;
    });
    await drainSaves();
    expect(ok).toBeUndefined(); // flush is waiting on A

    // An edit on a *different* path while the flush is in flight makes B
    // dirty mid-flush; the re-check loop must pick it up on a later pass.
    act(() => app.ctx.addHighlight(B, b2));
    await drainSaves();

    // Release A: the first pass completes, sees B now dirty, and re-queues.
    await saves.release();
    expect(ok).toBeUndefined(); // still waiting: B's save is not yet released
    // Release B: the second pass persists B and the flush lands.
    await saves.release();
    await act(async () => {
      await done;
    });
    expect(ok).toBe(true);
    expect(m.saveHighlights).toHaveBeenNthCalledWith(1, A, [a1, a2]);
    expect(m.saveHighlights).toHaveBeenNthCalledWith(2, B, [b1, b2]);
    app.unmount();
  });

  it("flush reports ok:false when a save keeps failing (a pass makes no progress)", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    await loadFile(app.ctx, A, [a1]);

    m.saveHighlights.mockImplementation(() => Promise.reject(new Error("disk on fire")));
    act(() => app.ctx.addHighlight(A, makeHighlight("a2")));
    await drainSaves();

    let ok: boolean | undefined;
    await act(async () => {
      ok = (await app.ctx.flush()).ok;
    });
    expect(ok).toBe(false);
    app.unmount();
  });

  it("refuses a mutation between a successful close flush and confirmClose (no save, no notification)", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    // A normal edit, saved before the close attempt.
    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);

    // A close whose confirm hangs: the flush succeeds, so the gate (set
    // when the request arrived) is still up between the flush and
    // confirmClose.
    m.confirmClose.mockImplementationOnce(() => new Promise(() => {}));
    m.flushListeners[0]();
    await drainSaves();
    expect(m.confirmClose).toHaveBeenCalledTimes(1);

    // A mutation in that window is refused like an unloaded path: no
    // state change, no save queued, no notification.
    act(() => app.ctx.addHighlight(A, makeHighlight("a3")));
    expect(app.ctx.byFile[A]).toEqual([a1, a2]);
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);
    expect(m.notifyApp).not.toHaveBeenCalled();
    app.unmount();
  });

  it("a cancelled close re-enables mutations", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    // A close whose flush keeps failing is cancelled; the gate is cleared
    // with it, and the next mutation works again (and retries the save).
    m.saveHighlights.mockImplementation(() => Promise.reject(new Error("disk on fire")));
    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves(); // the edit's save fails: one streak notification
    expect(m.notifyApp).toHaveBeenCalledTimes(1);

    m.flushListeners[0]();
    await drainSaves();
    expect(m.confirmClose).not.toHaveBeenCalled();
    expect(m.cancelClose).toHaveBeenCalledTimes(1);
    expect(m.notifyApp).toHaveBeenLastCalledWith(
      "Couldn't save highlights. Close the window again to close without saving.",
    );

    // The close was cancelled: the window is open, mutations work again.
    m.saveHighlights.mockImplementation(() => Promise.resolve());
    act(() => app.ctx.updateHighlight(A, "a2", { colour: "pink" }));
    expect(app.ctx.byFile[A]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "a2", colour: "pink" })]),
    );
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenLastCalledWith(
      A,
      expect.arrayContaining([expect.objectContaining({ id: "a2", colour: "pink" })]),
    );
    app.unmount();
  });

  it("a mutation after a cancelled close re-arms the guard once; later mutations do not", async () => {
    const app = await mount();
    const a1 = makeHighlight("a1");
    const a2 = makeHighlight("a2");
    await loadFile(app.ctx, A, [a1]);

    // A close whose flush keeps failing is cancelled (the native guard
    // moves to DiscardAllowed). The edit that triggered it is *before*
    // the cancel, so it must not re-arm.
    m.saveHighlights.mockImplementation(() => Promise.reject(new Error("disk on fire")));
    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves();
    m.flushListeners[0]();
    await drainSaves();
    expect(m.cancelClose).toHaveBeenCalledTimes(1);
    expect(m.rearmCloseGuard).not.toHaveBeenCalled();

    // The first accepted mutation after the cancelled close re-arms
    // exactly once (the native guard must go back to Idle before the
    // user closes again, or it would discard this edit).
    m.saveHighlights.mockImplementation(() => Promise.resolve());
    act(() => app.ctx.updateHighlight(A, "a2", { colour: "pink" }));
    await drainSaves();
    expect(m.rearmCloseGuard).toHaveBeenCalledTimes(1);

    // Later mutations do not re-arm again.
    act(() => app.ctx.updateHighlight(A, "a2", { colour: "blue" }));
    await drainSaves();
    expect(m.rearmCloseGuard).toHaveBeenCalledTimes(1);
    app.unmount();
  });
});

describe("F9/F12: one save queue per path (test oracle)", () => {
  it("a no-op save never stops later saves (the reviewer's sequence)", async () => {
    const app = await mount();
    const [a1, a2, a3, a4] = ["a1", "a2", "a3", "a4"].map((id) => makeHighlight(id));
    await loadFile(app.ctx, A, [a1]);
    const saves = hangingSaves();

    act(() => app.ctx.addHighlight(A, a2)); // save #1 starts and hangs
    await drainSaves();
    act(() => app.ctx.addHighlight(A, a3)); // queued behind #1
    await saves.release(); // #1 lands; the queued save sends the newest list
    expect(m.saveHighlights).toHaveBeenNthCalledWith(1, A, [a1, a2]);
    expect(m.saveHighlights).toHaveBeenNthCalledWith(2, A, [a1, a2, a3]);
    await saves.release(); // #2 lands: A is clean

    // A clean-path invocation (flush with nothing to do) is a no-op ...
    await act(async () => {
      await app.ctx.flush();
    });
    expect(m.saveHighlights).toHaveBeenCalledTimes(2);

    // ... and does not stop the next edit from being saved.
    act(() => app.ctx.addHighlight(A, a4));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(3);
    expect(m.saveHighlights).toHaveBeenLastCalledWith(A, [a1, a2, a3, a4]);
    await saves.release();

    // A close flush after that has nothing left to send.
    await act(async () => {
      await app.ctx.flush();
    });
    expect(m.saveHighlights).toHaveBeenCalledTimes(3);
    app.unmount();
  });

  it("an edit made during a save is sent once that save lands", async () => {
    const app = await mount();
    const [a1, a2, a3] = ["a1", "a2", "a3"].map((id) => makeHighlight(id));
    await loadFile(app.ctx, A, [a1]);
    const saves = hangingSaves();

    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves();
    act(() => app.ctx.removeHighlight(A, "a1"));
    act(() => app.ctx.addHighlight(A, a3));
    expect(m.saveHighlights).toHaveBeenCalledTimes(1); // serialized: one in flight

    await saves.release();
    expect(m.saveHighlights).toHaveBeenCalledTimes(2);
    expect(m.saveHighlights).toHaveBeenLastCalledWith(A, [a2, a3]);
    await saves.release();
    expect(saves.pending).toBe(0);
    expect(m.saveHighlights).toHaveBeenCalledTimes(2); // the third queued save had nothing new
    app.unmount();
  });

  it("a flush during a save waits for it and sends the newest list", async () => {
    const app = await mount();
    const [a1, a2, a3, b1, b2] = ["a1", "a2", "a3", "b1", "b2"].map((id) => makeHighlight(id));
    await loadFile(app.ctx, A, [a1]);
    await loadFile(app.ctx, B, [b1]);
    let releaseA: Array<() => void> = [];
    m.saveHighlights.mockImplementation((path: string) =>
      path === A ? new Promise<void>((r) => releaseA.push(r)) : Promise.resolve(),
    );

    act(() => app.ctx.addHighlight(A, a2)); // A in flight
    await drainSaves();
    act(() => app.ctx.addHighlight(A, a3)); // A pending behind it
    act(() => app.ctx.addHighlight(B, b2)); // B saves independently

    let flushed = false;
    const done = app.ctx.flush().then(() => {
      flushed = true;
    });
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledWith(B, [b1, b2]);
    expect(flushed).toBe(false);

    releaseA.shift()!();
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenLastCalledWith(A, [a1, a2, a3]);
    expect(flushed).toBe(false); // still waiting for that save
    releaseA.shift()!();
    await act(async () => {
      await done;
    });
    expect(flushed).toBe(true);
    releaseA = [];
    app.unmount();
  });

  it("a failed save is retried by the next flush", async () => {
    const app = await mount();
    const [a1, a2] = ["a1", "a2"].map((id) => makeHighlight(id));
    await loadFile(app.ctx, A, [a1]);
    m.saveHighlights.mockImplementationOnce(() => Promise.reject(new Error("disk error")));

    act(() => app.ctx.addHighlight(A, a2));
    await drainSaves();
    expect(m.saveHighlights).toHaveBeenCalledTimes(1);

    await act(async () => {
      await app.ctx.flush();
    });
    expect(m.saveHighlights).toHaveBeenCalledTimes(2);
    expect(m.saveHighlights).toHaveBeenLastCalledWith(A, [a1, a2]);
    // Clean now: another flush sends nothing.
    await act(async () => {
      await app.ctx.flush();
    });
    expect(m.saveHighlights).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("a burst of 50 edits coalesces and ends with the final list on disk", async () => {
    const app = await mount();
    await loadFile(app.ctx, A, []);
    const saves = hangingSaves();
    const all = Array.from({ length: 50 }, (_, i) => makeHighlight(`h${i}`));

    act(() => app.ctx.addHighlight(A, all[0]));
    await drainSaves(); // save #1 in flight
    for (const h of all.slice(1)) act(() => app.ctx.addHighlight(A, h));
    while (saves.pending > 0) await saves.release();

    const calls = m.saveHighlights.mock.calls;
    expect(calls.length).toBe(2); // the first edit, then everything queued behind it
    expect(calls[calls.length - 1]).toEqual([A, all]);
    app.unmount();
  });
});
