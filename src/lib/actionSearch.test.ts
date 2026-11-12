import { describe, expect, it } from "vitest";
import { rankActions, type ActionDef } from "./actionSearch";

/** The palette's real action labels (a superset of what one session shows). */
const ACTUAL: ActionDef[] = [
  { id: "open-file", label: "Open File…" },
  { id: "add-folder", label: "Add Folder…", keywords: ["new folder"] },
  { id: "split-vertical", label: "Split Pane Vertically" },
  { id: "split-horizontal", label: "Split Pane Horizontally" },
  { id: "close-split", label: "Close Split" },
  { id: "toggle-highlights", label: "Toggle Highlights Panel" },
  { id: "theme-light", label: "Theme: Light" },
  { id: "theme-dark", label: "Theme: Dark" },
  { id: "theme-system", label: "Theme: System" },
  { id: "zoom-in", label: "Zoom In", keywords: ["bigger"] },
  { id: "zoom-out", label: "Zoom Out", keywords: ["smaller"] },
  { id: "zoom-reset", label: "Reset Zoom", keywords: ["default zoom"] },
];

const ids = (r: { id: string }[]) => r.map((a) => a.id);

describe("rankActions", () => {
  it("prefix matches rank first, above word starts, substrings and subsequence matches", () => {
    const actions: ActionDef[] = [
      { id: "open-panel", label: "Open Panel" },
      { id: "panel-settings", label: "Panel Settings" },
      { id: "split-pane", label: "Split Pane Vertically" },
    ];
    // "panel": "Panel Settings" is a prefix (0), "Open Panel" a word start (1),
    // "Split Pane Vertically" only a subsequence (p…a…n…e from "pane", then l from "vertically").
    expect(ids(rankActions("panel", actions))).toEqual([
      "panel-settings",
      "open-panel",
      "split-pane",
    ]);
  });

  it("substring matches rank above subsequence matches", () => {
    const actions: ActionDef[] = [
      { id: "split-pane", label: "Split Pane Vertically" },
      { id: "open-panel", label: "Open Panel" },
      { id: "panel-settings", label: "Panel Settings" },
    ];
    // "anel": inside the word "panel" (substring, tier 2) in both panel actions,
    // in definition order; "Split Pane Vertically" only matches as a subsequence (3).
    expect(ids(rankActions("anel", actions))).toEqual([
      "open-panel",
      "panel-settings",
      "split-pane",
    ]);
  });

  it("word starts rank above substrings", () => {
    const actions: ActionDef[] = [
      { id: "undarkened", label: "Undarkened Filter" },
      { id: "theme-dark", label: "Theme: Dark" },
      { id: "darkness", label: "Darkness" },
    ];
    // "dark": "Darkness" is a prefix (0), "Theme: Dark" a word start (1),
    // "Undarkened Filter" a substring (2).
    expect(ids(rankActions("dark", actions))).toEqual([
      "darkness",
      "theme-dark",
      "undarkened",
    ]);
  });

  it("a multi-word query starting at a word boundary ranks above an earlier substring match", () => {
    const actions: ActionDef[] = [
      { id: "expane", label: "Expane Vertical" },
      { id: "split-vertical", label: "Split Pane Vertically" },
    ];
    // "pane v" begins "Split Pane Vertically" at the "pane" word boundary, so it is a
    // word-start match (tier 1). "Expane Vertical" only contains "pane v" as a run
    // inside "expane" (tier 2) and is defined first — before the fix both were tier 2
    // and the earlier "expane" wrongly outranked "split-vertical".
    expect(ids(rankActions("pane v", actions))).toEqual(["split-vertical", "expane"]);
  });

  it("is case-insensitive", () => {
    for (const q of ["highl", "HIGHL", "HiGhL"]) {
      expect(ids(rankActions(q, ACTUAL))).toEqual(["toggle-highlights"]);
    }
  });

  it("ranks subsequence matches as the lowest tier, below direct matches", () => {
    const actions: ActionDef[] = [
      { id: "toggle-highlights", label: "Toggle Highlights Panel" },
      { id: "hlt-shortcut", label: "HLT Shortcut" },
    ];
    // "hlt" is a prefix of "HLT Shortcut" (0); in "Toggle Highlights Panel" it is
    // only a subsequence (h, l, t) — still a match, but last.
    expect(ids(rankActions("hlt", actions))).toEqual(["hlt-shortcut", "toggle-highlights"]);
  });

  it("searches keywords as well as labels", () => {
    const actions: ActionDef[] = [
      { id: "add-folder", label: "Add Folder…", keywords: ["new folder", "workspace"] },
      { id: "new-doc", label: "New Document" },
    ];
    // "new": both match — "New Document" (prefix) and "Add Folder…" (via its
    // "new folder" keyword) — in definition order.
    expect(ids(rankActions("new", actions))).toEqual(["add-folder", "new-doc"]);
    // "workspace": matches no label, only the keyword.
    expect(ids(rankActions("workspace", actions))).toEqual(["add-folder"]);
  });

  it("returns no match for queries no action can contain", () => {
    expect(rankActions("xyzzy", ACTUAL)).toEqual([]);
  });

  it("returns every action in definition order for an empty or separator-only query", () => {
    expect(ids(rankActions("", ACTUAL))).toEqual(ACTUAL.map((a) => a.id));
    expect(ids(rankActions("  ", ACTUAL))).toEqual(ACTUAL.map((a) => a.id));
    expect(rankActions("", ACTUAL).every((r) => r.tier === 0)).toBe(true);
  });

  it("preserves definition order within a tier", () => {
    expect(ids(rankActions("theme", ACTUAL))).toEqual([
      "theme-light",
      "theme-dark",
      "theme-system",
    ]);
    expect(ids(rankActions("split", ACTUAL))).toEqual([
      "split-vertical",
      "split-horizontal",
      "close-split",
    ]);
  });

  it("handles the runtime-probe queries: highl and dark", () => {
    expect(ids(rankActions("highl", ACTUAL))).toEqual(["toggle-highlights"]);
    expect(ids(rankActions("dark", ACTUAL))).toEqual(["theme-dark"]);
  });

  it("treats multi-word queries as a whole (no per-word ANDing)", () => {
    // "theme dark" normalizes to the same string as the "Theme: Dark" label.
    expect(ids(rankActions("theme dark", ACTUAL))).toContain("theme-dark");
  });
});
