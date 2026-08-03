import { afterEach, describe, expect, it } from "vitest";
import { handleCopyAsMarkdown, selectionCoversBlock } from "./copyAsMarkdown";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("selectionCoversBlock", () => {
  it("compares trimmed, whitespace-collapsed text", () => {
    expect(selectionCoversBlock("  whole\n block ", "whole   block")).toBe(true);
    expect(selectionCoversBlock("whole", "whole block")).toBe(false);
  });
});

describe("handleCopyAsMarkdown", () => {
  it("falls through to native copy for a partial single-block selection", () => {
    document.body.innerHTML = '<article><p data-source-map="0,1">A whole block</p></article>';
    const container = document.querySelector("article")!;
    const text = container.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 7);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    let prevented = false;
    const handled = handleCopyAsMarkdown(
      { preventDefault: () => { prevented = true; }, clipboardData: null } as unknown as ClipboardEvent,
      container,
      "A whole block",
    );

    expect(handled).toBe(false);
    expect(prevented).toBe(false);
  });

  it("keeps source-line copy for a complete mapped block", () => {
    document.body.innerHTML = '<article><p data-source-map="0,1">A whole block</p></article>';
    const container = document.querySelector("article")!;
    const block = container.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(block);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const copied: string[] = [];
    const handled = handleCopyAsMarkdown(
      {
        preventDefault: () => {},
        clipboardData: { setData: (_type: string, value: string) => copied.push(value) },
      } as unknown as ClipboardEvent,
      container,
      "**A whole block**",
    );

    expect(handled).toBe(true);
    expect(copied).toEqual(["**A whole block**"]);
  });
});
