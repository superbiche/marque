import { describe, expect, it } from "vitest";
import { createRenderCacheKey, RenderCache } from "./renderCache";

describe("RenderCache", () => {
  it("evicts the least-recently-used entry", () => {
    const cache = new RenderCache(2);
    cache.set("first", "one");
    cache.set("second", "two");

    expect(cache.get("first")).toBe("one");
    cache.set("third", "three");

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("one");
    expect(cache.get("third")).toBe("three");
  });

  it("keys file path, source, and resolved theme independently", () => {
    const source = "# Document";
    const key = createRenderCacheKey("/docs/readme.md", source, "light");

    expect(createRenderCacheKey("/docs/readme.md", source, "light")).toBe(key);
    expect(createRenderCacheKey("/docs/other.md", source, "light")).not.toBe(key);
    expect(createRenderCacheKey("/docs/readme.md", "# Changed", "light")).not.toBe(key);
    expect(createRenderCacheKey("/docs/readme.md", source, "dark")).not.toBe(key);
  });
});
