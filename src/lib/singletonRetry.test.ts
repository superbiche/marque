import { afterEach, describe, expect, it, vi } from "vitest";

interface MermaidRetryState {
  failLoad: boolean;
  mermaid: {
    initialize: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  };
}

declare global {
  var __marqueMermaidRetryState: MermaidRetryState | undefined;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@shikijs/core");
  vi.doUnmock("mermaid");
  delete globalThis.__marqueMermaidRetryState;
});

describe("lazy singleton retries", () => {
  it("retries Shiki after its initial load fails", async () => {
    const highlighter = {};
    const createHighlighterCore = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(highlighter);
    vi.doMock("@shikijs/core", () => ({ createHighlighterCore }));

    const { getHighlighter } = await import("./highlight");

    await expect(getHighlighter()).rejects.toThrow("temporary failure");
    await expect(getHighlighter()).resolves.toBe(highlighter);
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
  });

  it("retries Mermaid after its initial module load fails", async () => {
    const mermaid = {
      initialize: vi.fn(),
      render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
    };
    globalThis.__marqueMermaidRetryState = { failLoad: true, mermaid };
    vi.doMock("mermaid", () => {
      const state = globalThis.__marqueMermaidRetryState;
      if (!state || state.failLoad) throw new Error("temporary failure");
      return { default: state.mermaid };
    });

    const { renderMermaidBlocks } = await import("./mermaid");
    const root = document.createElement("div");
    root.innerHTML = '<pre class="mermaid-pending">graph TD; A--&gt;B;</pre>';

    await expect(renderMermaidBlocks(root, "dark")).rejects.toThrow();

    globalThis.__marqueMermaidRetryState.failLoad = false;
    await expect(renderMermaidBlocks(root, "dark")).resolves.toBeUndefined();
    expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: "dark" });
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });
});
