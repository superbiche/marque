import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COLOUR,
  HIGHLIGHT_COLOURS,
  __hashCallCount,
  __resetRelocationStats,
  __resetWindowCache,
  anchorFromSelection,
  buildTextMap,
  collectBlocks,
  emptyFile,
  findEnclosingBlock,
  findSectionHeading,
  formatExportItem,
  formatExportList,
  hexToBytes16,
  isInCodeBlock,
  mapForward,
  mapInverse,
  newHighlightId,
  normalizeText,
  passageWithinLimits,
  resolutionToEntries,
  resolveAnchors,
  sectionHeadingForRange,
  siphash24Hex,
  utf8,
  v4UuidFromBytes,
  type Highlight,
  type HighlightAnchor,
  type HighlightColour,
} from "./highlights";
import {
  applyAllHighlights,
  clearAllHighlights,
  HIGHLIGHT_CLASS,
  passageText,
} from "./highlightsApply";

/** Test-only 16-byte key: bytes 00 01 … 0f (the SipHash-2-4 reference key). */
const TEST_KEY = Uint8Array.from({ length: 16 }, (_, i) => i);

/** Canonical test hash: SipHash-2-4 over the UTF-8 bytes of the normalized passage. */
const h = (s: string) => siphash24Hex(utf8(normalizeText(s)), TEST_KEY);

// The relocation window cache is module-level; start each test cold so the
// cache (and its hash counter) never leaks state between tests.
beforeEach(() => __resetWindowCache());

function makeContainer(html: string): HTMLElement {
  const container = document.createElement("article");
  container.innerHTML = html;
  return container;
}

function firstText(container: HTMLElement, selector: string): Text {
  return container.querySelector<HTMLElement>(selector)!.firstChild as Text;
}

function select(
  container: HTMLElement,
  selector: string,
  from: number,
  to: number,
): Range {
  const node = firstText(container, selector);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  return range;
}

function makeHighlight(
  anchor: HighlightAnchor,
  overrides: Partial<Highlight> = {},
): Highlight {
  return {
    id: "h1",
    colour: "yellow",
    anchor,
    createdAt: "2026-04-29T15:30:00.000Z",
    updatedAt: "2026-04-29T15:30:00.000Z",
    ...overrides,
  };
}

describe("HIGHLIGHT_COLOURS", () => {
  it("contains a stable ordered set of five colours", () => {
    expect(HIGHLIGHT_COLOURS).toEqual(["yellow", "orange", "pink", "blue", "purple"]);
    expect(DEFAULT_COLOUR).toBe("yellow");
  });
});

describe("emptyFile", () => {
  it("produces a version-2 empty file", () => {
    expect(emptyFile()).toEqual({ version: 2, files: {} });
  });
});

describe("newHighlightId", () => {
  it("returns unique strings", () => {
    const a = newHighlightId();
    const b = newHighlightId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("normalizeText", () => {
  it("collapses whitespace runs to single spaces", () => {
    expect(normalizeText("a\t\n  b   c")).toBe("a b c");
  });

  it("NFC-normalizes combining sequences", () => {
    expect(normalizeText("cafe\u0301")).toBe("café");
  });
});

describe("siphash24Hex", () => {
  it("is deterministic and 64-bit (16 lowercase hex chars)", () => {
    const a = h("hello world");
    const b = h("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches all 64 vectors of the siphasher-1.0.3 reference table (key 00 01 … 0f)", () => {
    // The complete `test_siphash_2_4` table from siphasher-1.0.3
    // (src/tests.rs), transcribed verbatim: entry t is the SipHash-2-4
    // digest of the byte sequence 0, 1, …, t-1 under key 00 01 … 0f,
    // stored as 8 little-endian digest bytes. The canonical hex this
    // implementation produces reads those bytes MSB-first — i.e. the
    // table entry reversed — which the loop below applies.
    const vecs: [number, number, number, number, number, number, number, number][] = [
      [0x31, 0x0e, 0x0e, 0xdd, 0x47, 0xdb, 0x6f, 0x72],
      [0xfd, 0x67, 0xdc, 0x93, 0xc5, 0x39, 0xf8, 0x74],
      [0x5a, 0x4f, 0xa9, 0xd9, 0x09, 0x80, 0x6c, 0x0d],
      [0x2d, 0x7e, 0xfb, 0xd7, 0x96, 0x66, 0x67, 0x85],
      [0xb7, 0x87, 0x71, 0x27, 0xe0, 0x94, 0x27, 0xcf],
      [0x8d, 0xa6, 0x99, 0xcd, 0x64, 0x55, 0x76, 0x18],
      [0xce, 0xe3, 0xfe, 0x58, 0x6e, 0x46, 0xc9, 0xcb],
      [0x37, 0xd1, 0x01, 0x8b, 0xf5, 0x00, 0x02, 0xab],
      [0x62, 0x24, 0x93, 0x9a, 0x79, 0xf5, 0xf5, 0x93],
      [0xb0, 0xe4, 0xa9, 0x0b, 0xdf, 0x82, 0x00, 0x9e],
      [0xf3, 0xb9, 0xdd, 0x94, 0xc5, 0xbb, 0x5d, 0x7a],
      [0xa7, 0xad, 0x6b, 0x22, 0x46, 0x2f, 0xb3, 0xf4],
      [0xfb, 0xe5, 0x0e, 0x86, 0xbc, 0x8f, 0x1e, 0x75],
      [0x90, 0x3d, 0x84, 0xc0, 0x27, 0x56, 0xea, 0x14],
      [0xee, 0xf2, 0x7a, 0x8e, 0x90, 0xca, 0x23, 0xf7],
      [0xe5, 0x45, 0xbe, 0x49, 0x61, 0xca, 0x29, 0xa1],
      [0xdb, 0x9b, 0xc2, 0x57, 0x7f, 0xcc, 0x2a, 0x3f],
      [0x94, 0x47, 0xbe, 0x2c, 0xf5, 0xe9, 0x9a, 0x69],
      [0x9c, 0xd3, 0x8d, 0x96, 0xf0, 0xb3, 0xc1, 0x4b],
      [0xbd, 0x61, 0x79, 0xa7, 0x1d, 0xc9, 0x6d, 0xbb],
      [0x98, 0xee, 0xa2, 0x1a, 0xf2, 0x5c, 0xd6, 0xbe],
      [0xc7, 0x67, 0x3b, 0x2e, 0xb0, 0xcb, 0xf2, 0xd0],
      [0x88, 0x3e, 0xa3, 0xe3, 0x95, 0x67, 0x53, 0x93],
      [0xc8, 0xce, 0x5c, 0xcd, 0x8c, 0x03, 0x0c, 0xa8],
      [0x94, 0xaf, 0x49, 0xf6, 0xc6, 0x50, 0xad, 0xb8],
      [0xea, 0xb8, 0x85, 0x8a, 0xde, 0x92, 0xe1, 0xbc],
      [0xf3, 0x15, 0xbb, 0x5b, 0xb8, 0x35, 0xd8, 0x17],
      [0xad, 0xcf, 0x6b, 0x07, 0x63, 0x61, 0x2e, 0x2f],
      [0xa5, 0xc9, 0x1d, 0xa7, 0xac, 0xaa, 0x4d, 0xde],
      [0x71, 0x65, 0x95, 0x87, 0x66, 0x50, 0xa2, 0xa6],
      [0x28, 0xef, 0x49, 0x5c, 0x53, 0xa3, 0x87, 0xad],
      [0x42, 0xc3, 0x41, 0xd8, 0xfa, 0x92, 0xd8, 0x32],
      [0xce, 0x7c, 0xf2, 0x72, 0x2f, 0x51, 0x27, 0x71],
      [0xe3, 0x78, 0x59, 0xf9, 0x46, 0x23, 0xf3, 0xa7],
      [0x38, 0x12, 0x05, 0xbb, 0x1a, 0xb0, 0xe0, 0x12],
      [0xae, 0x97, 0xa1, 0x0f, 0xd4, 0x34, 0xe0, 0x15],
      [0xb4, 0xa3, 0x15, 0x08, 0xbe, 0xff, 0x4d, 0x31],
      [0x81, 0x39, 0x62, 0x29, 0xf0, 0x90, 0x79, 0x02],
      [0x4d, 0x0c, 0xf4, 0x9e, 0xe5, 0xd4, 0xdc, 0xca],
      [0x5c, 0x73, 0x33, 0x6a, 0x76, 0xd8, 0xbf, 0x9a],
      [0xd0, 0xa7, 0x04, 0x53, 0x6b, 0xa9, 0x3e, 0x0e],
      [0x92, 0x59, 0x58, 0xfc, 0xd6, 0x42, 0x0c, 0xad],
      [0xa9, 0x15, 0xc2, 0x9b, 0xc8, 0x06, 0x73, 0x18],
      [0x95, 0x2b, 0x79, 0xf3, 0xbc, 0x0a, 0xa6, 0xd4],
      [0xf2, 0x1d, 0xf2, 0xe4, 0x1d, 0x45, 0x35, 0xf9],
      [0x87, 0x57, 0x75, 0x19, 0x04, 0x8f, 0x53, 0xa9],
      [0x10, 0xa5, 0x6c, 0xf5, 0xdf, 0xcd, 0x9a, 0xdb],
      [0xeb, 0x75, 0x09, 0x5c, 0xcd, 0x98, 0x6c, 0xd0],
      [0x51, 0xa9, 0xcb, 0x9e, 0xcb, 0xa3, 0x12, 0xe6],
      [0x96, 0xaf, 0xad, 0xfc, 0x2c, 0xe6, 0x66, 0xc7],
      [0x72, 0xfe, 0x52, 0x97, 0x5a, 0x43, 0x64, 0xee],
      [0x5a, 0x16, 0x45, 0xb2, 0x76, 0xd5, 0x92, 0xa1],
      [0xb2, 0x74, 0xcb, 0x8e, 0xbf, 0x87, 0x87, 0x0a],
      [0x6f, 0x9b, 0xb4, 0x20, 0x3d, 0xe7, 0xb3, 0x81],
      [0xea, 0xec, 0xb2, 0xa3, 0x0b, 0x22, 0xa8, 0x7f],
      [0x99, 0x24, 0xa4, 0x3c, 0xc1, 0x31, 0x57, 0x24],
      [0xbd, 0x83, 0x8d, 0x3a, 0xaf, 0xbf, 0x8d, 0xb7],
      [0x0b, 0x1a, 0x2a, 0x32, 0x65, 0xd5, 0x1a, 0xea],
      [0x13, 0x50, 0x79, 0xa3, 0x23, 0x1c, 0xe6, 0x60],
      [0x93, 0x2b, 0x28, 0x46, 0xe4, 0xd7, 0x06, 0x66],
      [0xe1, 0x91, 0x5f, 0x5c, 0xb1, 0xec, 0xa4, 0x6c],
      [0xf3, 0x25, 0x96, 0x5c, 0xa1, 0x6d, 0x62, 0x9f],
      [0x57, 0x5f, 0xf2, 0x8e, 0x60, 0x38, 0x1b, 0xe5],
      [0x72, 0x45, 0x06, 0xeb, 0x4c, 0x32, 0x8a, 0x95],
    ];
    expect(vecs).toHaveLength(64);
    for (let t = 0; t < vecs.length; t++) {
      const msg = Uint8Array.from({ length: t }, (_, i) => i);
      const want = [...vecs[t]]
        .reverse()
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(siphash24Hex(msg, TEST_KEY)).toBe(want);
    }
  });

  it("is key-dependent (same message, different key -> different hash)", () => {
    const otherKey = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    expect(siphash24Hex(utf8("the quick brown fox"), TEST_KEY)).not.toBe(
      siphash24Hex(utf8("the quick brown fox"), otherKey),
    );
  });

  it("distinguishes inputs of the same length", () => {
    expect(h("the quick brown fox")).not.toBe(h("the quick brown cat"));
  });
});

describe("hexToBytes16", () => {
  it("decodes 32 lowercase hex characters to 16 bytes", () => {
    expect(hexToBytes16("000102030405060708090a0b0c0d0e0f")).toEqual(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    );
  });

  it("rejects the wrong length", () => {
    expect(hexToBytes16("000102030405060708090a0b0c0d0e")).toBeNull();
    expect(hexToBytes16("000102030405060708090a0b0c0d0e0f00")).toBeNull();
  });

  it("rejects uppercase and non-hex characters", () => {
    expect(hexToBytes16("000102030405060708090A0B0C0D0E0F")).toBeNull();
    expect(hexToBytes16("000102030405060708090a0b0c0d0e0g")).toBeNull();
  });
});

describe("buildTextMap / mapForward / mapInverse", () => {
  it("normalizes NFC + whitespace and exposes the raw -> normalized map", () => {
    const raw = "cafe\u0301 the passage";
    const map = buildTextMap(raw);
    expect(map.text).toBe("café the passage");
    expect(mapForward(map, 0)).toBe(0);
    // Raw 5 (the combining mark's own boundary) has already produced the
    // composed "café" (NFC length 4); raw 6 crosses the following space (5).
    expect(mapForward(map, 5)).toBe(4);
    expect(mapForward(map, 6)).toBe(5);
    expect(mapForward(map, raw.length)).toBe(map.text.length);
  });

  it("inverts: normalized boundaries of 'café the passage' map back to unit boundaries", () => {
    const raw = "cafe\u0301 the passage";
    const map = buildTextMap(raw);
    // The boundary inside the composed "é" (4: after the starter, before the
    // mark) resolves to the unit end — raw 5, after the combining mark — and
    // the boundary after the é (5) lands on the following starter.
    expect(mapInverse(map, 4)).toBe(5);
    expect(mapInverse(map, 5)).toBe(6);
    expect(mapInverse(map, map.text.length)).toBe(raw.length);
  });

  it("collapsed whitespace maps forward and back across the whole run", () => {
    const raw = "a  b";
    const map = buildTextMap(raw);
    expect(map.text).toBe("a b");
    expect(mapForward(map, raw.length)).toBe(map.text.length);
    // The two raw spaces produce one normalized space (position 1); "b" is
    // normalized 2. A boundary at a cluster's start lands on that cluster's
    // raw start, so the inverse of 2 is the "b" (raw 3) — a window ending at
    // 2 wraps the whole raw run, not just its first space.
    expect(mapForward(map, 2)).toBe(2);
    expect(mapInverse(map, 1)).toBe(1);
    expect(mapInverse(map, 2)).toBe(3);
    expect(mapInverse(map, 3)).toBe(raw.length);
  });

  it("maps a Bengali standalone vowel sign 1:1 (a mark outside the old hand-listed ranges)", () => {
    // U+09CE is a combining vowel sign with no base to compose with: one
    // grapheme cluster, NFC-stable.
    const raw = "\u09ce x";
    const map = buildTextMap(raw);
    expect(map.mappable).toBe(true);
    expect(map.text).toBe("\u09ce x");
    expect(mapForward(map, 2)).toBe(2);
    expect(mapInverse(map, 2)).toBe(2);
  });

  it("normalizes Hangul jamo as one grapheme cluster (L+V+T never split)", () => {
    // The 3 jamo are one grapheme cluster; per-cluster NFC composes them
    // where the platform composes them (full ICU -> one syllable; a
    // reduced ICU leaves them uncomposed) — either way the cluster is
    // never split across the mapping. The two spaces collapse to one.
    const jamo = "\u1100\u1135\u115e";
    const raw = `${jamo}  x`;
    const map = buildTextMap(raw);
    expect(map.mappable).toBe(true);
    expect(map.text).toBe(jamo.normalize("NFC") + " x");
    // The "x" is normalized at J+1 (J = the cluster's NFC length), and its
    // raw start is 5 (3 jamo + the collapsed 2-space run).
    expect(mapForward(map, 5)).toBe(map.text.length - 1);
    expect(mapForward(map, raw.length)).toBe(map.text.length);
    expect(mapInverse(map, map.text.length - 1)).toBe(5); // the "x"
  });

  it("keeps an emoji ZWJ family sequence as one cluster (code-unit identity)", () => {
    const family = "👨\u200d👩\u200d👧\u200d👦";
    const raw = `${family} x`;
    const map = buildTextMap(raw);
    expect(map.mappable).toBe(true);
    expect(map.text).toBe(`${family} x`);
    // The family is 11 code units (4 surrogate pairs + 3 ZWJ); a ZWJ
    // sequence is NFC-stable, so the map is the identity and the family
    // stays intact (never split mid-pair) in either direction.
    expect(mapForward(map, 11)).toBe(11);
    expect(mapForward(map, 12)).toBe(12);
    expect(mapForward(map, raw.length)).toBe(map.text.length);
    expect(mapInverse(map, 11)).toBe(11);
    expect(mapInverse(map, 12)).toBe(12);
  });

  it("is unmappable when per-cluster NFC cannot equal whole-string NFC (never a wrong range)", () => {
    // A segmenter that splits per code point (instead of per grapheme)
    // normalizes "e" and "\u0301" separately: their concatenation (5
    // code points) is not the whole-string NFC ("café x", 6 - 1). The
    // gate must mark the map unmappable rather than produce a wrong
    // offset.
    const RealSegmenter = Intl.Segmenter;
    class CodePointSegmenter {
      segment(input: string) {
        const out: { index: number }[] = [];
        let i = 0;
        for (const ch of input) {
          out.push({ index: i });
          i += ch.length;
        }
        return out;
      }
    }
    (Intl as { Segmenter: unknown }).Segmenter =
      CodePointSegmenter as unknown as typeof Intl.Segmenter;
    try {
      const map = buildTextMap("cafe\u0301 x");
      expect(map.mappable).toBe(false);
      expect(map.text).toBe("");
    } finally {
      (Intl as { Segmenter: unknown }).Segmenter = RealSegmenter;
    }
  });

  it("is unmappable when the platform has no Intl.Segmenter (no guaranteed mapping)", () => {
    const RealSegmenter = Intl.Segmenter;
    (Intl as { Segmenter: unknown }).Segmenter = undefined;
    try {
      const map = buildTextMap("a  b");
      expect(map.mappable).toBe(false);
      expect(map.text).toBe("");
    } finally {
      (Intl as { Segmenter: unknown }).Segmenter = RealSegmenter;
    }
  });
});

describe("findEnclosingBlock", () => {
  it("walks up to the nearest data-source-map ancestor", () => {
    const root = makeContainer(`<p data-source-map="3,5">hello <em>world</em></p>`);
    const em = root.querySelector("em")!;
    const block = findEnclosingBlock(em.firstChild!, root);
    expect(block).not.toBeNull();
    expect(block!.start).toBe(3);
    expect(block!.end).toBe(5);
    expect(block!.element.tagName).toBe("P");
  });

  it("returns null when no ancestor has the attribute", () => {
    const root = makeContainer(`<p>plain</p>`);
    const p = root.querySelector("p")!;
    expect(findEnclosingBlock(p.firstChild!, root)).toBeNull();
  });
});

describe("isInCodeBlock", () => {
  it("detects descendants of <pre>", () => {
    const root = makeContainer(`<pre data-source-map="0,2"><code>x</code></pre>`);
    const code = root.querySelector("code")!;
    expect(isInCodeBlock(code.firstChild!, root)).toBe(true);
  });

  it("returns false for normal paragraphs", () => {
    const root = makeContainer(`<p>plain</p>`);
    const p = root.querySelector("p")!;
    expect(isInCodeBlock(p.firstChild!, root)).toBe(false);
  });
});

describe("findSectionHeading", () => {
  it("finds the closest preceding heading at the same depth", () => {
    const root = makeContainer(`
      <h2>Installation</h2>
      <p data-source-map="3,4">Run npm install.</p>
      <h2>Usage</h2>
      <p data-source-map="6,7">Call run.</p>
    `);
    const blocks = root.querySelectorAll<HTMLElement>("p");
    expect(findSectionHeading(blocks[0], root)).toBe("Installation");
    expect(findSectionHeading(blocks[1], root)).toBe("Usage");
  });

  it("returns empty string when no heading precedes", () => {
    const root = makeContainer(`<p data-source-map="0,1">no heading</p>`);
    const p = root.querySelector("p")!;
    expect(findSectionHeading(p, root)).toBe("");
  });

  it("strips the permalink anchor symbol", () => {
    const root = makeContainer(`
      <h2><a href="#x" aria-hidden="true">#</a>Performance</h2>
      <p data-source-map="3,4">benchmarks</p>
    `);
    const p = root.querySelector("p")!;
    expect(findSectionHeading(p, root)).toMatch(/Performance/);
  });
});

describe("anchorFromSelection", () => {
  it("anchors a selection with the block's line range, offset, length and hash", () => {
    const root = makeContainer(`<p data-source-map="3,5">hello world, this is a plan.</p>`);
    const range = select(root, "p", 0, 5); // "hello"
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).toEqual({
      startLine: 3,
      endLine: 5,
      startOffset: 0,
      length: 5,
      hash: h("hello"),
    });
  });

  it("maps a mid-paragraph selection through the whitespace-collapse mapping", () => {
    // raw: "a    b" (a + 4 spaces + b) → collapsed "a b"; a selection that
    // starts at the 2nd space of the run and ends after "b" must land on
    // window "b" (offset 2, length 1), not on the isolated text.
    const root = makeContainer(`<p data-source-map="0,1">a    b</p>`);
    const range = select(root, "p", 2, 6);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(2);
    expect(anchor!.length).toBe(1);
    expect(anchor!.hash).toBe(h("b"));
  });

  it("anchors across inline element boundaries", () => {
    const root = makeContainer(`<p data-source-map="2,3">alpha <em>beta</em> gamma</p>`);
    const p = root.querySelector("p")!;
    const em = root.querySelector("em")!;
    // "alpha " is 6 chars; select from its last "a" (index 4) through 2
    // chars of the trailing " gamma": the passage is "a beta g" (8 chars,
    // indices 4..12 of the 16-char raw text).
    const range = document.createRange();
    range.setStart(p.firstChild!, 4);
    range.setEnd(em.nextSibling as Text, 2);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(4);
    expect(anchor!.length).toBe(8);
    expect(anchor!.hash).toBe(h("a beta g"));
  });

  it("anchors a selection whose start sits on an element child-boundary", () => {
    // The start point is (p, 1): the boundary after the "alpha " text node
    // and before the <em>. The raw text is "alpha beta gamma"; that boundary
    // is at raw offset 6, and the selection runs to the end of " gamma",
    // covering "beta gamma".
    const root = makeContainer(`<p data-source-map="2,3">alpha <em>beta</em> gamma</p>`);
    const p = root.querySelector("p")!;
    const t2 = root.querySelector("em")!.nextSibling as Text; // " gamma"
    const range = document.createRange();
    range.setStart(p, 1); // element child-boundary, not a text node
    range.setEnd(t2, t2.length);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startLine).toBe(2);
    expect(anchor!.endLine).toBe(3);
    expect(anchor!.startOffset).toBe(6);
    expect(anchor!.length).toBe(10);
    expect(anchor!.hash).toBe(h("beta gamma"));
  });

  it("refuses selections inside code blocks", () => {
    const root = makeContainer(`<pre data-source-map="0,2"><code>code here</code></pre>`);
    const range = select(root, "pre > code", 0, 4);
    expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
  });

  it("refuses collapsed selections", () => {
    const root = makeContainer(`<p data-source-map="0,1">text</p>`);
    const range = select(root, "p", 0, 0);
    expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
  });

  it("refuses selections outside the container", () => {
    const root = makeContainer(`<p data-source-map="0,1">inside</p>`);
    const other = makeContainer(`<p data-source-map="1,2">outside</p>`);
    const range = select(other, "p", 0, 3);
    expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
  });

  it("refuses selections spanning multiple mapped blocks", () => {
    const root = makeContainer(`
      <p data-source-map="0,1">first</p>
      <p data-source-map="1,2">second</p>
    `);
    const range = document.createRange();
    range.setStart(firstText(root, "p:nth-of-type(1)"), 1);
    range.setEnd(firstText(root, "p:nth-of-type(2)"), 2);
    expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
  });

  it("anchors a selection with decomposed text before the passage (NFC offset, not raw)", () => {
    // Raw: "cafe" + combining acute + " the passage" (17 chars). NFC:
    // "café the passage" (16 chars) — "the passage" starts at NFC offset 5,
    // not raw offset 6.
    const root = makeContainer(`<p data-source-map="1,2">cafe\u0301 the passage</p>`);
    const range = select(root, "p", 6, 17);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(5);
    expect(anchor!.length).toBe(11);
    expect(anchor!.hash).toBe(h("the passage"));
  });

  it("anchors a selection with decomposed text inside the passage (normalized length 4, not 5)", () => {
    // Raw: "the " + "cafe" + combining acute + " line" (14 chars). The
    // normalized window is "café" — 4 characters, not the 5 raw ones.
    const root = makeContainer(`<p data-source-map="1,2">the cafe\u0301 line</p>`);
    const range = select(root, "p", 4, 9);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(4);
    expect(anchor!.length).toBe(4);
    expect(anchor!.hash).toBe(h("café"));
  });

  it("anchors a selection of 'x' following a Bengali standalone vowel sign", () => {
    const root = makeContainer(`<p data-source-map="1,2">\u09ce x</p>`);
    const range = select(root, "p", 2, 3);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(2);
    expect(anchor!.length).toBe(1);
    expect(anchor!.hash).toBe(h("x"));
  });

  it("anchors a selection of 'x' after a Hangul syllable and a collapsed space run", () => {
    const root = makeContainer(`<p data-source-map="1,2">가  x</p>`);
    const range = select(root, "p", 3, 4);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(2);
    expect(anchor!.length).toBe(1);
    expect(anchor!.hash).toBe(h("x"));
  });

  it("anchors a whole emoji ZWJ family selection as one cluster", () => {
    const family = "👨\u200d👩\u200d👧\u200d👦";
    const root = makeContainer(`<p data-source-map="1,2">${family} x</p>`);
    const range = select(root, "p", 0, family.length);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(0);
    expect(anchor!.length).toBe(family.length); // 11 code units, intact
    expect(anchor!.hash).toBe(h(family));
  });

  it("refuses to anchor an unmappable block, and orphans a stored anchor on it", () => {
    const RealSegmenter = Intl.Segmenter;
    class CodePointSegmenter {
      segment(input: string) {
        const out: { index: number }[] = [];
        let i = 0;
        for (const ch of input) {
          out.push({ index: i });
          i += ch.length;
        }
        return out;
      }
    }
    (Intl as { Segmenter: unknown }).Segmenter =
      CodePointSegmenter as unknown as typeof Intl.Segmenter;
    try {
      const root = makeContainer(`<p data-source-map="1,2">cafe\u0301 x</p>`);
      const range = select(root, "p", 4, 5);
      expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
      const { resolved, orphaned } = resolveAnchors(
        root,
        [
          makeHighlight(
            {
              startLine: 1,
              endLine: 2,
              startOffset: 0,
              length: 4,
              hash: h("café"),
            },
            { id: "unmap-1" },
          ),
        ],
        TEST_KEY,
      );
      expect(resolved).toHaveLength(0);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].highlight.id).toBe("unmap-1");
    } finally {
      (Intl as { Segmenter: unknown }).Segmenter = RealSegmenter;
    }
  });

  it("refuses a passage over MAX_PASSAGE_LENGTH (F6, mirrors save_highlights)", () => {
    const big = "a".repeat(100_001);
    const root = makeContainer(`<p data-source-map="1,2">${big}</p>`);
    const range = select(root, "p", 0, big.length);
    expect(anchorFromSelection(range, root, TEST_KEY)).toBeNull();
  });

  it("allows a passage of exactly MAX_PASSAGE_LENGTH", () => {
    const big = "a".repeat(100_000);
    const root = makeContainer(`<p data-source-map="1,2">${big}</p>`);
    const range = select(root, "p", 0, big.length);
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(0);
    expect(anchor!.length).toBe(100_000);
  });

  it("passageWithinLimits mirrors the Rust stored-window bounds (F6)", () => {
    expect(passageWithinLimits(0, 100_000)).toBe(true);
    expect(passageWithinLimits(100_000, 100_000)).toBe(true);
    expect(passageWithinLimits(10_000_000, 1)).toBe(true);
    expect(passageWithinLimits(10_000_001, 1)).toBe(false);
    expect(passageWithinLimits(0, 100_001)).toBe(false);
  });
});

describe("resolveAnchors", () => {
  // "this is a" is 9 normalized characters.
  const anchor: HighlightAnchor = {
    startLine: 3,
    endLine: 5,
    startOffset: 0,
    length: 9,
    hash: h("this is a"),
  };

  it("(a) anchors at the stored offset when the block is unchanged", () => {
    const doc = makeContainer(`<p data-source-map="3,5">this is a plan, keep it.</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)], TEST_KEY);
    expect(resolved).toHaveLength(1);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(0);
    expect(resolved[0].length).toBe(9);
    expect(resolved[0].block.start).toBe(3);
    expect(resolved[0].block.end).toBe(5);
  });

  it("(b) relocates within the same block when the passage moved", () => {
    // "a prefix here, " is 15 chars, so the passage sits at offset 15.
    const doc = makeContainer(`<p data-source-map="3,5">a prefix here, this is a plan.</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)], TEST_KEY);
    expect(resolved).toHaveLength(1);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(15);
    expect(resolved[0].block.start).toBe(3);
    expect(resolved[0].block.end).toBe(5);
  });

  it("(b) with several matching windows, picks the one closest to the stored offset", () => {
    // "xx " (3) … first window at 3, second at 14; stored offset 0 → 3.
    const a: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 7,
      hash: h("foo bar"),
    };
    const doc = makeContainer(`<p data-source-map="0,1">xx foo bar yy foo bar</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)], TEST_KEY);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(3);
  });

  it("(c) follows the block to a shifted line range (edits above)", () => {
    // The block moved from lines 3–5 to 7–9; the stored anchor still matches.
    const doc = makeContainer(`<p data-source-map="7,9">this is a plan, keep it.</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)], TEST_KEY);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(0);
    // The line range is updated in the returned copy…
    expect(resolved[0].highlight.anchor.startLine).toBe(7);
    expect(resolved[0].highlight.anchor.endLine).toBe(9);
    // …while the caller's original object is left untouched.
    expect(anchor.startLine).toBe(3);
  });

  it("(c) finds the passage in a different block of the same document", () => {
    // "and then, " is 10 chars, so "hello" sits at offset 10 in block 5–6.
    const a: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 5,
      hash: h("hello"),
    };
    const doc = makeContainer(`
      <p data-source-map="0,1">unrelated first paragraph</p>
      <p data-source-map="5,6">and then, hello appears here</p>
    `);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)], TEST_KEY);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(10);
    expect(resolved[0].block.start).toBe(5);
    expect(resolved[0].highlight.anchor.startLine).toBe(5);
    expect(resolved[0].highlight.anchor.endLine).toBe(6);
  });

  it("(d) orphans a highlight whose passage is gone, keeping it", () => {
    const doc = makeContainer(`<p data-source-map="3,5">totally different words</p>`);
    const highlight = makeHighlight(anchor);
    const { resolved, orphaned } = resolveAnchors(doc, [highlight], TEST_KEY);
    expect(resolved).toHaveLength(0);
    expect(orphaned).toHaveLength(1);
    // The original highlight survives, reference and all — never dropped.
    expect(orphaned[0].highlight).toBe(highlight);
    expect(orphaned[0].highlight.anchor.hash).toBe(h("this is a"));
  });

  it("ignores code blocks when scanning", () => {
    const a: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 4,
      hash: h("code"),
    };
    const doc = makeContainer(`
      <pre data-source-map="0,1"><code>code in a fence</code></pre>
      <p data-source-map="1,2">plain text only</p>
    `);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)], TEST_KEY);
    expect(resolved).toHaveLength(0);
    expect(orphaned).toHaveLength(1);
  });
});

describe("newHighlightId (v4 UUID, never Math.random)", () => {
  it("returns a valid v4 UUID (version-4 and RFC-4122 variant nibbles)", () => {
    for (let i = 0; i < 50; i++) {
      const id = newHighlightId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("v4UuidFromBytes sets the version and variant bits on a known byte array", () => {
    const b = new Uint8Array(16).fill(0xab); // 0xab = 1010 1011
    const id = v4UuidFromBytes(b);
    // byte 6: (0xab & 0x0f)|0x40 = 0x4b; byte 8: (0xab & 0x3f)|0x80 = 0xab
    expect(id).toBe("abababab-abab-4bab-abab-abababababab");
    expect(id[14]).toBe("4"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant nibble
  });
});

describe("relocation window cache (item 8)", () => {
  it("a second resolve of an unchanged container is a cache hit (far fewer hashes)", () => {
    // One long block (~300 chars) and one short; an orphan anchor whose
    // passage is nowhere forces a full sliding scan of every block.
    const longText = "lorem ipsum dolor sit amet, consectetur. ".repeat(8);
    const doc = makeContainer(
      `<p data-source-map="0,1">${longText}</p>\n<p data-source-map="2,3">short block</p>`,
    );
    const orphan: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 3,
      hash: h("zzz"),
    };

    // The counter was reset by `beforeEach`, so the first resolve is a cold
    // pass: a full scan of the long block (hundreds of windows) plus the
    // short one — comfortably more than a couple of hashes.
    const first = resolveAnchors(doc, [makeHighlight(orphan)], TEST_KEY);
    expect(first.orphaned).toHaveLength(1);
    const coldHashes = __hashCallCount();
    expect(coldHashes).toBeGreaterThan(2);

    // Reset, then re-resolve the unchanged container: each block now costs
    // only its step-(a) hash (a cache hit is never a re-scan).
    __resetRelocationStats();
    const second = resolveAnchors(doc, [makeHighlight(orphan)], TEST_KEY);
    expect(second.orphaned).toHaveLength(1);
    const warmHashes = __hashCallCount();
    expect(warmHashes).toBeLessThan(coldHashes / 10);
  });

  it("a changed block is re-scanned (the cache key follows the text)", () => {
    // The same source-mapped block, different normalized text: the first
    // resolve (no "hello") is cached as not-found, but changing the text
    // changes the digest — so the second resolve must not reuse that stale
    // "not found" and must find the now-present passage.
    const doc = makeContainer(`<p data-source-map="0,1">totally different words</p>`);
    const a: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 5,
      hash: h("hello"),
    };
    const first = resolveAnchors(doc, [makeHighlight(a)], TEST_KEY);
    expect(first.orphaned).toHaveLength(1);
    // Change the block's text (the `data-source-map` range is untouched).
    const p = doc.querySelector("p")!;
    p.textContent = "and then, hello appears here";
    const second = resolveAnchors(doc, [makeHighlight(a)], TEST_KEY);
    expect(second.orphaned).toHaveLength(0);
    expect(second.resolved).toHaveLength(1);
    // "and then, " is 10 chars, so "hello" sits at offset 10.
    expect(second.resolved[0].startOffset).toBe(10);
  });
});

describe("collectBlocks / sectionHeadingForRange", () => {
  it("collects mapped blocks excluding code blocks", () => {
    const root = makeContainer(`
      <p data-source-map="0,1">text</p>
      <pre data-source-map="1,2"><code>code</code></pre>
      <blockquote data-source-map="2,3"><p>quoted</p></blockquote>
    `);
    const blocks = collectBlocks(root);
    expect(blocks.map((b) => b.element.tagName)).toEqual(["P", "BLOCKQUOTE"]);
  });

  it("finds the nearest heading above a line range", () => {
    const root = makeContainer(`
      <h2 data-source-map="0,1">Setup</h2>
      <p data-source-map="1,2">text</p>
      <h3 data-source-map="2,3">Details</h3>
      <p data-source-map="3,4">more</p>
    `);
    expect(sectionHeadingForRange(root, 1, 2)).toBe("Setup");
    expect(sectionHeadingForRange(root, 3, 4)).toBe("Details");
    expect(sectionHeadingForRange(root, 0, 1)).toBe("");
  });
});

describe("serialization keeps the reference-only contract", () => {
  it("a highlight created from a real selection serializes without passage or section text", () => {
    const root = makeContainer(`
      <h2 data-source-map="0,1">Secret Section Heading</h2>
      <p data-source-map="1,2">The zebra crosses the bridge at dawn.</p>
    `);
    const range = select(root, "p", 4, 25); // "crosses the bridge"
    const anchor = anchorFromSelection(range, root, TEST_KEY);
    expect(anchor).not.toBeNull();
    const highlight: Highlight = {
      id: "ser-1",
      colour: "blue",
      anchor: anchor!,
      note: "reword this",
      createdAt: "2026-04-29T15:30:00.000Z",
      updatedAt: "2026-04-29T15:30:00.000Z",
    };
    const json = JSON.stringify({ version: 2, files: { "/a.md": [highlight] } });
    expect(json).not.toContain("zebra");
    expect(json).not.toContain("bridge");
    expect(json).not.toContain("Secret Section Heading");
    expect(json).not.toContain('"passage"');
    expect(json).not.toContain('"section"');
    expect(json).toContain("reword this"); // the note is stored
  });
});

describe("agent export", () => {
  const mk = (colour: HighlightColour, note?: string) =>
    makeHighlight(
      {
        startLine: 3,
        endLine: 4,
        startOffset: 0,
        length: 5,
        hash: "0000000000000000",
      },
      { colour, note },
    );

  it("groups by colour in the canonical order", () => {
    const items = [
      { highlight: mk("purple"), passage: "p", section: "", lineRange: [0, 1] as [number, number] },
      { highlight: mk("yellow"), passage: "y", section: "", lineRange: [2, 3] as [number, number] },
      { highlight: mk("blue"), passage: "b", section: "", lineRange: [4, 5] as [number, number] },
    ];
    const out = formatExportList("/a.md", items);
    const yellowAt = out.indexOf("## List: yellow");
    const blueAt = out.indexOf("## List: blue");
    const purpleAt = out.indexOf("## List: purple");
    expect(yellowAt).toBeGreaterThan(-1);
    expect(yellowAt).toBeLessThan(blueAt);
    expect(blueAt).toBeLessThan(purpleAt);
    expect(out).not.toContain("## List: orange");
    expect(out).not.toContain("## List: pink");
  });

  it("blockquotes multi-line passages and omits empty buckets", () => {
    const items = [
      {
        highlight: mk("yellow"),
        passage: "first line\nsecond line",
        section: "Setup",
        lineRange: [2, 4] as [number, number],
      },
    ];
    const out = formatExportList("/a.md", items);
    expect(out).toContain("Source: /a.md");
    expect(out).toContain("> first line\n> second line");
    expect(out).toContain("Section: Setup");
    expect(out).toContain("Timestamp: 2026-04-29T15:30:00Z");
    expect(out).not.toContain("## List: pink");
  });

  it("emits a Note: line only when the note is non-blank", () => {
    const noNote = formatExportItem({
      highlight: mk("yellow"),
      passage: "x",
      section: "",
      lineRange: [1, 2] as [number, number],
    });
    expect(noNote).not.toContain("Note:");
    const blank = formatExportItem({
      highlight: mk("yellow", "   "),
      passage: "x",
      section: "",
      lineRange: [1, 2] as [number, number],
    });
    expect(blank).not.toContain("Note:");
    const real = formatExportItem({
      highlight: mk("yellow", "  rewrite it "),
      passage: "x",
      section: "",
      lineRange: [1, 2] as [number, number],
    });
    expect(real).toContain("Note: rewrite it");
  });

  it("exports an orphaned item with a 'passage no longer found' marker, line range and note", () => {
    const out = formatExportItem({
      highlight: mk("orange", "still want this fixed"),
      passage: null,
      section: "Setup",
      lineRange: [3, 5] as [number, number],
    });
    expect(out).toContain("> (passage no longer found — originally lines 4–5)");
    expect(out).toContain("Section: Setup");
    expect(out).toContain("Note: still want this fixed");
  });
});

describe("highlight span application (DOM)", () => {
  it("wraps the passage, keeps the text, and is cleared by clearAll", () => {
    const doc = makeContainer(`<p data-source-map="3,5">this is a plan, keep it.</p>`);
    const anchor: HighlightAnchor = {
      startLine: 3,
      endLine: 5,
      startOffset: 0,
      length: 9,
      hash: h("this is a"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor)], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);

    const span = doc.querySelector<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`);
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("this is a");
    expect(span!.getAttribute("data-highlight-id")).toBe("h1");
    expect(span!.getAttribute("data-highlight-colour")).toBe("yellow");
    // The surrounding text is untouched.
    expect(doc.querySelector("p")!.textContent).toBe("this is a plan, keep it.");

    // Idempotent: re-applying does not double-wrap.
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    expect(doc.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`)).toHaveLength(1);

    clearAllHighlights(doc);
    expect(doc.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`)).toHaveLength(0);
    expect(doc.querySelector("p")!.textContent).toBe("this is a plan, keep it.");
  });

  it("reports the live passage text and null for orphans", () => {
    const doc = makeContainer(`<p data-source-map="0,1">hello world, this is a plan</p>`);
    const anchor: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 5,
      hash: h("hello"),
    };
    const resolution = resolveAnchors(doc, [
      makeHighlight(anchor),
      makeHighlight({ ...anchor, hash: h("absent passage") }, { id: "orphan-2" }),
    ], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(resolution.orphaned).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    expect(passageText(doc, "h1")).toBe("hello");
    expect(passageText(doc, "orphan-2")).toBeNull();
  });

  it("wraps decomposed text as the exact raw span (NFC window of 4 chars -> raw 5 chars)", () => {
    // Raw: "the " + "cafe" + combining acute + " line". The normalized
    // window is "café" (4 chars) but the DOM span must cover the 5 raw
    // characters that produce it.
    const doc = makeContainer(`<p data-source-map="1,2">the cafe\u0301 line</p>`);
    const anchor: HighlightAnchor = {
      startLine: 1,
      endLine: 2,
      startOffset: 4,
      length: 4,
      hash: h("café"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor, { id: "w3" })], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    const span = doc.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[data-highlight-id="w3"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("cafe\u0301"); // the raw decomposed span
    expect(normalizeText(span!.textContent!)).toBe("café"); // 4, not 5
    // The full paragraph text is unchanged by wrapping.
    expect(doc.querySelector("p")!.textContent).toBe("the cafe\u0301 line");
  });

  it("wraps a window that follows decomposed text at the NFC offset (raw offset 6)", () => {
    // Raw: "cafe" + combining acute + " the passage". The normalized window
    // "the passage" starts at NFC offset 5, which maps back to raw offset 6.
    const doc = makeContainer(`<p data-source-map="1,2">cafe\u0301 the passage</p>`);
    const anchor: HighlightAnchor = {
      startLine: 1,
      endLine: 2,
      startOffset: 5,
      length: 11,
      hash: h("the passage"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor, { id: "w4" })], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    const span = doc.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[data-highlight-id="w4"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("the passage");
    // The decomposed prefix is left intact, outside the span.
    expect(doc.querySelector("p")!.textContent).toBe("cafe\u0301 the passage");
  });

  it("wraps a selection following a Bengali standalone vowel sign as exactly 'x'", () => {
    const doc = makeContainer(`<p data-source-map="1,2">\u09ce x</p>`);
    const anchor: HighlightAnchor = {
      startLine: 1,
      endLine: 2,
      startOffset: 2,
      length: 1,
      hash: h("x"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor, { id: "bengali-1" })], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    const span = doc.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[data-highlight-id="bengali-1"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("x"); // exactly the selected char, not the mark
    expect(doc.querySelector("p")!.textContent).toBe("\u09ce x");
  });

  it("wraps a selection after a Hangul syllable and collapsed spaces as exactly 'x'", () => {
    const doc = makeContainer(`<p data-source-map="1,2">가  x</p>`);
    const anchor: HighlightAnchor = {
      startLine: 1,
      endLine: 2,
      startOffset: 2,
      length: 1,
      hash: h("x"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor, { id: "hangul-1" })], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    const span = doc.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[data-highlight-id="hangul-1"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("x");
    // The whole raw space run stays intact outside the span.
    expect(doc.querySelector("p")!.textContent).toBe("가  x");
  });

  it("wraps an emoji ZWJ family selection as one span (cluster never split)", () => {
    const family = "👨\u200d👩\u200d👧\u200d👦";
    const doc = makeContainer(`<p data-source-map="1,2">${family} x</p>`);
    const anchor: HighlightAnchor = {
      startLine: 1,
      endLine: 2,
      startOffset: 0,
      length: family.length, // 11 code units, never mid-pair
      hash: h(family),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor, { id: "zwj-1" })], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    const span = doc.querySelector<HTMLSpanElement>(
      `span.${HIGHLIGHT_CLASS}[data-highlight-id="zwj-1"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe(family);
    expect(doc.querySelector("p")!.textContent).toBe(`${family} x`);
  });
});

describe("resolutionToEntries (F4/F8 panel projection)", () => {
  const containerHtml = `
    <h2 data-source-map="0,1">Alpha</h2>
    <p data-source-map="1,2">first passage here</p>
    <p data-source-map="3,4">second passage here</p>
  `;

  it("projects resolved rows (resolved passage/line range/section) and orphan rows (stored line range, null passage) in document order", () => {
    const root = makeContainer(containerHtml);
    const a = makeHighlight(
      { startLine: 1, endLine: 2, startOffset: 5, length: 13, hash: h("first passage") },
      { id: "A", colour: "yellow" },
    );
    // "zzz zzz" does not occur anywhere -> orphan; its stored line range
    // (3,4) is what the panel shows.
    const b = makeHighlight(
      { startLine: 3, endLine: 4, startOffset: 2, length: 6, hash: h("zzz zzz") },
      { id: "B", colour: "blue" },
    );
    const c = makeHighlight(
      { startLine: 3, endLine: 4, startOffset: 6, length: 14, hash: h("second passage") },
      { id: "C", colour: "purple" },
    );
    const resolution = resolveAnchors(root, [a, b, c], TEST_KEY);
    expect(resolution.resolved).toHaveLength(2);
    expect(resolution.orphaned).toHaveLength(1);

    const entries = resolutionToEntries(root, resolution);
    expect(entries).toHaveLength(3);

    // Document order: (1,*) before (3,*); within (3,*) by stored offset.
    expect(entries.map((e) => e.highlight.id)).toEqual(["A", "B", "C"]);

    const [ea, eb, ec] = entries;
    expect(ea!.orphaned).toBe(false);
    expect(ea!.lineRange).toEqual([1, 2]);
    expect(ea!.passage).toBe("first passage");
    expect(ea!.section).toBe("Alpha");

    // Orphan: the *stored* line range, no passage, section still labelled
    // from the nearest heading above the stored range.
    expect(eb!.orphaned).toBe(true);
    expect(eb!.lineRange).toEqual([3, 4]);
    expect(eb!.passage).toBeNull();
    expect(eb!.section).toBe("Alpha");

    expect(ec!.orphaned).toBe(false);
    expect(ec!.lineRange).toEqual([3, 4]);
    expect(ec!.passage).toBe("second passage");
    expect(ec!.section).toBe("Alpha");
  });

  it("reports a relocated row with the resolved (post-relocation) line range, not the stored one", () => {
    // The passage is stored against block (2,3) which no longer exists;
    // relocation moves it to block (1,2). The panel must show the new range.
    const root = makeContainer(`
      <h2 data-source-map="0,1">Alpha</h2>
      <p data-source-map="1,2">the relocated words here</p>
      <p data-source-map="4,5">unrelated tail</p>
    `);
    const a = makeHighlight(
      { startLine: 2, endLine: 3, startOffset: 4, length: 19, hash: h("the relocated words") },
      { id: "R", colour: "orange" },
    );
    const resolution = resolveAnchors(root, [a], TEST_KEY);
    expect(resolution.resolved).toHaveLength(1);
    const [entry] = resolutionToEntries(root, resolution);
    expect(entry!.orphaned).toBe(false);
    expect(entry!.lineRange).toEqual([1, 2]);
    expect(entry!.passage).toBe("the relocated words");
    // The caller's stored anchor is not mutated by resolution: relocation
    // is a read-time view (F8).
    expect(a.anchor.startLine).toBe(2);
    expect(a.anchor.endLine).toBe(3);
  });
});
