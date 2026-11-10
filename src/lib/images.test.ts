import { describe, expect, it } from "vitest";
import { resolveLocalImagePath } from "./images";

describe("resolveLocalImagePath", () => {
  const doc = "/home/u/docs/README.md";

  it("resolves document-relative paths against the document directory", () => {
    expect(resolveLocalImagePath("diagram.png", doc)).toBe("/home/u/docs/diagram.png");
    expect(resolveLocalImagePath("./img/a.png", doc)).toBe("/home/u/docs/img/a.png");
    expect(resolveLocalImagePath("../shared/logo.svg", doc)).toBe("/home/u/shared/logo.svg");
  });

  it("keeps absolute paths and file URLs, decoding percent escapes", () => {
    expect(resolveLocalImagePath("/tmp/x/../y.png", doc)).toBe("/tmp/y.png");
    expect(resolveLocalImagePath("file:///home/u/pic%20one.png")).toBe("/home/u/pic one.png");
    expect(resolveLocalImagePath("file://localhost/home/u/p.png")).toBe("/home/u/p.png");
    expect(resolveLocalImagePath("my%20image.png", doc)).toBe("/home/u/docs/my image.png");
  });

  it("drops query strings and fragments", () => {
    expect(resolveLocalImagePath("a.png?v=2#frag", doc)).toBe("/home/u/docs/a.png");
  });

  it("returns null for remote, data, blob and other schemes", () => {
    expect(resolveLocalImagePath("https://example.com/a.png", doc)).toBeNull();
    expect(resolveLocalImagePath("//cdn.example.com/a.png", doc)).toBeNull();
    expect(resolveLocalImagePath("data:image/png;base64,AAAA", doc)).toBeNull();
    expect(resolveLocalImagePath("blob:abc", doc)).toBeNull();
    expect(resolveLocalImagePath("asset://localhost/%2Fetc%2Fpasswd", doc)).toBeNull();
  });

  it("returns null for relative paths without a known document location", () => {
    expect(resolveLocalImagePath("diagram.png")).toBeNull();
    expect(resolveLocalImagePath("diagram.png", "welcome")).toBeNull();
    expect(resolveLocalImagePath("", doc)).toBeNull();
    expect(resolveLocalImagePath("#anchor", doc)).toBeNull();
  });
});
