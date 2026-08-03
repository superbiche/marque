import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { FileTreeNode } from "./FileTree";
import type { TreeNode } from "@/lib/tauri";

const tree: TreeNode = {
  name: "root",
  path: "/root",
  is_dir: true,
  children: [
    {
      name: "docs",
      path: "/root/docs",
      is_dir: true,
      children: [
        {
          name: "guides",
          path: "/root/docs/guides",
          is_dir: true,
          children: [
            { name: "deep.md", path: "/root/docs/guides/deep.md", is_dir: false, children: [] },
          ],
        },
        { name: "intro.md", path: "/root/docs/intro.md", is_dir: false, children: [] },
      ],
    },
    { name: "README.md", path: "/root/README.md", is_dir: false, children: [] },
  ],
};

function renderTree(expandedDirs: ReadonlySet<string>) {
  return renderToString(
    <FileTreeNode
      node={tree}
      isRoot
      expandedDirs={expandedDirs}
      onToggleDir={() => {}}
      onOpen={() => {}}
    />,
  );
}

describe("FileTreeNode expansion", () => {
  it("renders every directory collapsed by default", () => {
    const html = renderTree(new Set());
    expect(html).toContain("docs");
    expect(html).toContain("README.md");
    expect(html).not.toContain("guides");
    expect(html).not.toContain("intro.md");
  });

  it("expands exactly the directories in the expanded set", () => {
    const html = renderTree(new Set(["/root/docs"]));
    expect(html).toContain("guides");
    expect(html).toContain("intro.md");
    expect(html).not.toContain("deep.md");
  });

  it("keeps a remembered descendant expanded when its ancestor re-expands", () => {
    const remembered = new Set(["/root/docs", "/root/docs/guides"]);
    expect(renderTree(remembered)).toContain("deep.md");

    // Folding the ancestor hides the subtree without touching the set…
    const folded = new Set(["/root/docs/guides"]);
    expect(renderTree(folded)).not.toContain("deep.md");

    // …so re-expanding the ancestor restores the descendant as it was left.
    expect(renderTree(remembered)).toContain("deep.md");
  });
});
