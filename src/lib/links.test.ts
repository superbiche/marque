import { describe, expect, it } from "vitest";
import { classifyLink, normalizePosixPath } from "./links";

describe("normalizePosixPath", () => {
  it("normalizes dot segments without using Node path APIs", () => {
    expect(normalizePosixPath("/docs/./guides/../intro.md")).toBe("/docs/intro.md");
    expect(normalizePosixPath("notes/../../guide.md")).toBe("../guide.md");
    expect(normalizePosixPath("/")).toBe("/");
  });
});

describe("classifyLink", () => {
  it("classifies decoded in-document anchors", () => {
    expect(classifyLink("#My%20Heading", "/docs/readme.md")).toEqual({
      kind: "anchor",
      slug: "My Heading",
    });
  });

  it.each([
    "https://example.com/docs",
    "http://example.com",
    "mailto:hello@example.com",
    "obsidian://open?vault=notes",
  ])(
    "classifies %s as external",
    (href) => {
      expect(classifyLink(href, "/docs/readme.md")).toEqual({ kind: "external", url: href });
    },
  );

  it("resolves relative markdown paths and fragments from the current document", () => {
    expect(classifyLink("./guide.md#Part%202", "/docs/reference/readme.md")).toEqual({
      kind: "markdown",
      path: "/docs/reference/guide.md",
      fragment: "Part 2",
    });
    expect(classifyLink("../../overview.MDX", "/docs/reference/api/readme.md")).toEqual({
      kind: "markdown",
      path: "/docs/overview.MDX",
    });
  });

  it("preserves absolute paths and recognizes every supported markdown extension", () => {
    expect(classifyLink("/shared/Guide.mdown#Install", "/docs/readme.md")).toEqual({
      kind: "markdown",
      path: "/shared/Guide.mdown",
      fragment: "Install",
    });
    expect(classifyLink("/shared/component.MKD", "/docs/readme.md")).toEqual({
      kind: "markdown",
      path: "/shared/component.MKD",
    });
    expect(classifyLink("/shared/notes.markdown")).toEqual({
      kind: "markdown",
      path: "/shared/notes.markdown",
    });
  });

  it("decodes filesystem paths and leaves non-markdown files for the system handler", () => {
    expect(classifyLink("../my%20notes.md", "/docs/current/readme.md")).toEqual({
      kind: "markdown",
      path: "/docs/my notes.md",
    });
    expect(classifyLink("./diagram.svg#layer-1", "/docs/readme.md")).toEqual({
      kind: "path",
      path: "/docs/diagram.svg",
    });
  });

  it("does not guess a relative path without a current document", () => {
    expect(classifyLink("./guide.md")).toEqual({ kind: "unresolved" });
    expect(classifyLink("../diagram.svg#part")).toEqual({ kind: "unresolved" });
  });
});
