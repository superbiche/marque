/**
 * Focus/selection contract of the EDIT popover (companion to
 * `HighlightPopover.test.tsx`).
 *
 * Unlike the creation popover, the edit popover keeps its focus-on-open: it
 * opens only from a click on an existing highlight, and a live selection
 * never coexists with the open (the click that opened it already collapsed
 * one — the click handler skips a non-collapsed selection). The close path
 * shares the creation popover's guard: focus is returned to the article only
 * when no live selection is in the document, because focusing the article
 * can collapse a selection — and a selection made while the edit popover was
 * open is exactly what the creation popover then needs to stay alive.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightEditPopover, type HighlightEditPopoverState } from "./HighlightEditPopover";
import type { Highlight } from "@/lib/highlights";

vi.hoisted(() => {
  // React 19's act() requires this flag.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

const highlight: Highlight = {
  id: "h1",
  colour: "yellow",
  anchor: { startLine: 1, endLine: 1, startOffset: 0, length: 4, hash: "0000000000000000" },
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};

let articleEl: HTMLElement | null = null;
let state: HighlightEditPopoverState | null = null;

function Harness() {
  const articleRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    articleEl = articleRef.current;
  });
  return (
    <>
      <article ref={articleRef} tabIndex={-1}>
        <p>alpha beta gamma</p>
      </article>
      <HighlightEditPopover
        state={state}
        articleRef={articleRef}
        onRecolour={() => {}}
        onUpdateNote={() => {}}
        onCopy={() => Promise.resolve(false)}
        onDelete={() => {}}
        onDismiss={() => {}}
      />
    </>
  );
}

function makeLiveSelection(): Selection {
  const sel = window.getSelection()!;
  const text = articleEl!.querySelector("p")!.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 6); // "beta"
  range.setEnd(text, 10);
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("HighlightEditPopover focus/selection contract", () => {
  let root: Root;

  /** Set the popover state and re-render so the change reaches the
   *  component (Harness reads the module-level `state` in render). */
  function setState(next: HighlightEditPopoverState | null) {
    state = next;
    act(() => root.render(<Harness />));
  }

  beforeEach(() => {
    state = null;
    articleEl = null;
    root = createRoot(document.body);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    window.getSelection()?.removeAllRanges();
    state = null;
  });

  it("opening moves focus into the popover (kept: no selection is involved)", () => {
    // The click that opens it has already focused the article and collapsed
    // any prior selection.
    act(() => articleEl!.focus());
    setState({ x: 100, y: 200, highlight });

    const popover = document.querySelector<HTMLElement>('[aria-label="Edit highlight"]');
    expect(popover).not.toBeNull();
    expect(document.activeElement).toBe(popover);
  });

  it("closing while a live selection exists does not move focus to the article", () => {
    setState({ x: 100, y: 200, highlight });
    // A selection made (e.g. with the keyboard) while the popover was open,
    // focus having "dropped" to body: the close path must not return focus to
    // the article, because that can collapse the selection the creation
    // popover is about to serve.
    const sel = makeLiveSelection();
    act(() => document.body.focus());
    setState(null);

    expect(document.activeElement).toBe(document.body);
    expect(sel.isCollapsed).toBe(false);
  });

  it("closing with dropped focus and no live selection returns focus to the article", () => {
    setState({ x: 100, y: 200, highlight });
    act(() => document.body.focus());
    setState(null);

    expect(document.activeElement).toBe(articleEl);
  });
});
