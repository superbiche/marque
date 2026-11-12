import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@/lib/theme";
import { PreferencesProvider } from "@/lib/preferences";
import type { SearchResult } from "@/lib/tauri";
import { CommandPalette } from "./CommandPalette";

// Interactive rendering through the real DOM (happy-dom): React 19's act()
// requires the environment flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * One controllable search per query. The test decides when (or whether) each
 * resolves, which is what reproduces the in-flight window a real Rust call
 * creates between the user's keystrokes.
 */
const { searches } = vi.hoisted(() => ({
  searches: new Map<
    string,
    { promise: Promise<SearchResult[]>; resolve: (r: SearchResult[]) => void }
  >(),
}));

vi.mock("@/lib/tauri", () => ({
  tauri: {
    searchFiles: (q: string) => {
      let entry = searches.get(q);
      if (!entry) {
        let resolve!: (r: SearchResult[]) => void;
        const promise = new Promise<SearchResult[]>((r) => (resolve = r));
        entry = { promise, resolve };
        searches.set(q, entry);
      }
      return entry.promise;
    },
    addFolder: async () => {},
    loadPreferences: async () => ({}),
    savePreferences: async () => {},
  },
}));

const file = (folder: string, rel: string): SearchResult => ({
  folder_id: `id-${folder}`,
  folder_name: folder,
  absolute_path: `/home/michel/${folder}/${rel}`,
  relative_path: rel,
  score: 1,
});

const README = file("docs", "readme.md");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll, inside act() so React updates flush, until fn() is true. */
async function until(fn: () => boolean, what: string) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error(`timed out waiting for: ${what}`);
    await act(async () => {
      await sleep(10);
    });
  }
}

const items = () => Array.from(document.querySelectorAll("[cmdk-item]"));

/** Set the palette input's value the way a keystroke would. */
async function typeInto(query: string) {
  const input = document.querySelector("input")!;
  const setNativeValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
    .set!;
  await act(async () => {
    input.focus();
    setNativeValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter() {
  const input = document.querySelector("input")!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

function renderPalette(onOpenFile: (path: string) => void) {
  return (
    <ThemeProvider>
      <PreferencesProvider>
        <CommandPalette
          open
          onOpenChange={() => {}}
          onOpenFile={onOpenFile}
          onSplit={() => {}}
          onCloseSplit={() => {}}
          isSplit={false}
          folders={[]}
          onJumpToFolder={() => {}}
        />
      </PreferencesProvider>
    </ThemeProvider>
  );
}

let root: Root;

beforeEach(() => {
  searches.clear();
  document.body.innerHTML = "";
  root = createRoot(document.body);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

describe("CommandPalette file results", () => {
  it("never shows or selects file results that belong to an earlier query", async () => {
    const onOpenFile = vi.fn();
    await act(async () => {
      root.render(renderPalette(onOpenFile));
    });

    // "readme": its result is for the current query, so it renders — and is
    // still selectable exactly as before.
    await typeInto("readme");
    await until(() => searches.has("readme"), "the 'readme' search to be issued");
    searches.get("readme")!.resolve([README]);
    await act(async () => {
      await sleep(50);
    });
    expect(items().length).toBe(1);
    expect(items()[0].textContent).toContain("readme.md");
    await pressEnter();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/home/michel/docs/readme.md");

    // Replace the query with "xyzzy" while its search is still in flight:
    // the stale "readme" batch must be gone, and nothing is selectable.
    await typeInto("xyzzy");
    await until(() => searches.has("xyzzy"), "the 'xyzzy' search to be issued");
    expect(items().length).toBe(0);
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe("No results.");
    await pressEnter();
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    // Abandon "xyzzy" for "zzz": the late "xyzzy" response is dropped.
    await typeInto("zzz");
    searches.get("xyzzy")!.resolve([README]);
    await act(async () => {
      await sleep(50);
    });
    expect(items().length).toBe(0);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("shows the current query's file results, in the order they arrived, when the response lands", async () => {
    const onOpenFile = vi.fn();
    await act(async () => {
      root.render(renderPalette(onOpenFile));
    });

    // Opening the palette searches the (empty) query; resolve it late.
    await until(() => searches.has(""), "the empty search to be issued");
    searches.get("")!.resolve([file("docs", "alpha.md"), file("work", "beta.md")]);
    await act(async () => {
      await sleep(50);
    });

    // Ten visible actions (no split, no highlights panel in this harness)
    // above the two files, in the exact order the response arrived in.
    const values = items().map((i) => i.getAttribute("data-value") ?? "");
    expect(items().length).toBe(12);
    expect(values).toContain("docs/alpha.md");
    expect(values).toContain("work/beta.md");
    expect(values.indexOf("docs/alpha.md")).toBeLessThan(values.indexOf("work/beta.md"));
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
