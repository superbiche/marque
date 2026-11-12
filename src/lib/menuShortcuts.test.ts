import { describe, expect, it } from "vitest";
import { nativeMenuOwnsKey } from "./menuShortcuts";

type Key = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

const key = (
  key: string,
  m: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): Key => ({
  key,
  metaKey: !!m.meta,
  ctrlKey: !!m.ctrl,
  shiftKey: !!m.shift,
  altKey: !!m.alt,
});

describe("nativeMenuOwnsKey", () => {
  it("never skips off macOS: the webview handler owns every shortcut", () => {
    for (const k of ["k", "o", "f", "p", "w", "\\", "=", "-", "0", "z"]) {
      expect(nativeMenuOwnsKey(false, key(k, { meta: true }))).toBe(false);
      expect(nativeMenuOwnsKey(false, key(k, { ctrl: true }))).toBe(false);
    }
    expect(nativeMenuOwnsKey(false, key("\\", { meta: true, shift: true }))).toBe(false);
  });

  it("on macOS, skips only the bare-Command keys the menu binds", () => {
    for (const k of ["k", "o", "f", "p", "w", "\\", "=", "-", "0"]) {
      expect(nativeMenuOwnsKey(true, key(k, { meta: true }))).toBe(true);
    }
  });

  it("on macOS, does not skip keys the handler never reacts to", () => {
    // Menu-only accelerators (⌘Z, ⌘A, …) and plain keys: no double-fire risk.
    for (const k of ["z", "a", "x", "c", "v", "m", "q", "h", "b"]) {
      expect(nativeMenuOwnsKey(true, key(k, { meta: true }))).toBe(false);
    }
    expect(nativeMenuOwnsKey(true, key("k"))).toBe(false);
  });

  it("on macOS, skips ⌃⌘F (the menu's predefined Fullscreen) but not other ⌃⌘ combos", () => {
    expect(nativeMenuOwnsKey(true, key("f", { meta: true, ctrl: true }))).toBe(true);
    expect(nativeMenuOwnsKey(true, key("k", { meta: true, ctrl: true }))).toBe(false);
    expect(nativeMenuOwnsKey(true, key("o", { meta: true, ctrl: true }))).toBe(false);
    expect(nativeMenuOwnsKey(true, key("f", { meta: true, ctrl: true, shift: true }))).toBe(false);
  });

  it("on macOS, skips ⌘⇧\\ (Split Down) whether the layout reports \" or |", () => {
    expect(nativeMenuOwnsKey(true, key("\\", { meta: true, shift: true }))).toBe(true);
    expect(nativeMenuOwnsKey(true, key("|", { meta: true, shift: true }))).toBe(true);
    expect(nativeMenuOwnsKey(true, key("|", { meta: true }))).toBe(false);
  });

  it("on macOS, does not skip Control-only (the menu binds Command) or Option", () => {
    expect(nativeMenuOwnsKey(true, key("k", { ctrl: true }))).toBe(false);
    expect(nativeMenuOwnsKey(true, key("f", { meta: true, alt: true }))).toBe(false);
  });
});
