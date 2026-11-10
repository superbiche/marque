import { describe, expect, it } from "vitest";
import { groupFolders } from "./folderGroups";
import type { AnnotatedFolder } from "./tauri";

let nextId = 0;

const folder = (
  name: string,
  opts: { repoRoot?: string | null; repoName?: string | null; group?: string | null } = {},
): AnnotatedFolder => ({
  id: `f${nextId++}`,
  name,
  path: `/tmp/${name}`,
  added_at: "0",
  group: opts.group ?? null,
  repo_root: opts.repoRoot ?? null,
  repo_name: opts.repoName ?? null,
});

const labels = (groups: ReturnType<typeof groupFolders>) => groups.map((g) => g.label);

describe("groupFolders", () => {
  it("puts labeled folders from different repos into one label group", () => {
    const a = folder("a", { repoRoot: "/r/a", repoName: "a", group: "Plans" });
    const b = folder("b", { repoRoot: "/r/b", repoName: "b", group: "Plans" });

    const groups = groupFolders([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "label:Plans", label: "Plans", kind: "label" });
    expect(groups[0].folders.map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it("lets an unlabeled repo folder join a label group with the same name", () => {
    const a = folder("a", { repoRoot: "/one/work", repoName: "work", group: "work" });
    const b = folder("b", { repoRoot: "/two/work", repoName: "work" });

    const groups = groupFolders([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("label");
    expect(groups[0].folders.map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it("keeps unlabeled repos with the same name but different roots in separate repo groups", () => {
    const a = folder("a", { repoRoot: "/one/work", repoName: "work" });
    const b = folder("b", { repoRoot: "/two/work", repoName: "work" });

    const groups = groupFolders([a, b]);

    expect(labels(groups)).toEqual(["work", "work"]);
    expect(groups.map((g) => g.key)).toEqual(["repo:/one/work", "repo:/two/work"]);
    expect(groups.every((g) => g.kind === "repo")).toBe(true);
  });

  it("keeps folders with no repo and no label in a single ungrouped group, last", () => {
    const z = folder("z", { group: "Z" });
    const u = folder("u");
    const a = folder("a");

    const groups = groupFolders([u, z, a]);

    expect(labels(groups)).toEqual(["Z", "(ungrouped)"]);
    expect(groups[1]).toMatchObject({ key: "__ungrouped__", kind: "ungrouped" });
    expect(groups[1].folders.map((f) => f.id)).toEqual([u.id, a.id]);
  });

  it("sorts groups alphabetically by label with ungrouped last", () => {
    const c = folder("c", { group: "C" });
    const a = folder("a", { group: "A" });
    const b = folder("b", { group: "B" });
    const plain = folder("p");

    const groups = groupFolders([c, plain, a, b]);

    expect(labels(groups)).toEqual(["A", "B", "C", "(ungrouped)"]);
  });

  it("sorts a mix of label, repo, and ungrouped groups by label with ungrouped last", () => {
    const repo = folder("r", { repoRoot: "/r/zulu", repoName: "zulu" });
    const label = folder("l", { group: "Apple" });
    const plain = folder("p");

    const groups = groupFolders([repo, plain, label]);

    expect(labels(groups)).toEqual(["Apple", "zulu", "(ungrouped)"]);
    expect(groups.map((g) => g.kind)).toEqual(["label", "repo", "ungrouped"]);
  });

  it("treats a whitespace-only label as no label", () => {
    const a = folder("a", { repoRoot: "/r/a", repoName: "a", group: "   " });

    const groups = groupFolders([a]);

    expect(labels(groups)).toEqual(["a"]);
    expect(groups[0]).toMatchObject({ key: "repo:/r/a", kind: "repo" });
  });

  it("merges labels that differ only by surrounding whitespace", () => {
    const a = folder("a", { group: "  Plans  " });
    const b = folder("b", { group: "Plans" });

    const groups = groupFolders([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Plans");
    expect(groups[0].folders.map((f) => f.id)).toEqual([a.id, b.id]);
  });
});
