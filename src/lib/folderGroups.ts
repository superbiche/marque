import type { AnnotatedFolder } from "./tauri";

export interface FolderGroup {
  key: string;
  label: string;
  kind: "label" | "repo" | "ungrouped";
  folders: AnnotatedFolder[];
}

const UNGROUPED_KEY = "__ungrouped__";
const UNGROUPED_LABEL = "(ungrouped)";

function trimmedLabel(folder: AnnotatedFolder): string | null {
  const raw = folder.group?.trim() ?? "";
  return raw === "" ? null : raw;
}

function getOrCreate(
  groups: Map<string, FolderGroup>,
  key: string,
  label: string,
  kind: FolderGroup["kind"],
): FolderGroup {
  let group = groups.get(key);
  if (!group) {
    group = { key, label, kind, folders: [] };
    groups.set(key, group);
  }
  return group;
}

/**
 * Sidebar grouping: user-defined label groups, automatic repository groups
 * for unlabeled folders, and a single trailing "(ungrouped)" group for
 * folders with neither. An unlabeled folder whose repository name exactly
 * matches an existing label joins that label group. Groups sort by label
 * (ungrouped last); within a group, folders keep their input order.
 */
export function groupFolders(folders: AnnotatedFolder[]): FolderGroup[] {
  const labels = new Set<string>();
  for (const folder of folders) {
    const label = trimmedLabel(folder);
    if (label !== null) labels.add(label);
  }

  const labelGroups = new Map<string, FolderGroup>();
  const repoGroups = new Map<string, FolderGroup>();
  const ungrouped = new Map<string, FolderGroup>();

  for (const folder of folders) {
    const label = trimmedLabel(folder);
    if (label !== null) {
      getOrCreate(labelGroups, `label:${label}`, label, "label").folders.push(folder);
      continue;
    }
    if (folder.repo_root) {
      const joinLabel = folder.repo_name && labels.has(folder.repo_name) ? folder.repo_name : null;
      if (joinLabel !== null) {
        getOrCreate(labelGroups, `label:${joinLabel}`, joinLabel, "label").folders.push(folder);
      } else {
        getOrCreate(
          repoGroups,
          `repo:${folder.repo_root}`,
          folder.repo_name ?? "(no repo)",
          "repo",
        ).folders.push(folder);
      }
      continue;
    }
    getOrCreate(ungrouped, UNGROUPED_KEY, UNGROUPED_LABEL, "ungrouped").folders.push(folder);
  }

  const groups = [...labelGroups.values(), ...repoGroups.values(), ...ungrouped.values()];
  groups.sort((a, b) => {
    if (a.key === UNGROUPED_KEY) return 1;
    if (b.key === UNGROUPED_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}
