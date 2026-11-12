import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOUR,
  HIGHLIGHT_COLOURS,
  anchorFromSelection,
  collectBlocks,
  emptyFile,
  findEnclosingBlock,
  findSectionHeading,
  fnv1a64,
  formatExportItem,
  formatExportList,
  isInCodeBlock,
  newHighlightId,
  normalizeText,
  resolveAnchors,
  sectionHeadingForRange,
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

describe("fnv1a64", () => {
  it("is deterministic and 64-bit (16 lowercase hex chars)", () => {
    const a = fnv1a64("hello world");
    const b = fnv1a64("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches the known FNV-1a 64-bit (UTF-16 code units) vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("hello world")).toBe("779a65e7023cd2e7");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("b")).toBe("af63df4c8601f1a5");
  });

  it("distinguishes inputs of the same length", () => {
    expect(fnv1a64("the quick brown fox")).toBe("59aeb7b40bd8c122");
    expect(fnv1a64("the quick brown fox")).not.toBe(fnv1a64("the quick brown cat"));
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
    const anchor = anchorFromSelection(range, root);
    expect(anchor).toEqual({
      startLine: 3,
      endLine: 5,
      startOffset: 0,
      length: 5,
      hash: fnv1a64("hello"),
    });
  });

  it("maps a mid-paragraph selection through the whitespace-collapse mapping", () => {
    // raw: "a    b" (a + 4 spaces + b) → collapsed "a b"; a selection that
    // starts at the 2nd space of the run and ends after "b" must land on
    // window "b" (offset 2, length 1), not on the isolated text.
    const root = makeContainer(`<p data-source-map="0,1">a    b</p>`);
    const range = select(root, "p", 2, 6);
    const anchor = anchorFromSelection(range, root);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(2);
    expect(anchor!.length).toBe(1);
    expect(anchor!.hash).toBe(fnv1a64("b"));
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
    const anchor = anchorFromSelection(range, root);
    expect(anchor).not.toBeNull();
    expect(anchor!.startOffset).toBe(4);
    expect(anchor!.length).toBe(8);
    expect(anchor!.hash).toBe(fnv1a64("a beta g"));
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
    const anchor = anchorFromSelection(range, root);
    expect(anchor).not.toBeNull();
    expect(anchor!.startLine).toBe(2);
    expect(anchor!.endLine).toBe(3);
    expect(anchor!.startOffset).toBe(6);
    expect(anchor!.length).toBe(10);
    expect(anchor!.hash).toBe(fnv1a64("beta gamma"));
  });

  it("refuses selections inside code blocks", () => {
    const root = makeContainer(`<pre data-source-map="0,2"><code>code here</code></pre>`);
    const range = select(root, "pre > code", 0, 4);
    expect(anchorFromSelection(range, root)).toBeNull();
  });

  it("refuses collapsed selections", () => {
    const root = makeContainer(`<p data-source-map="0,1">text</p>`);
    const range = select(root, "p", 0, 0);
    expect(anchorFromSelection(range, root)).toBeNull();
  });

  it("refuses selections outside the container", () => {
    const root = makeContainer(`<p data-source-map="0,1">inside</p>`);
    const other = makeContainer(`<p data-source-map="1,2">outside</p>`);
    const range = select(other, "p", 0, 3);
    expect(anchorFromSelection(range, root)).toBeNull();
  });

  it("refuses selections spanning multiple mapped blocks", () => {
    const root = makeContainer(`
      <p data-source-map="0,1">first</p>
      <p data-source-map="1,2">second</p>
    `);
    const range = document.createRange();
    range.setStart(firstText(root, "p:nth-of-type(1)"), 1);
    range.setEnd(firstText(root, "p:nth-of-type(2)"), 2);
    expect(anchorFromSelection(range, root)).toBeNull();
  });
});

describe("resolveAnchors", () => {
  // "this is a" is 9 normalized characters.
  const anchor: HighlightAnchor = {
    startLine: 3,
    endLine: 5,
    startOffset: 0,
    length: 9,
    hash: fnv1a64("this is a"),
  };

  it("(a) anchors at the stored offset when the block is unchanged", () => {
    const doc = makeContainer(`<p data-source-map="3,5">this is a plan, keep it.</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)]);
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
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)]);
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
      hash: fnv1a64("foo bar"),
    };
    const doc = makeContainer(`<p data-source-map="0,1">xx foo bar yy foo bar</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)]);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(3);
  });

  it("(c) follows the block to a shifted line range (edits above)", () => {
    // The block moved from lines 3–5 to 7–9; the stored anchor still matches.
    const doc = makeContainer(`<p data-source-map="7,9">this is a plan, keep it.</p>`);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(anchor)]);
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
      hash: fnv1a64("hello"),
    };
    const doc = makeContainer(`
      <p data-source-map="0,1">unrelated first paragraph</p>
      <p data-source-map="5,6">and then, hello appears here</p>
    `);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)]);
    expect(orphaned).toHaveLength(0);
    expect(resolved[0].startOffset).toBe(10);
    expect(resolved[0].block.start).toBe(5);
    expect(resolved[0].highlight.anchor.startLine).toBe(5);
    expect(resolved[0].highlight.anchor.endLine).toBe(6);
  });

  it("(d) orphans a highlight whose passage is gone, keeping it", () => {
    const doc = makeContainer(`<p data-source-map="3,5">totally different words</p>`);
    const highlight = makeHighlight(anchor);
    const { resolved, orphaned } = resolveAnchors(doc, [highlight]);
    expect(resolved).toHaveLength(0);
    expect(orphaned).toHaveLength(1);
    // The original highlight survives, reference and all — never dropped.
    expect(orphaned[0].highlight).toBe(highlight);
    expect(orphaned[0].highlight.anchor.hash).toBe(fnv1a64("this is a"));
  });

  it("ignores code blocks when scanning", () => {
    const a: HighlightAnchor = {
      startLine: 0,
      endLine: 1,
      startOffset: 0,
      length: 4,
      hash: fnv1a64("code"),
    };
    const doc = makeContainer(`
      <pre data-source-map="0,1"><code>code in a fence</code></pre>
      <p data-source-map="1,2">plain text only</p>
    `);
    const { resolved, orphaned } = resolveAnchors(doc, [makeHighlight(a)]);
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
    const anchor = anchorFromSelection(range, root);
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
      hash: fnv1a64("this is a"),
    };
    const resolution = resolveAnchors(doc, [makeHighlight(anchor)]);
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
      hash: fnv1a64("hello"),
    };
    const resolution = resolveAnchors(doc, [
      makeHighlight(anchor),
      makeHighlight({ ...anchor, hash: fnv1a64("absent passage") }, { id: "orphan-2" }),
    ]);
    expect(resolution.resolved).toHaveLength(1);
    expect(resolution.orphaned).toHaveLength(1);
    expect(applyAllHighlights(doc, resolution)).toBe(1);
    expect(passageText(doc, "h1")).toBe("hello");
    expect(passageText(doc, "orphan-2")).toBeNull();
  });
});
