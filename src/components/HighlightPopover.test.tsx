/**
 * Focus/selection contract of the CREATION popover (regression guard from the
 * 2026-11-11 WebKitGTK probe: double-click → no selection, no popover).
 *
 * The popover opens in direct response to a selection the user just made.
 * A programmatic focus of any other element collapses the document selection
 * in WebKit, and the Viewer's `selectionchange` listener then reads
 * "selection gone" and closes the popover before the user can act. So:
 *   - opening must move focus nowhere, and the popover must not even be a
 *     programmatic focus target (no tabIndex on the container);
 *   - closing may return dropped focus to the article only when no live
 *     selection is in the document (focusing the article can collapse it).
 *
 * happy-dom itself does not clear a selection on programmatic focus — that
 * is WebKit-specific — so these assertions pin the code contract (the open
 * path moves focus nowhere and touches no focus target; the close path
 * collides with a live selection nowhere), which is the surface the
 * regression lived on.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightPopover, type HighlightPopoverState } from "./HighlightPopover";

vi.hoisted(() => {
  // React 19's act() requires this flag.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

/** The article the popover serves: the same element the Viewer passes as
 *  `articleRef`. */
let articleEl: HTMLElement | null = null;
let state: HighlightPopoverState | null = null;

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
      <HighlightPopover
        state={state}
        activeColour="yellow"
        articleRef={articleRef}
        onApply={() => {}}
        onCopyForAgent={() => Promise.resolve(false)}
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

describe("HighlightPopover (creation) focus/selection contract", () => {
  let root: Root;

  /** Set the popover state and re-render so the change reaches the
   *  component (Harness reads the module-level `state` in render). */
  function setState(next: HighlightPopoverState | null) {
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

  it("opening moves no focus and leaves the live selection intact", () => {
    const sel = makeLiveSelection();
    // The double-click's mousedown has already focused the article (it is
    // tabIndex=-1); the open path must not move it anywhere else.
    act(() => articleEl!.focus());
    setState({ x: 100, y: 200 });

    const popover = document.querySelector<HTMLElement>('[aria-label="Highlight"]');
    expect(popover).not.toBeNull();
    // No programmatic focus move into the popover.
    expect(document.activeElement).toBe(articleEl);
    // The container is not a programmatic focus target at all.
    expect(popover!.getAttribute("tabindex")).toBeNull();
    // The selection the popover exists for is still there.
    expect(sel.isCollapsed).toBe(false);
    expect(sel.rangeCount).toBe(1);
  });

  it("closing while a live selection exists does not move focus to the article", () => {
    setState({ x: 100, y: 200 });
    // The original selection is still live and focus has "dropped" to body
    // (as it does when the annotating input is removed) — the close path
    // must not return focus to the article, because that can collapse the
    // selection.
    const sel = makeLiveSelection();
    act(() => document.body.focus());
    setState(null);

    expect(document.activeElement).toBe(document.body);
    expect(sel.isCollapsed).toBe(false);
  });

  it("closing with dropped focus and no live selection returns focus to the article", () => {
    setState({ x: 100, y: 200 });
    act(() => document.body.focus());
    setState(null);

    expect(document.activeElement).toBe(articleEl);
  });
});
