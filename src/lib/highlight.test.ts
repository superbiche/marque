import { describe, expect, it } from "vitest";
import { highlightCode } from "./highlight";

// Issue #49: printing must never need to re-render in light, so the Shiki
// output is theme-agnostic. Contract under test: the markup carries no
// inline colour at all — only --shiki-light-* / --shiki-dark-* variables —
// so the screen theme is chosen in CSS (markdown.css) and the print block
// there forces the light values.

// A real colour or background declaration is a keyword (not a custom
// property) followed by a colon, at the start of the style or after a `;`.
// The variable values themselves (hex colours) can never match: they are
// never preceded by `;`.
const inlineColourDecl = /(^|;)\s*(color|background|background-color)\s*:/;

describe("highlightCode (Shiki dual-theme output)", () => {
  it("emits both theme palettes as CSS variables, with no inline colour", async () => {
    const html = await highlightCode("const x: number = 42;", "typescript");

    const pre = html.match(/<pre [^>]*>/);
    expect(pre).not.toBeNull();
    // Both themes are named, so the CSS can target the palette it needs.
    expect(pre![0]).toMatch(/<pre class="shiki shiki-themes github-light github-dark"/);
    // The pre carries its own palette: the github-light/dark editor colours
    // (Shiki 4.6.0) — these values keep the on-screen output identical to
    // what the single-theme path used to paint inline.
    expect(pre![0]).toContain("--shiki-light-bg:#fff");
    expect(pre![0]).toContain("--shiki-dark-bg:#24292e");
    // Neither the pre nor any token span paints an inline colour.
    expect(html).not.toMatch(inlineColourDecl);
  });

  it("carries both palettes on every token span", async () => {
    const html = await highlightCode("fn main() {}", "rust");

    const tokenSpans = html.match(/<span style="[^"]*">/g) ?? [];
    expect(tokenSpans.length).toBeGreaterThan(0);
    for (const span of tokenSpans) {
      expect(span).toContain("--shiki-light:");
      expect(span).toContain("--shiki-dark:");
    }
    expect(html).not.toMatch(inlineColourDecl);
  });

  it("keeps the same contract for the unrecognised-language fallback", async () => {
    const html = await highlightCode("plain text with no theme", "wasm");

    const pre = html.match(/<pre [^>]*>/);
    expect(pre).not.toBeNull();
    expect(pre![0]).toMatch(/<pre class="shiki shiki-themes github-light github-dark"/);
    expect(html).not.toMatch(inlineColourDecl);
  });

  // A markdown fence is where Shiki emits font-* / text-decoration variables
  // (bold / italic / underline) instead of colour-only tokens. markdown.css
  // maps exactly these variable names onto font-weight / font-style /
  // text-decoration for screen light, screen dark and print; pinning them
  // here keeps that CSS contract from silently rotting if a Shiki build
  // renames or drops them.
  it("emits font-weight / font-style / text-decoration variables for markdown bold/italic/link", async () => {
    const code = "**bold** and *italic* and [a link](https://example.com)";
    const html = await highlightCode(code, "markdown");

    // Bold -> font-weight, italic -> font-style, link -> text-decoration, in
    // both the light and the dark palette.
    expect(html).toContain("--shiki-light-font-weight:bold");
    expect(html).toContain("--shiki-dark-font-weight:bold");
    expect(html).toContain("--shiki-light-font-style:italic");
    expect(html).toContain("--shiki-dark-font-style:italic");
    expect(html).toContain("--shiki-light-text-decoration:underline");
    expect(html).toContain("--shiki-dark-text-decoration:underline");
    // And, as for every other token, no inline colour.
    expect(html).not.toMatch(inlineColourDecl);
  });
});
