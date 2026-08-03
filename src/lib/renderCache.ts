export type RenderTheme = "light" | "dark";

/**
 * Produces an unambiguous cache key for markup after syntax highlighting and
 * Mermaid rendering. Source is part of the key so disk changes invalidate the
 * cached result without a separate invalidation channel.
 */
export function createRenderCacheKey(
  filePath: string | undefined,
  source: string,
  theme: RenderTheme,
): string {
  return JSON.stringify([filePath ?? null, source, theme]);
}

export class RenderCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly capacity = 20) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;

    // Map iteration order is insertion order. Re-inserting a hit makes it
    // most-recently-used without allocating a second data structure.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, html: string): void {
    this.entries.delete(key);
    this.entries.set(key, html);

    if (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
  }
}

export const renderCache = new RenderCache();
