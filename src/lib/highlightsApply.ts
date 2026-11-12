/**
 * Apply highlights as wrapping <span>s inside the rendered article DOM.
 *
 * Works by taking a relocated highlight (see `resolveAnchors`), mapping its
 * normalized-text window back to a raw character span of the block, and
 * wrapping the corresponding text-node ranges with `marque-highlight`
 * spans. The wrap is layout-neutral (plain inline spans), so applying and
 * clearing it does not shift the rendered text; callers that still want to
 * defend against scroll-anchoring jumps use `withPreservedScroll`.
 *
 * Idempotent: a second call with the same highlights is a no-op (clearAll
 * removes prior wrappers first).
 */

import {
  isInCodeBlock,
  mapInverse,
  type Highlight,
  type MappedBlock,
  type Resolution,
  type ResolvedHighlight,
} from "@/lib/highlights";

export const HIGHLIGHT_CLASS = "marque-highlight";
const ID_ATTR = "data-highlight-id";
const COLOUR_ATTR = "data-highlight-colour";

/**
 * Remove all previously-applied highlight spans inside the container,
 * unwrapping them back into the surrounding text.
 */
export function clearAllHighlights(container: HTMLElement): void {
  const spans = container.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`);
  for (const span of Array.from(spans)) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/**
 * Map a window of the block's normalized text back to a raw (un-collapsed)
 * character span. The inverse of the anchoring mapping: a boundary on a
 * grapheme cluster's normalized start lands on the cluster's raw start, a
 * boundary inside a cluster snaps to the cluster's raw end, and a boundary
 * past a collapsed whitespace run lands on the run's last character — so
 * the span reproduces the original selection (whole runs included).
 */
function rawRangeOf(
  block: MappedBlock,
  start: number,
  end: number,
): [number, number] | null {
  const map = block.map;
  const normLen = map.text.length;
  if (start < 0 || end > normLen || end <= start) return null;
  // `mapInverse` is the cluster-boundary inverse of the single raw ->
  // normalized map, so a window that spans a composed (NFC) or collapsed
  // sequence wraps exactly the raw characters that produced it — including
  // a composed character's combining marks when the window ends on it.
  const rawStart = mapInverse(map, start);
  const rawEnd = mapInverse(map, end);
  if (rawEnd <= rawStart) return null;
  return [rawStart, rawEnd];
}

/**
 * Walk the block's text nodes (excluding any inside <pre>) and gather the
 * text-node ranges covering characters [start, end) of the block's raw
 * text. One range per text node touched.
 */
function textNodeRanges(
  block: HTMLElement,
  container: HTMLElement,
  start: number,
  end: number,
): Array<{ node: Text; from: number; to: number }> {
  const out: Array<{ node: Text; from: number; to: number }> = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const text = current as Text;
    // Same <pre> exclusion as `blockText`, so the raw offsets line up.
    if (isInCodeBlock(text, container)) continue;
    const len = text.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    offset = nodeEnd;
    if (nodeEnd <= start) continue;
    if (nodeStart >= end) break;
    const from = Math.max(0, start - nodeStart);
    const to = Math.min(len, end - nodeStart);
    if (from < to) out.push({ node: text, from, to });
  }
  return out;
}

/** Wrap the [from, to) substring of `text` in a span, splitting as needed. */
function wrapTextNodeRange(
  text: Text,
  from: number,
  to: number,
  className: string,
  attrs: Record<string, string>,
): HTMLSpanElement {
  let target = text;
  if (from > 0) target = target.splitText(from);
  if (to - from < target.length) target.splitText(to - from);
  const span = document.createElement("span");
  span.className = className;
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  target.parentNode?.insertBefore(span, target);
  span.appendChild(target);
  return span;
}

/**
 * Apply one relocated highlight to the container. Returns true if applied,
 * false if the window could not be mapped onto the DOM.
 */
export function applyResolvedHighlight(
  container: HTMLElement,
  h: ResolvedHighlight,
): boolean {
  const rawRange = rawRangeOf(h.block, h.startOffset, h.startOffset + h.length);
  if (!rawRange) return false;
  const [start, end] = rawRange;
  const ranges = textNodeRanges(h.block.element, container, start, end);
  if (ranges.length === 0) return false;

  // Wrap from last to first so earlier offsets aren't invalidated by splits.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { node, from, to } = ranges[i];
    wrapTextNodeRange(node, from, to, HIGHLIGHT_CLASS, {
      [ID_ATTR]: h.highlight.id,
      [COLOUR_ATTR]: h.highlight.colour,
    });
  }
  return true;
}

/**
 * Clear all prior wrappers, then apply every resolved highlight; reports
 * each orphan (via `onOrphan`) so the caller can surface it. Returns the
 * number of highlights applied.
 */
export function applyAllHighlights(
  container: HTMLElement,
  resolution: Resolution,
  onOrphan?: (h: Highlight) => void,
): number {
  clearAllHighlights(container);
  let applied = 0;
  for (const h of resolution.resolved) {
    if (applyResolvedHighlight(container, h)) applied += 1;
  }
  for (const o of resolution.orphaned) onOrphan?.(o.highlight);
  return applied;
}

/**
 * Run `fn` (the DOM mutations of a highlight re-apply) while preserving the
 * scroller's position: removing a wrapper span that the browser is using as
 * a scroll anchor makes Chrome/Safari jump (often to the top) when
 * scroll-anchoring fails to find a fallback. Ported from the upstream
 * Viewer's save/restore behaviour, factored here so the UI layer stays thin.
 */
export function withPreservedScroll(scroller: HTMLElement | null, fn: () => void): void {
  const saved = scroller?.scrollTop ?? 0;
  fn();
  if (scroller && scroller.scrollTop !== saved) {
    scroller.scrollTop = saved;
  }
}

/**
 * The passage text of the highlight identified by `id`, read from the live
 * DOM at copy time (spans are split per text node, so join them). Returns
 * null when the highlight is not currently rendered (orphaned).
 */
export function passageText(container: HTMLElement, id: string): string | null {
  const spans = container.querySelectorAll<HTMLSpanElement>(
    `span.${HIGHLIGHT_CLASS}[${ID_ATTR}="${CSS.escape(id)}"]`,
  );
  if (spans.length === 0) return null;
  return Array.from(spans)
    .map((s) => s.textContent ?? "")
    .join("");
}

/** Scroll the highlight identified by `id` into view, centred. */
export function scrollHighlightIntoView(container: HTMLElement, id: string): void {
  const span = container.querySelector<HTMLSpanElement>(
    `span.${HIGHLIGHT_CLASS}[${ID_ATTR}="${CSS.escape(id)}"]`,
  );
  if (span) span.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * If `node` (or any ancestor below `container`) is a highlight wrapper
 * span, return its id. Used to map click / keydown targets back to a
 * highlight.
 */
export function highlightIdAt(node: Node, container: HTMLElement): string | null {
  let cursor: Node | null = node;
  while (cursor && cursor !== container) {
    if (
      cursor instanceof HTMLElement &&
      cursor.classList.contains(HIGHLIGHT_CLASS)
    ) {
      return cursor.getAttribute(ID_ATTR);
    }
    cursor = cursor.parentNode;
  }
  return null;
}

/**
 * Bounding rect of the highlight identified by `id`. Returns null if the
 * highlight isn't currently rendered (orphaned).
 */
export function highlightRect(container: HTMLElement, id: string): DOMRect | null {
  const span = container.querySelector<HTMLSpanElement>(
    `span.${HIGHLIGHT_CLASS}[${ID_ATTR}="${CSS.escape(id)}"]`,
  );
  return span ? span.getBoundingClientRect() : null;
}

/**
 * Toggle the visual "edit-active" outline on a highlight by id. Pass null
 * to clear all outlines.
 */
export function setEditActive(container: HTMLElement, id: string | null): void {
  const previous = container.querySelectorAll<HTMLSpanElement>(
    `span.${HIGHLIGHT_CLASS}[data-edit-active="true"]`,
  );
  for (const span of Array.from(previous)) span.removeAttribute("data-edit-active");
  if (id) {
    const target = container.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[${ID_ATTR}="${CSS.escape(id)}"]`,
    );
    if (target) target.setAttribute("data-edit-active", "true");
  }
}
