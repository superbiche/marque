/**
 * Highlights — v2 data model: anchoring, relocation, and agent-export formatting.
 *
 * **The persisted model stores references only, never document content.**
 * A highlight pins its passage with:
 *   - the `[start, end)` line range of the enclosing block (the
 *     `data-source-map` attribute markdown-it emits on block tokens);
 *   - a character window (`startOffset`, `length`) in the block's
 *     normalized text;
 *   - a one-way 64-bit hash of the normalized passage.
 * The selected text itself is never persisted; only the user's own `note`
 * is. The section label (nearest heading above the block) is computed from
 * the live DOM at render/export time and never stored.
 *
 * On every render, `resolveAnchors` relocates each highlight, in order:
 *   (a) same block (by line range), stored offset, hash matches → anchored;
 *   (b) a window of the stored length matches the hash in that block
 *       (first match; if several, the one closest to the stored offset) →
 *       anchored;
 *   (c) the same scan over every block in the document (handles edits
 *       above that shift line numbers) → anchored, line range updated in
 *       memory;
 *   (d) otherwise → orphaned: kept and surfaced to the UI as orphaned
 *       (colour, note, original line range), never silently dropped.
 *
 * Code blocks (`<pre>`) are not highlightable.
 */

export const HIGHLIGHT_COLOURS = ["yellow", "orange", "pink", "blue", "purple"] as const;
export type HighlightColour = (typeof HIGHLIGHT_COLOURS)[number];

export const DEFAULT_COLOUR: HighlightColour = "yellow";

/** Persisted file format version. v1 (upstream marky) stored the passage text. */
export const HIGHLIGHT_FILE_VERSION = 2;

/** Enforced by `save_highlights` (Rust); mirrored here for early UI feedback. */
export const MAX_NOTE_LENGTH = 4000;
export const MAX_HIGHLIGHTS_PER_FILE = 2000;

export interface HighlightAnchor {
  /** [start, end) line range of the enclosing block's `data-source-map`. */
  startLine: number;
  endLine: number;
  /** Character offset of the passage within the block's normalized text. */
  startOffset: number;
  /** Passage length in normalized characters. */
  length: number;
  /** One-way 64-bit hash (hex) of the normalized passage; never the text. */
  hash: string;
}

export interface Highlight {
  id: string;
  colour: HighlightColour;
  anchor: HighlightAnchor;
  /** Optional per-item annotation — the only user text stored. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightsFile {
  version: 2;
  files: Record<string, Highlight[]>;
}

export function emptyFile(): HighlightsFile {
  return { version: 2, files: {} };
}

/** Generate a UUID-ish id without pulling in a dep. */
export function newHighlightId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The one text normalization used everywhere: NFC-normalize, then collapse
 * whitespace runs to single spaces. Offsets are computed on the collapsed
 * form (identical except for NFC), and the passage hash is always
 * `fnv1a64(normalizeText(window))` on both the anchoring and relocation
 * sides, so the two can only ever disagree when a combining sequence
 * straddles a window boundary — in that case the window simply doesn't
 * match and the highlight degrades to a scan or an orphan, never to the
 * wrong text.
 */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ");
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over UTF-16 code units. Deterministic and synchronous in
 * the webview and in Vitest (happy-dom) with no dependency. Output is
 * 16 lowercase hex chars. Used one-way only: the hash is what gets
 * persisted for the passage, never the text.
 */
export function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & U64_MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** Walk up to the nearest ancestor carrying `data-source-map`. */
export function findEnclosingBlock(
  node: Node,
  container: HTMLElement,
): { element: HTMLElement; start: number; end: number } | null {
  let current: Node | null = node;
  while (current && current !== container) {
    if (current instanceof HTMLElement && current.hasAttribute("data-source-map")) {
      const raw = current.getAttribute("data-source-map")!;
      const parts = raw.split(",").map(Number);
      if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        return { element: current, start: parts[0], end: parts[1] };
      }
    }
    current = current.parentNode;
  }
  return null;
}

/** True if the node (or any ancestor below `container`) is a `<pre>`. */
export function isInCodeBlock(node: Node, container: HTMLElement): boolean {
  let cursor: Node | null = node;
  while (cursor && cursor !== container) {
    if (cursor instanceof HTMLElement && cursor.tagName === "PRE") return true;
    cursor = cursor.parentNode;
  }
  return false;
}

/** Nearest preceding heading text (h1..h6). Returns "" if none found. */
export function findSectionHeading(block: HTMLElement, container: HTMLElement): string {
  let cursor: Element | null = block;
  while (cursor && cursor !== container) {
    let sibling: Element | null = cursor.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) {
        return (sibling.textContent || "").trim().replace(/^#\s*/, "");
      }
      const heading = sibling.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading) return (heading.textContent || "").trim().replace(/^#\s*/, "");
      sibling = sibling.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  return "";
}

/**
 * Block text in document order, excluding descendants inside `<pre>` (code
 * is not highlightable and must not participate in anchoring or relocation).
 */
export function blockText(block: HTMLElement, container: HTMLElement): string {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let out = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (isInCodeBlock(node, container)) continue;
    out += (node as Text).data;
  }
  return out;
}

/**
 * Map each raw (un-collapsed) character position of a block's text to its
 * position in the collapsed form: run-continuation whitespace maps to the
 * same position as the run's first (surviving) space. The final entry is
 * the collapsed length. (Also used by `highlightsApply` to invert the
 * mapping when wrapping DOM ranges.)
 */
export function rawToNormMap(raw: string): number[] {
  const map = new Array<number>(raw.length + 1);
  map[0] = 0;
  let pos = 0;
  for (let i = 0; i < raw.length; i++) {
    const inRun = i > 0 && /\s/.test(raw[i]) && /\s/.test(raw[i - 1]);
    if (!inRun) pos++;
    map[i + 1] = pos;
  }
  return map;
}

/**
 * Raw (un-collapsed) offset of a point (node, offset) inside the block,
 * counting only non-`<pre>` text (the same text `blockText` concatenates).
 *
 * Text-node points resolve by identity in walker order (no point comparison
 * at all). Element points sit on a child boundary; they are expressed as the
 * *adjacent* text node — the end of the last text node before the boundary,
 * or the start of the first text node after it — which reuses that reliable
 * identity path. This deliberately avoids `Range.comparePoint` and
 * `compareDocumentPosition`: both are directionally unreliable in the DOM
 * shim the tests run under (happy-dom), so anything built on them mis-resolves
 * a boundary that has text on both sides.
 */
function rawOffsetOf(
  block: HTMLElement,
  container: HTMLElement,
  pointNode: Node,
  pointOffset: number,
): number {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (isInCodeBlock(node, container)) continue;
    textNodes.push(node as Text);
  }

  // Starting offset of each non-<pre> text node in the concatenated raw text;
  // a map keeps the lookups below O(1).
  const startOffset = new Map<Text, number>();
  let acc = 0;
  for (const t of textNodes) {
    startOffset.set(t, acc);
    acc += t.length;
  }
  const total = acc;
  const offsetOf = (t: Text): number => startOffset.get(t) ?? total;

  if (pointNode.nodeType === Node.TEXT_NODE) {
    const t = pointNode as Text;
    const s = startOffset.get(t);
    return s === undefined ? total : s + pointOffset;
  }

  // Element point: the boundary between `pointNode`'s `pointOffset - 1`th
  // and `pointOffset`th child.
  const el = pointNode as Element;
  const children = el.childNodes;
  const prevChild =
    pointOffset > 0 && children[pointOffset - 1]
      ? (children[pointOffset - 1] as Node)
      : null;
  const nextChild =
    pointOffset < children.length && children[pointOffset]
      ? (children[pointOffset] as Node)
      : null;
  const contains = (t: Text, n: Node): boolean =>
    n.nodeType === Node.TEXT_NODE ? t === n : n.contains(t);

  // Express the boundary as the END of the nearest preceding text node.
  if (prevChild) {
    if (prevChild.nodeType === Node.TEXT_NODE) {
      return offsetOf(prevChild as Text) + (prevChild as Text).length;
    }
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (contains(textNodes[i], prevChild)) {
        return offsetOf(textNodes[i]) + textNodes[i].length;
      }
    }
  }
  // Otherwise express it as the START of the nearest following text node.
  if (nextChild) {
    if (nextChild.nodeType === Node.TEXT_NODE) {
      return offsetOf(nextChild as Text);
    }
    for (let i = 0; i < textNodes.length; i++) {
      if (contains(textNodes[i], nextChild)) {
        return offsetOf(textNodes[i]);
      }
    }
  }
  // No text on either side of the boundary (e.g. between two images): a
  // selection here is degenerate, so land at the end of the block's text.
  return total;
}

/**
 * Anchor a user selection to the source: line range from the enclosing
 * block's `data-source-map`, a character window in the block's normalized
 * text, and the one-way hash of the normalized passage.
 *
 * Returns `null` when the selection cannot be anchored: outside the
 * container, collapsed, inside a code block, or not contained in a single
 * source-mapped block.
 */
export function anchorFromSelection(range: Range, container: HTMLElement): HighlightAnchor | null {
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }
  if (
    isInCodeBlock(range.startContainer, container) ||
    isInCodeBlock(range.endContainer, container)
  ) {
    return null;
  }
  if (range.collapsed) return null;

  const block = findEnclosingBlock(range.commonAncestorContainer, container);
  if (!block) return null;

  const raw = blockText(block.element, container);
  const collapsed = raw.replace(/\s+/g, " ");
  const map = rawToNormMap(raw);
  const start = rawOffsetOf(block.element, container, range.startContainer, range.startOffset);
  const end = rawOffsetOf(block.element, container, range.endContainer, range.endOffset);
  if (start >= end) return null;

  const startOffset = map[start];
  const endOffset = map[end];
  const passage = collapsed.slice(startOffset, endOffset);
  if (!passage) return null;

  return {
    startLine: block.start,
    endLine: block.end,
    startOffset,
    length: passage.length,
    hash: fnv1a64(normalizeText(passage)),
  };
}

export interface MappedBlock {
  element: HTMLElement;
  start: number;
  end: number;
  /** Block text with whitespace runs collapsed to single spaces. */
  text: string;
}

/** All source-mapped blocks in the container, excluding code blocks. */
export function collectBlocks(container: HTMLElement): MappedBlock[] {
  const out: MappedBlock[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-source-map]"))) {
    if (el.tagName === "PRE" || isInCodeBlock(el, container)) continue;
    const raw = el.getAttribute("data-source-map");
    if (!raw) continue;
    const [start, end] = raw.split(",").map(Number);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ element: el, start, end, text: normalizeText(blockText(el, container)) });
  }
  return out;
}

/**
 * Find a window of `anchor.length` matching `anchor.hash` in a block's
 * normalized text. Returns the window start, or null. Step (a) checks the
 * stored offset first; then every window, keeping the match closest to the
 * stored offset (first one wins on a tie).
 */
function findWindow(text: string, anchor: HighlightAnchor): number | null {
  if (anchor.length === 0 || text.length < anchor.length) return null;
  if (
    anchor.startOffset + anchor.length <= text.length &&
    fnv1a64(normalizeText(text.slice(anchor.startOffset, anchor.startOffset + anchor.length))) ===
      anchor.hash
  ) {
    return anchor.startOffset;
  }
  let best: number | null = null;
  for (let i = 0; i + anchor.length <= text.length; i++) {
    if (fnv1a64(normalizeText(text.slice(i, i + anchor.length))) !== anchor.hash) continue;
    if (
      best === null ||
      Math.abs(i - anchor.startOffset) < Math.abs(best - anchor.startOffset)
    ) {
      best = i;
    }
  }
  return best;
}

/** The block a highlight points at: exact line-range match, else containment. */
function blockForHighlight(blocks: MappedBlock[], h: Highlight): MappedBlock | null {
  let containing: MappedBlock | null = null;
  for (const block of blocks) {
    if (
      block.start === h.anchor.startLine &&
      block.end === h.anchor.endLine
    ) {
      return block;
    }
    if (block.start <= h.anchor.startLine && block.end >= h.anchor.endLine && !containing) {
      containing = block;
    }
  }
  return containing;
}

export interface ResolvedHighlight {
  /** The highlight, with the anchor line range updated if relocation moved it. */
  highlight: Highlight;
  block: MappedBlock;
  /** Character window in the block's normalized text. */
  startOffset: number;
  length: number;
}

export interface OrphanedHighlight {
  highlight: Highlight;
}

export interface Resolution {
  resolved: ResolvedHighlight[];
  orphaned: OrphanedHighlight[];
}

/**
 * Relocate a batch of highlights against a rendered document. Resolution
 * order per item: (a) stored block + offset, (b) stored block + window
 * scan, (c) any block + window scan (line range updated in the returned
 * copy), (d) orphaned (kept, never dropped).
 */
export function resolveAnchors(container: HTMLElement, highlights: Highlight[]): Resolution {
  const blocks = collectBlocks(container);
  const resolved: ResolvedHighlight[] = [];
  const orphaned: OrphanedHighlight[] = [];

  for (const h of highlights) {
    const target = blockForHighlight(blocks, h);
    let hit: { block: MappedBlock; startOffset: number } | null = null;
    if (target) {
      const off = findWindow(target.text, h.anchor);
      if (off !== null) hit = { block: target, startOffset: off };
    }
    if (!hit) {
      for (const block of blocks) {
        if (block === target) continue;
        const off = findWindow(block.text, h.anchor);
        if (off !== null) {
          hit = { block, startOffset: off };
          break;
        }
      }
    }
    if (!hit) {
      orphaned.push({ highlight: h });
      continue;
    }
    const highlight =
      hit.block.start === h.anchor.startLine && hit.block.end === h.anchor.endLine
        ? h
        : { ...h, anchor: { ...h.anchor, startLine: hit.block.start, endLine: hit.block.end } };
    resolved.push({
      highlight,
      block: hit.block,
      startOffset: hit.startOffset,
      length: h.anchor.length,
    });
  }
  return { resolved, orphaned };
}

/**
 * Nearest heading above a line range, from the current DOM (used for
 * orphaned items, whose block can no longer be resolved). "" if none.
 */
export function sectionHeadingForRange(
  container: HTMLElement,
  startLine: number,
  endLine: number,
): string {
  let best = "";
  let bestEnd = -1;
  for (const block of collectBlocks(container)) {
    const el = block.element;
    if (!/^H[1-6]$/.test(el.tagName)) continue;
    if (block.end <= startLine && block.end > bestEnd) {
      bestEnd = block.end;
      best = (el.textContent || "").trim().replace(/^#\s*/, "");
    }
  }
  void endLine;
  return best;
}

// ---------------------------------------------------------------------------
// Agent-export formatting
// ---------------------------------------------------------------------------

/**
 * One highlight in the export: the passage is read from the live DOM at
 * copy time (never stored); `passage` is null when the highlight is
 * orphaned. `section` is computed from the live DOM; `lineRange` is the
 * current [start, end) block range (post-relocation for resolved items,
 * the original range for orphans).
 */
export interface ExportItem {
  highlight: Highlight;
  passage: string | null;
  section: string;
  lineRange: [number, number];
}

function fmtTime(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

/** Markdown-blockquote a passage. Keeps multi-line passages readable. */
function blockquote(passage: string): string {
  return passage
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Render a single highlight as an agent-friendly block. */
export function formatExportItem(item: ExportItem): string {
  const h = item.highlight;
  const lines: string[] = [];
  if (item.passage == null) {
    // Line range as humans read it: 1-based, inclusive of both ends
    // ([start, end) token map → start+1 … end).
    lines.push(
      blockquote(`(passage no longer found — originally lines ${item.lineRange[0] + 1}–${item.lineRange[1]})`),
    );
  } else {
    lines.push(blockquote(item.passage));
  }
  if (item.section) lines.push(`Section: ${item.section}`);
  lines.push(`Timestamp: ${fmtTime(h.createdAt)}`);
  if (h.note && h.note.trim()) lines.push(`Note: ${h.note.trim()}`);
  return lines.join("\n");
}

/**
 * Render all highlights for a file, grouped by colour in the canonical
 * order. This is the changelist format pasted to a coding agent at the end
 * of a review session. Orphaned items export their line range, section
 * (when still findable) and note with a "passage no longer found" marker.
 */
export function formatExportList(filePath: string, items: ExportItem[]): string {
  if (items.length === 0) return "";
  const grouped = new Map<HighlightColour, ExportItem[]>();
  for (const colour of HIGHLIGHT_COLOURS) grouped.set(colour, []);
  for (const item of items) grouped.get(item.highlight.colour)?.push(item);

  const out: string[] = [`Source: ${filePath}`, ""];
  for (const colour of HIGHLIGHT_COLOURS) {
    const group = grouped.get(colour) ?? [];
    if (group.length === 0) continue;
    out.push(`## List: ${colour}`, "");
    for (const item of group) {
      out.push(formatExportItem(item), "");
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
