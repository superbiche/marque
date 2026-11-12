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

/**
 * Turn 16 raw bytes into a lowercase v4 UUID string, setting the version-4
 * and RFC-4122 variant (10xx) bits. Exported so the `getRandomValues`
 * fallback path in `newHighlightId` can be tested with a controlled byte
 * array (the reference test env has `crypto.randomUUID`, which short-circuits
 * the fallback).
 */
export function v4UuidFromBytes(b: Uint8Array): string {
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant (10xx)
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

/**
 * Generate a v4 UUID. Uses `crypto.randomUUID` when available; otherwise
 * builds one from `crypto.getRandomValues` (version-4 and RFC-4122 variant
 * bits set). Never `Math.random` — a predictable id could collide across
 * installs, and an id only needs to be unique, not secret.
 */
export function newHighlightId(): string {
  // Read through a local so the type-checker can't narrow the global `crypto`
  // to `never` across the randomUUID branch (it happens with a bare
  // `in`-check on the global).
  const c =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? globalThis.crypto
      : undefined;
  if (c) {
    if (typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return v4UuidFromBytes(bytes);
  }
  throw new Error("WebCrypto is unavailable; cannot generate a highlight id");
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
// **Why two 32-bit halves rather than `BigInt`:** the round mixes with 64-bit
// addition (a carry across the two halves) and 64-bit left rotates. Both are
// done here in native 32-bit integers (`u64Add` carries, `u64Rotl` handles the
// three rotate cases n < 32, n = 32, n > 32) with `>>> 0`, so a hash allocates
// nothing — which is what the (b)/(c) relocation scan hammers, re-hashing a
// sliding window many times per pass. The port is checked against all 64
// entries of `siphasher-1.0.3`'s `test_siphash_2_4` plus the four spec values
// in `highlights.test.ts`, so a carry/rotate off-by-one fails the suite.
//
// **Relocation cost:** the (b)/(c) scan slides a window of the stored length
// `L` across a block (or, in (c), every block) and re-hashes at each position,
// so the worst case is ≈ O(n·L) SipHash input bytes, where `n` is the
// document's total normalized length and `L ≤ MAX_PASSAGE_LENGTH` (100,000).
// A passage is in practice a few hundred bytes and the scan stops at the
// first hash match, so relocating a few-hundred-byte passage across a
// few-thousand-byte block is well under a millisecond; the worst case (a
// 100 kB passage sliding across a large block) is bounded by that product and
// is what the relocation cache below stops re-paying on unchanged blocks.
//
// **Output byte order:** the 64-bit digest is returned as 16 lowercase hex
// digits, **MSB-first** (high word, then low word). The `siphasher-1.0.3` reference
// table stores each digest as 8 *little-endian* bytes; the canonical hex used
// here is those bytes read MSB-first, i.e. the table entry reversed.
//
// The 128-bit key is two little-endian u64 words: `k0` from key bytes 0..7,
// `k1` from bytes 8..15.
// ---------------------------------------------------------------------------

/** A 64-bit value as `[hi, lo]`, each a 32-bit unsigned (`>>> 0`). */
type U64 = [hi: number, lo: number];

/** Little-endian 8 bytes at `off` -> `[hi, lo]` (bytes `off..off+3` are `lo`). */
function bytesToU64LE(bytes: Uint8Array, off: number): U64 {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 4; i++) lo |= bytes[off + i] << (8 * i);
  for (let i = 0; i < 4; i++) hi |= bytes[off + 4 + i] << (8 * i);
  return [hi >>> 0, lo >>> 0];
}

/** 64-bit addition, carrying from the low half into the high half. */
function u64Add(a: U64, b: U64): U64 {
  const lo = (a[1] + b[1]) >>> 0;
  const carry = lo < a[1] ? 1 : 0;
  return [(a[0] + b[0] + carry) >>> 0, lo];
}

/** 64-bit xor, half-wise. */
function u64Xor(a: U64, b: U64): U64 {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

/** 64-bit left-rotate by `n` (mod 64), across the two halves. */
function u64Rotl(hi: number, lo: number, n: number): U64 {
  n = ((n % 64) + 64) % 64;
  if (n === 0) return [hi >>> 0, lo >>> 0];
  if (n === 32) return [lo >>> 0, hi >>> 0];
  if (n < 32) {
    return [
      ((hi << n) | (lo >>> (32 - n))) >>> 0,
      ((lo << n) | (hi >>> (32 - n))) >>> 0,
    ];
  }
  const m = n - 32;
  return [
    ((lo << m) | (hi >>> (32 - m))) >>> 0,
    ((hi << m) | (lo >>> (32 - m))) >>> 0,
  ];
}

/** The four SipHash-2-4 constants, split into `[hi, lo]` words. */
const SIPHASH_C0: U64 = [0x736f6d65, 0x70736575];
const SIPHASH_C1: U64 = [0x646f7261, 0x6e646f6d];
const SIPHASH_C2: U64 = [0x6c796765, 0x6e657261];
const SIPHASH_C3: U64 = [0x74656462, 0x79746573];

/** One SipHash round (the `compress!` macro body from siphasher-1.0.3). */
function sipRound(v0: U64, v1: U64, v2: U64, v3: U64): [U64, U64, U64, U64] {
  v0 = u64Add(v0, v1);
  v1 = u64Xor(u64Rotl(v1[0], v1[1], 13), v0);
  v0 = u64Rotl(v0[0], v0[1], 32);
  v2 = u64Add(v2, v3);
  v3 = u64Xor(u64Rotl(v3[0], v3[1], 16), v2);
  v0 = u64Add(v0, v3);
  v3 = u64Xor(u64Rotl(v3[0], v3[1], 21), v0);
  v2 = u64Add(v2, v1);
  v1 = u64Xor(u64Rotl(v1[0], v1[1], 17), v2);
  v2 = u64Rotl(v2[0], v2[1], 32);
  return [v0, v1, v2, v3];
}

/**
 * SipHash-2-4 over `data`, keyed by the 16-byte `key`. Returns the 64-bit
 * digest as 16 lowercase hex digits (MSB-first). See the block comment above
 * for the reference source and the output byte-order convention.
 */
export function siphash24Hex(data: Uint8Array, key: Uint8Array): string {
  const k0 = bytesToU64LE(key, 0);
  const k1 = bytesToU64LE(key, 8);
  let v0 = u64Xor(k0, SIPHASH_C0);
  let v1 = u64Xor(k1, SIPHASH_C1);
  let v2 = u64Xor(k0, SIPHASH_C2);
  let v3 = u64Xor(k1, SIPHASH_C3);

  const len = data.length;
  const full = (len >> 3) << 3;
  for (let i = 0; i < full; i += 8) {
    const m = bytesToU64LE(data, i);
    v3 = u64Xor(v3, m);
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 = u64Xor(v0, m);
  }
  // Final block: the remaining bytes (little-endian in the low half) plus the
  // total length (mod 2^8) in the top byte.
  let bHi = ((len & 0xff) << 24) >>> 0;
  let bLo = 0;
  const rem = len - full;
  for (let j = 0; j < rem; j++) {
    const byte = data[full + j];
    if (j < 4) bLo |= byte << (8 * j);
    else bHi |= byte << (8 * (j - 4));
  }
  const b: U64 = [bHi >>> 0, bLo >>> 0];
  v3 = u64Xor(v3, b);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 = u64Xor(v0, b);
  v2 = u64Xor(v2, [0, 0xff]);
  for (let i = 0; i < 4; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  const out = u64Xor(u64Xor(v0, v1), u64Xor(v2, v3));
  return out[0].toString(16).padStart(8, "0") + out[1].toString(16).padStart(8, "0");
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

// ---------------------------------------------------------------------------
// Relocation window cache (item 8).
//
// `findWindow`'s sliding scan is the expensive step (≈ O(blockLen · L) SipHash
// bytes). Re-resolving an unchanged container (a re-render, a re-select, a
// re-apply) would re-scan every block for every highlight for nothing. This
// module-level cache memoizes the scan result per (block normalized text,
// anchor, key) so an unchanged block is not re-scanned. It is a pure function
// of its key, in-memory only, never persisted, and self-caps at
// MAX_WINDOW_CACHE entries (the oldest is dropped on overflow).
//
// The key digests the block's normalized text (three FNV-32s, 96 bits) plus
// its length, the anchor's hash and length, and a per-key identity (an integer
// in a `WeakMap`, so the cache is bound to *this* key and a different key —
// which changes every stored hash — misses cleanly). A "found" entry is
// re-verified with a single window hash before use (guards a digest
// collision); a "not found" entry is trusted as computed (step (a) already
// ran).
// ---------------------------------------------------------------------------

/** A keyed 64-bit hash: `data` -> 16-hex digest. `siphash24Hex` is the real one. */
type HashFn = (data: Uint8Array, key: Uint8Array) => string;

const MAX_WINDOW_CACHE = 4096;
const windowCache = new Map<string, number | null>();
// A stable integer per key object, so a cache entry is bound to the key that
// produced it. A WeakMap lets the identity die with the key.
const keyIdentity = new WeakMap<Uint8Array, number>();
let keyIdentityCounter = 0;
// Test support: a count of window hashes actually computed, so a test can
// prove a second resolve of an unchanged container is a cache hit.
let __hashCalls = 0;

/** Test hook: reset the hash-call counter. */
export function __resetRelocationStats(): void {
  __hashCalls = 0;
}
/** Test hook: window hashes computed since the last reset. */
export function __hashCallCount(): number {
  return __hashCalls;
}
/** Test hook: clear the relocation window cache (and the hash counter). */
export function __resetWindowCache(): void {
  windowCache.clear();
  __hashCalls = 0;
}

function keyIdOf(key: Uint8Array): number {
  let id = keyIdentity.get(key);
  if (id === undefined) {
    id = keyIdentityCounter++;
    keyIdentity.set(key, id);
  }
  return id;
}

/** FNV-1a 32 over a string, from a caller-supplied seed. */
function fnv32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 96-bit (three FNV-32) digest of a string, as a 24-hex-char tag. */
function textDigest(s: string): string {
  return (
    fnv32(s, 0x811c9dc5).toString(16).padStart(8, "0") +
    fnv32(s, 0x9dc5811c).toString(16).padStart(8, "0") +
    fnv32(s, 0x12345678).toString(16).padStart(8, "0")
  );
}

function windowCacheKey(text: string, anchor: HighlightAnchor, key: Uint8Array): string {
  return `${textDigest(text)}:${text.length}:${anchor.hash}:${anchor.length}:${keyIdOf(key)}`;
}

/**
 * Find a window of `anchor.length` matching `anchor.hash` in a block's
 * normalized text. Returns the window start, or null. Step (a) checks the
 * stored offset first (always a single hash); then, for the real keyed hash,
 * consults the relocation cache before any sliding scan. The scan keeps the
 * match closest to the stored offset (first one wins on a tie).
 */
function findWindow(
  text: string,
  anchor: HighlightAnchor,
  key: Uint8Array,
  hash: HashFn = siphash24Hex,
): number | null {
  if (anchor.length === 0 || text.length < anchor.length) return null;
  // `text` is already NFC + collapsed (the block's canonical text), so each
  // window is hashed directly without a redundant re-normalization.
  const windowHash = (start: number, len: number): string => {
    __hashCalls++;
    return hash(utf8(text.slice(start, start + len)), key);
  };

  // Step (a): the stored offset, always checked.
  if (anchor.startOffset + anchor.length <= text.length) {
    if (windowHash(anchor.startOffset, anchor.length) === anchor.hash) {
      return anchor.startOffset;
    }
  }

  // Only the real keyed hash reads/writes the shared cache (an injected
  // non-siphash hash has its own results and must not).
  const useCache = hash === siphash24Hex;
  const cacheKey = useCache ? windowCacheKey(text, anchor, key) : null;
  if (useCache) {
    const cached = windowCache.get(cacheKey!);
    if (cached !== undefined) {
      if (cached === null) return null; // not found: trust the prior scan
      // Re-verify a found position with a single window hash (collision guard).
      if (
        cached + anchor.length <= text.length &&
        windowHash(cached, anchor.length) === anchor.hash
      ) {
        return cached;
      }
      // Collision or text changed since: fall through and re-scan.
    }
  }

  // Full scan: slide a window of the stored length, keep the match closest to
  // the stored offset (first one wins on a tie).
  let best: number | null = null;
  for (let i = 0; i + anchor.length <= text.length; i++) {
    if (windowHash(i, anchor.length) !== anchor.hash) continue;
    if (best === null || Math.abs(i - anchor.startOffset) < Math.abs(best - anchor.startOffset)) {
      best = i;
    }
  }

  if (useCache) {
    if (windowCache.size >= MAX_WINDOW_CACHE) {
      const first = windowCache.keys().next().value;
      if (first !== undefined) windowCache.delete(first);
    }
    windowCache.set(cacheKey!, best);
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
  hash: HashFn = siphash24Hex,
): Resolution {
  const blocks = collectBlocks(container);
  const resolved: ResolvedHighlight[] = [];
  const orphaned: OrphanedHighlight[] = [];

  for (const h of highlights) {
    const target = blockForHighlight(blocks, h);
    let hit: { block: MappedBlock; startOffset: number } | null = null;
    if (target) {
      const off = findWindow(target.text, h.anchor, key, hash);
      if (off !== null) hit = { block: target, startOffset: off };
    }
    if (!hit) {
      for (const block of blocks) {
        if (block === target) continue;
        const off = findWindow(block.text, h.anchor, key, hash);
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
 *
 * Queries the heading elements that carry a `data-source-map` directly,
 * instead of `collectBlocks` (which builds a text map for *every* block —
 * wasted here, since we only need a heading's line range, which is in the
 * attribute).
 */
export function sectionHeadingForRange(
  container: HTMLElement,
  startLine: number,
  endLine: number,
): string {
  let best = "";
  let bestEnd = -1;
  const headings = container.querySelectorAll<HTMLElement>(
    "h1[data-source-map], h2[data-source-map], h3[data-source-map], h4[data-source-map], h5[data-source-map], h6[data-source-map]",
  );
  for (const el of Array.from(headings)) {
    const raw = el.getAttribute("data-source-map");
    if (!raw) continue;
    const [, end] = raw.split(",").map(Number);
    if (!Number.isFinite(end)) continue;
    if (end <= startLine && end > bestEnd) {
      bestEnd = end;
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
