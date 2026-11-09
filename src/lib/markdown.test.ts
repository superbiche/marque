import { describe, expect, it } from "vitest";
import { renderMarkdown, extractHeadings } from "./markdown";

describe("renderMarkdown", () => {
  it("renders a heading with an anchor", () => {
    const html = renderMarkdown("# Hello World");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello World");
    expect(html).toMatch(/id="hello-world"/);
  });

  it("renders GFM tables", () => {
    const md = `| a | b |\n|---|---|\n| 1 | 2 |\n`;
    const html = renderMarkdown(md);
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders task lists with checkboxes", () => {
    const md = `- [x] done\n- [ ] todo\n`;
    const html = renderMarkdown(md);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("renders fenced code blocks with language class", () => {
    const md = "```ts\nconst x = 1;\n```\n";
    const html = renderMarkdown(md);
    expect(html).toMatch(/<pre[^>]*><code class="language-ts">/);
  });

  it("flags mermaid blocks as pending for client-side rendering", () => {
    const md = "```mermaid\ngraph TD;A-->B;\n```\n";
    const html = renderMarkdown(md);
    expect(html).toContain("mermaid-pending");
    expect(html).toContain("graph TD");
  });

  it("adds target=_blank to external links", () => {
    const html = renderMarkdown("[ext](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("does not add target=_blank to relative links", () => {
    const html = renderMarkdown("[rel](./a.md)");
    expect(html).not.toContain('target="_blank"');
  });

  describe("local images", () => {
    const toAssetUrl = (p: string) => `asset://localhost/${encodeURIComponent(p)}`;
    const opts = { documentPath: "/docs/README.md", toAssetUrl };

    it("rewrites document-relative markdown images to asset URLs", () => {
      const html = renderMarkdown("![Diagram](diagram.png)", opts);
      expect(html).toContain('src="asset://localhost/%2Fdocs%2Fdiagram.png"');
      expect(html).toContain('alt="Diagram"');
    });

    it("rewrites raw <img> tags and parent-directory paths", () => {
      const html = renderMarkdown('<img src="../assets/logo.png" alt="logo">', opts);
      expect(html).toContain('src="asset://localhost/%2Fassets%2Flogo.png"');
    });

    it("leaves remote and data images untouched", () => {
      const html = renderMarkdown("![r](https://example.com/a.png)\n\n![d](data:image/png;base64,AAAA)", opts);
      expect(html).toContain('src="https://example.com/a.png"');
      expect(html).toContain('src="data:image/png;base64,AAAA"');
    });

    it("keeps relative sources as written when the document location is unknown", () => {
      expect(renderMarkdown("![x](diagram.png)", { toAssetUrl })).toContain('src="diagram.png"');
      expect(renderMarkdown("![x](diagram.png)")).toContain('src="diagram.png"');
    });

    it("keeps the original source when the runtime cannot map it", () => {
      const html = renderMarkdown("![x](diagram.png)", { documentPath: "/docs/a.md", toAssetUrl: () => null });
      expect(html).toContain('src="diagram.png"');
    });

    it("drops asset URLs written by the document itself", () => {
      const html = renderMarkdown('<img src="asset://localhost/%2Fetc%2Fpasswd">', opts);
      expect(html).toContain("<img");
      expect(html).not.toContain("asset://");
    });
  });

  it("sanitizes script tags", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\nokay");
    expect(html).not.toContain("<script");
    expect(html).toContain("okay");
  });

  it("renders strikethrough", () => {
    const html = renderMarkdown("~~gone~~");
    expect(html).toContain("<s>gone</s>");
  });

  it("renders blockquotes", () => {
    const html = renderMarkdown("> a quote");
    expect(html).toMatch(/<blockquote[^>]*>/);
  });

  it("strips YAML front matter at the top of the document", () => {
    const md = `---\ntitle: Hello\nauthor: someone\ndraft: false\n---\n\n# Hello\n\nFirst paragraph.\n`;
    const html = renderMarkdown(md);
    expect(html).not.toContain("title: Hello");
    expect(html).not.toContain("author: someone");
    expect(html).not.toContain("draft: false");
    expect(html).toContain("Hello");
    expect(html).toContain("First paragraph.");
  });

  it("does not strip a thematic break that is not front matter", () => {
    const md = `# Title\n\nBefore.\n\n---\n\nAfter.\n`;
    const html = renderMarkdown(md);
    expect(html).toContain("<hr");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
  });

  it("does not collapse a YAML block in the body into a setext heading", () => {
    // Front matter only applies at the very top. A `---`-bracketed block
    // mid-document remains regular CommonMark (thematic break + paragraph +
    // setext heading), which is the long-standing behaviour we are not changing.
    const md = `# Title\n\nIntro.\n\n---\nfoo: bar\n---\n`;
    const html = renderMarkdown(md);
    // The mid-document block must NOT be silently swallowed.
    expect(html).toContain("foo: bar");
  });
});

describe("extractHeadings", () => {
  it("returns level/text/slug for each heading", () => {
    const md = `# One\n\n## Two\n\n### Three`;
    const hs = extractHeadings(md);
    expect(hs).toHaveLength(3);
    expect(hs[0]).toMatchObject({ level: 1, text: "One", slug: "one" });
    expect(hs[1]).toMatchObject({ level: 2, text: "Two", slug: "two" });
    expect(hs[2]).toMatchObject({ level: 3, text: "Three", slug: "three" });
  });

  it("handles documents without headings", () => {
    expect(extractHeadings("just text\n\nmore text")).toEqual([]);
  });
});
