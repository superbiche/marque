import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOUR,
  HIGHLIGHT_COLOURS,
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
  resolutionToEntries,
  resolveAnchors,
  sectionHeadingForRange,
  siphash24Hex,
  utf8,
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

  it("matches the known SipHash-2-4 vectors (siphasher-1.0.3 reference table, key 00 01 … 0f)", () => {
    // Entries 0, 1, 8, 15 of `test_siphash_2_4` in siphasher 1.0.3 — the
    // values specified for the highlights store: message = the byte
    // sequence 0, 1, …, len-1. The table stores each digest as 8
    // little-endian bytes; the spec hex reads those bytes MSB-first.
    expect(siphash24Hex(new Uint8Array(0), TEST_KEY)).toBe("726fdb47dd0e0e31");
    expect(siphash24Hex(new Uint8Array([0]), TEST_KEY)).toBe("74f839c593dc67fd");
    expect(
      siphash24Hex(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]), TEST_KEY),
    ).toBe("93f5f5799a932462");
    expect(
      siphash24Hex(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), TEST_KEY),
    ).toBe("a129ca6149be45e5");
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

  it("collapsed whitespace maps forward and back to the first raw character of the run", () => {
    const raw = "a  b";
    const map = buildTextMap(raw);
    expect(map.text).toBe("a b");
    expect(mapForward(map, raw.length)).toBe(map.text.length);
    // Normalized 2 is after the single collapsed space; the inverse lands on
    // the first raw character of the (raw) whitespace run it came from.
    expect(mapForward(map, 2)).toBe(2);
    expect(mapInverse(map, 2)).toBe(2);
    expect(mapInverse(map, 3)).toBe(raw.length);
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
