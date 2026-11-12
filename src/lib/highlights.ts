/**
 * Highlights — v2 data model: anchoring, relocation, and agent-export formatting.
 *
 * **The persisted model stores references only, never document content.**
 * A highlight pins its passage with:
 *   - the `[start, end)` line range of the enclosing block (the
 *     `data-source-map` attribute markdown-it emits on block tokens);
 *   - a character window (`startOffset`, `length`) in the block's
 *     normalized text;
 *   - a keyed SipHash-2-4 fingerprint (16 lowercase hex) of the normalized
 *     passage, keyed by a per-installation secret that is never stored here.
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
/** Mirrors the `MAX_*` limits in `src-tauri/src/highlights.rs`; selections
 *  beyond them cannot round-trip through `save_highlights`. */
export const MAX_PASSAGE_LENGTH = 100_000;
export const MAX_START_OFFSET = 10_000_000;

/**
 * Whether a normalized window fits the stored-window limits (Rust enforces
 * the same bounds in `save_highlights` and drops anything else);
 * `anchorFromSelection` refuses to anchor a window that does not fit.
 */
export function passageWithinLimits(startOffset: number, length: number): boolean {
  return startOffset <= MAX_START_OFFSET && length <= MAX_PASSAGE_LENGTH;
}

export interface HighlightAnchor {
  /** [start, end) line range of the enclosing block's `data-source-map`. */
  startLine: number;
  endLine: number;
  /** Character offset of the passage within the block's normalized text. */
  startOffset: number;
  /** Passage length in normalized characters. */
  length: number;
  /** Keyed SipHash-2-4 fingerprint (16 lowercase hex) of the normalized
   *  passage; never the text. See `siphash24Hex`. */
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
 * whitespace runs to single spaces. This is the string a block's `text` and
 * the stored offset window live in. `buildTextMap` is the single raw ->
 * normalized mapping that produces this string and the offset coordinates,
 * so anchoring, relocation, and DOM wrapping all agree. The passage
 * fingerprint is `siphash24Hex` of the normalized window, computed the same
 * way on the anchoring and relocation sides.
 */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Keyed SipHash-2-4 (the anchor's fingerprint).
//
// Replaces the unkeyed FNV-1a 64 (a collision target: an attacker controlling
// a document could precompute a passage whose unkeyed hash matches one of our
// stored anchors and force a false "anchored" relocation). SipHash-2-4 is
// keyed by a random 128-bit key generated once per install and held in
// `highlights.key` next to highlights.json; the key is never written to
// highlights.json. Because the key is unknown to whoever authors a document,
// a forged passage cannot be made to match a stored hash.
//
// **Why BigInt rather than two 32-bit halves:** the SipHash round mixes with
// 64-bit addition (carries span the full word) and 64-bit rotates. A
// two-32-bit-halves implementation has to emulate the cross-half carry and
// rotate manually at every step — exactly the place a carry/rotate off-by-one
// corrupts the digest in a way that is trivial to miss in one direction and
// hard to catch. Native `BigInt` gives us exact 64-bit arithmetic for free and
// the port below is a line-for-line transcription of the reference
// `siphasher-1.0.3` `compress!` macro, so correctness reduces to matching the
// reference vectors (checked in `highlights.test.ts` against all 64 entries of
// `test_siphash_2_4` plus the four spec values). The cost is a handful of
// allocations per round; a passage is a few hundred bytes, so one hash is well
// under a millisecond, and the (b)/(c) relocation scan re-hashes at most
// O(n/8) 8-byte windows — measured at ~32 ms for 2000 such hashes of 50-byte
// windows, i.e. negligible for a viewer that hashes a handful of passages per
// render.
//
// **Output byte order:** the 64-bit digest is returned as 16 lowercase hex
// digits, **MSB-first** (`out.toString(16)`). The `siphasher-1.0.3` reference
// table stores each digest as 8 *little-endian* bytes; the canonical hex used
// here is those bytes read MSB-first, i.e. the table entry reversed.
//
// The 128-bit key is two little-endian u64 words: `k0` from key bytes 0..7,
// `k1` from bytes 8..15.
// ---------------------------------------------------------------------------

const SIPHASH_MASK = (1n << 64n) - 1n;

/** SipHash left-rotate of a 64-bit word. */
function rotl(x: bigint, n: bigint): bigint {
  return ((x << n) | (x >> (64n - n))) & SIPHASH_MASK;
}

/** One SipHash round (the `compress!` macro body from siphasher-1.0.3). */
function sipRound(v0: bigint, v1: bigint, v2: bigint, v3: bigint): [bigint, bigint, bigint, bigint] {
  v0 = (v0 + v1) & SIPHASH_MASK;
  v1 = rotl(v1, 13n) ^ v0;
  v0 = rotl(v0, 32n);
  v2 = (v2 + v3) & SIPHASH_MASK;
  v3 = rotl(v3, 16n) ^ v2;
  v0 = (v0 + v3) & SIPHASH_MASK;
  v3 = rotl(v3, 21n) ^ v0;
  v2 = (v2 + v1) & SIPHASH_MASK;
  v1 = rotl(v1, 17n) ^ v2;
  v2 = rotl(v2, 32n);
  return [v0, v1, v2, v3];
}

/**
 * SipHash-2-4 over `data`, keyed by the 16-byte `key`. Returns the 64-bit
 * digest as 16 lowercase hex digits (MSB-first). See the block comment above
 * for the reference source and the output byte-order convention.
 */
export function siphash24Hex(data: Uint8Array, key: Uint8Array): string {
  let k0 = 0n;
  let k1 = 0n;
  for (let i = 0; i < 8; i++) {
    k0 |= BigInt(key[i]) << BigInt(8 * i);
    k1 |= BigInt(key[8 + i]) << BigInt(8 * i);
  }
  let v0 = k0 ^ 0x736f6d6570736575n;
  let v1 = k1 ^ 0x646f72616e646f6dn;
  let v2 = k0 ^ 0x6c7967656e657261n;
  let v3 = k1 ^ 0x7465646279746573n;

  const len = data.length;
  const full = (len >> 3) << 3;
  for (let i = 0; i < full; i += 8) {
    let m = 0n;
    for (let j = 0; j < 8; j++) m |= BigInt(data[i + j]) << BigInt(8 * j);
    v3 = v3 ^ m;
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 = v0 ^ m;
  }
  // Final block: remaining bytes plus the total length (mod 2^8) in the top byte.
  let b = ((BigInt(len) & 0xffn) << 56n) & SIPHASH_MASK;
  for (let j = 0; j < len - full; j++) {
    b |= BigInt(data[full + j]) << BigInt(8 * j);
  }
  v3 = v3 ^ b;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 = v0 ^ b;
  v2 = v2 ^ 0xffn;
  for (let i = 0; i < 4; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  const out = (v0 ^ v1 ^ v2 ^ v3) & SIPHASH_MASK;
  return out.toString(16).padStart(16, "0");
}

/** UTF-8-encode a string to a byte array (for hashing its normalized passage). */
export function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s);
  }
  // Fallback (non-browser, non-happy-dom): manual UTF-8. Not expected in practice.
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

/**
 * Parse a 32-char lowercase-hex key (16 bytes) from Rust's `highlights.key`.
 * Returns `null` if the string is not exactly 16 bytes of hex — the caller
 * must treat that as "key unavailable" (no anchoring) rather than a crash.
 */
export function hexToBytes16(hex: string): Uint8Array | null {
  if (hex.length !== 32) return null;
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
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

// ---------------------------------------------------------------------------
// The single raw <-> normalized mapping, used identically for anchoring
// (`anchorFromSelection`), resolution (`resolveAnchors` / `findWindow`), and
// DOM wrapping (`highlightsApply.rawRangeOf`).
//
// `normalizeText` is NFC + whitespace-collapse. The raw DOM text of a block
// (what `blockText` concatenates) may be *decomposed* (e.g. "cafe\u0301") and
// may contain whitespace runs. A raw offset must therefore be mapped to the
// NFC + collapsed coordinate space in ONE place so the stored anchor, the
// resolution, and the DOM wrap all agree.
//
// The mapping is built on **grapheme clusters**: each cluster of the raw
// text is NFC-normalized on its own, the per-cluster results are
// concatenated, and whitespace is collapsed over them. For text whose
// per-cluster NFC concatenation equals the whole-string NFC (any
// well-formed combining arrangement), that is exactly `normalizeText(raw)`,
// and every normalized character maps back to the cluster it came from, so
// both directions land on cluster boundaries — never in the middle of a
// composed character, for any script (no hand-listed combining ranges).
//
// When the two NFC results differ (a combining mark composing across a
// cluster boundary) or the platform has no `Intl.Segmenter`, the map is
// *unmappable*: `text` is empty, `anchorFromSelection` refuses to anchor,
// and stored anchors on that block are treated as not found (orphaned).
// Never a wrong range.
//
// `buildTextMap(raw)` returns `text` (the NFC + collapsed text) and
// `forward[i]` = the number of normalized chars produced by the raw prefix
// raw[0..i) (i in UTF-16 code units), with `forward[raw.length] ===
// text.length`; `clusters` records each cluster's raw and normalized spans
// for the inverse mapping.
// ---------------------------------------------------------------------------

/**
 * Split `raw` into grapheme clusters (raw substring, raw start, and the
 * cluster's own NFC normalization). `null` when the platform has no
 * `Intl.Segmenter` — in that case no mapping can be guaranteed, so
 * `buildTextMap` marks the block unmappable rather than risk a wrong range.
 */
function graphemeClusters(
  raw: string,
): { raw: string; rawStart: number; nfc: string }[] | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return null;
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = [...segmenter.segment(raw)];
  const out: { raw: string; rawStart: number; nfc: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const end = i + 1 < segments.length ? segments[i + 1].index : raw.length;
    const sub = raw.slice(s.index, end);
    // A single code point is its own NFC form; only multi-code-point
    // clusters (decomposed sequences, surrogate pairs) need the call.
    out.push({ raw: sub, rawStart: s.index, nfc: sub.length === 1 ? sub : sub.normalize("NFC") });
  }
  return out;
}

export interface TextMapCluster {
  /** Raw (code-unit) span of the cluster in `raw`. */
  rawStart: number;
  rawEnd: number;
  /** Normalized (NFC + collapsed) span of the cluster in `text`. */
  outStart: number;
  outEnd: number;
}

export interface TextMap {
  /** NFC + whitespace-collapsed text (=== `normalizeText(raw)`); "" when
   *  unmappable. */
  text: string;
  /** `forward[i]` = normalized chars in the raw prefix raw[0..i) (code units). */
  forward: Uint32Array;
  /** The raw (pre-NFC) text the map was built from. */
  raw: string;
  /**
   * Whether the raw text could be mapped to `text` without loss. When false
   * (per-cluster NFC composition differs from whole-string NFC, or no
   * `Intl.Segmenter`), `text` is empty and no anchor may use this map:
   * anchoring returns `null`, and stored anchors on the block are treated
   * as not found (orphaned) — never a wrong range.
   */
  mappable: boolean;
  /** The cluster spans backing `mapInverse`; empty when unmappable. */
  clusters: TextMapCluster[];
}

/** Build the single raw -> (NFC + whitespace-collapse) mapping for `raw`. */
export function buildTextMap(raw: string): TextMap {
  const n = raw.length;
  const zero = new Uint32Array(n + 1);
  const unmappable = (): TextMap => ({
    text: "",
    forward: zero,
    raw,
    mappable: false,
    clusters: [],
  });

  const clusters = graphemeClusters(raw);
  if (!clusters) return unmappable(); // no Intl.Segmenter: no guaranteed mapping

  // Gate: the per-cluster NFC must compose to the whole-string NFC. A
  // violation means a combining mark composing across a cluster boundary —
  // an arrangement that cannot be mapped without a wrong range.
  let nfcLen = 0;
  for (const c of clusters) nfcLen += c.nfc.length;
  if (nfcLen !== raw.normalize("NFC").length) return unmappable();

  // Pass 1: the concatenated per-cluster NFC string and, for every raw
  // code-unit boundary, its position in that string. Identity clusters
  // (nfc === raw, the overwhelmingly common case) map 1:1 with no
  // normalize call; a normalizing cluster is short, so a per-prefix walk
  // is cheap.
  const nfcOfRaw = new Uint32Array(n + 1);
  let nfcConcat = "";
  for (const c of clusters) {
    nfcOfRaw[c.rawStart] = nfcConcat.length;
    if (c.nfc === c.raw) {
      for (let b = 1; b < c.raw.length; b++) {
        nfcOfRaw[c.rawStart + b] = nfcConcat.length + b;
      }
      nfcOfRaw[c.rawStart + c.raw.length] = nfcConcat.length + c.raw.length;
    } else {
      let prefix = "";
      for (let b = 0; b < c.raw.length; b++) {
        nfcOfRaw[c.rawStart + b] = nfcConcat.length + prefix.normalize("NFC").length;
        prefix += c.raw[b];
      }
      nfcOfRaw[c.rawStart + c.raw.length] = nfcConcat.length + c.nfc.length;
    }
    nfcConcat += c.nfc;
  }
  nfcOfRaw[n] = nfcConcat.length;

  // Pass 2: whitespace-collapse over the concatenated NFC (a run keeps its
  // first space). `collapsedOfNfc[j]` = chars produced by nfcConcat[0..j).
  const collapsedOfNfc = new Uint32Array(nfcConcat.length + 1);
  collapsedOfNfc[0] = 0;
  let inWs = false;
  let collapsed = "";
  for (let j = 0; j < nfcConcat.length; j++) {
    const ws = /\s/.test(nfcConcat[j]);
    if (ws) {
      if (!inWs) {
        collapsed += " ";
        inWs = true;
      }
    } else {
      collapsed += nfcConcat[j];
      inWs = false;
    }
    collapsedOfNfc[j + 1] = collapsed.length;
  }

  // Belt and braces: the result must be exactly `normalizeText(raw)`; any
  // remaining discrepancy means the per-cluster NFC differs in code points
  // (not just length) and the block is unmappable rather than wrong.
  if (collapsed !== normalizeText(raw)) return unmappable();

  const forward = new Uint32Array(n + 1);
  for (let k = 0; k <= n; k++) forward[k] = collapsedOfNfc[nfcOfRaw[k]];

  const clusterSpans: TextMapCluster[] = [];
  for (const c of clusters) {
    clusterSpans.push({
      rawStart: c.rawStart,
      rawEnd: c.rawStart + c.raw.length,
      outStart: collapsedOfNfc[nfcOfRaw[c.rawStart]],
      outEnd: collapsedOfNfc[nfcOfRaw[c.rawStart + c.raw.length]],
    });
  }
  return { text: collapsed, forward, raw, mappable: true, clusters: clusterSpans };
}

/** Normalized (NFC + collapsed) offset for a raw code-unit offset. */
export function mapForward(map: TextMap, rawIndex: number): number {
  if (rawIndex <= 0) return 0;
  if (rawIndex >= map.forward.length) return map.text.length;
  return map.forward[rawIndex];
}

/**
 * Raw code-unit offset for a normalized offset. The offset is assigned to
 * the grapheme cluster that owns it (clusters with a normalized span tile
 * the normalized text exactly): a boundary on a cluster's start lands on
 * the cluster's raw start, a boundary inside a cluster snaps to the
 * cluster's raw end. The result is always a cluster boundary: a window
 * ending on a composed character (e.g. "café") wraps the starter *and* its
 * marks, and a window starting after a composed character starts at the
 * following starter, never on a bare combining mark. Used to wrap the DOM
 * text corresponding to a normalized window.
 */
export function mapInverse(map: TextMap, normIndex: number): number {
  if (normIndex <= 0) return 0;
  if (normIndex >= map.text.length) return map.raw.length;
  for (const c of map.clusters) {
    if (c.outStart <= normIndex && normIndex < c.outEnd) {
      return normIndex === c.outStart ? c.rawStart : c.rawEnd;
    }
  }
  return map.raw.length;
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
export function anchorFromSelection(
  range: Range,
  container: HTMLElement,
  key: Uint8Array,
): HighlightAnchor | null {
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
  const map = buildTextMap(raw);
  if (!map.mappable) return null; // unmappable block: never a wrong range
  const start = rawOffsetOf(block.element, container, range.startContainer, range.startOffset);
  const end = rawOffsetOf(block.element, container, range.endContainer, range.endOffset);
  if (start >= end) return null;

  const startOffset = mapForward(map, start);
  const endOffset = mapForward(map, end);
  const passage = map.text.slice(startOffset, endOffset);
  if (!passage) return null;
  // The Rust side refuses these in `save_highlights`; refuse them at anchor
  // time too (F6).
  if (!passageWithinLimits(startOffset, passage.length)) return null;

  return {
    startLine: block.start,
    endLine: block.end,
    startOffset,
    length: passage.length,
    hash: siphash24Hex(utf8(passage), key),
  };
}

export interface MappedBlock {
  element: HTMLElement;
  start: number;
  end: number;
  /** NFC + whitespace-collapsed block text. */
  text: string;
  /** The single raw -> normalized map (also used to invert for DOM wrapping). */
  map: TextMap;
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
    const textMap = buildTextMap(blockText(el, container));
    out.push({ element: el, start, end, text: textMap.text, map: textMap });
  }
  return out;
}

/**
 * Find a window of `anchor.length` matching `anchor.hash` in a block's
 * normalized text. Returns the window start, or null. Step (a) checks the
 * stored offset first; then every window, keeping the match closest to the
 * stored offset (first one wins on a tie).
 */
function findWindow(text: string, anchor: HighlightAnchor, key: Uint8Array): number | null {
  if (anchor.length === 0 || text.length < anchor.length) return null;
  // `text` is already NFC + collapsed (the block's canonical text), so each
  // window is hashed directly without a redundant re-normalization.
  if (
    anchor.startOffset + anchor.length <= text.length &&
    siphash24Hex(utf8(text.slice(anchor.startOffset, anchor.startOffset + anchor.length)), key) ===
      anchor.hash
  ) {
    return anchor.startOffset;
  }
  let best: number | null = null;
  for (let i = 0; i + anchor.length <= text.length; i++) {
    if (siphash24Hex(utf8(text.slice(i, i + anchor.length)), key) !== anchor.hash) continue;
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
export function resolveAnchors(
  container: HTMLElement,
  highlights: Highlight[],
  key: Uint8Array,
): Resolution {
  const blocks = collectBlocks(container);
  const resolved: ResolvedHighlight[] = [];
  const orphaned: OrphanedHighlight[] = [];

  for (const h of highlights) {
    const target = blockForHighlight(blocks, h);
    let hit: { block: MappedBlock; startOffset: number } | null = null;
    if (target) {
      const off = findWindow(target.text, h.anchor, key);
      if (off !== null) hit = { block: target, startOffset: off };
    }
    if (!hit) {
      for (const block of blocks) {
        if (block === target) continue;
        const off = findWindow(block.text, h.anchor, key);
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
// Panel projection
// ---------------------------------------------------------------------------

/**
 * One row in the review panel, derived from a `Resolution` (never from the
 * live DOM). The panel used to re-derive its rows by reading the rendered
 * spans on every render, which raced the Viewer's wrapping effect and showed
 * freshly-created highlights orphaned or with stale text/lines. Deriving the
 * rows from the *same* resolution the Viewer applies keeps the panel, the
 * on-copy action, and the DOM wrap in lockstep (F4, F8).
 *
 * `lineRange` is the *resolved* block range for anchored items (post-relocation
 * for (b)/(c)) and the original stored range for orphans. `passage` is the
 * normalized window for anchored items and null for orphans.
 */
export interface PanelEntry {
  highlight: Highlight;
  lineRange: [number, number];
  passage: string | null;
  section: string;
  orphaned: boolean;
}

/**
 * Project a `Resolution` into panel rows, in document (line) order. Pure:
 * takes the container (for section headings) and the resolution only.
 */
export function resolutionToEntries(container: HTMLElement, resolution: Resolution): PanelEntry[] {
  const entries: PanelEntry[] = [];
  for (const h of resolution.resolved) {
    const passage = h.block.text.slice(h.startOffset, h.startOffset + h.length);
    entries.push({
      highlight: h.highlight,
      lineRange: [h.block.start, h.block.end],
      passage,
      section: findSectionHeading(h.block.element, container),
      orphaned: false,
    });
  }
  for (const o of resolution.orphaned) {
    entries.push({
      highlight: o.highlight,
      lineRange: [o.highlight.anchor.startLine, o.highlight.anchor.endLine],
      passage: null,
      section: sectionHeadingForRange(
        container,
        o.highlight.anchor.startLine,
        o.highlight.anchor.endLine,
      ),
      orphaned: true,
    });
  }
  // Stable order: by block start, then by stored start offset within the block.
  entries.sort(
    (a, b) =>
      a.lineRange[0] - b.lineRange[0] ||
      a.highlight.anchor.startOffset - b.highlight.anchor.startOffset,
  );
  return entries;
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
