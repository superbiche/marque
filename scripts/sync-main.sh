#!/usr/bin/env bash
set -euo pipefail

# Workflow note:
# - keep this script and FORK_WORKFLOW.md on chore/contributing
# - merge chore/contributing into local when the routine changes

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

current_branch="$(git -C "$ROOT_DIR" branch --show-current)"
if [[ "$current_branch" != "main" ]]; then
  echo "switching to main"
  git -C "$ROOT_DIR" switch main
fi

echo "fetching upstream"
git -C "$ROOT_DIR" fetch upstream

echo "fast-forwarding main to upstream/main"
git -C "$ROOT_DIR" merge --ff-only upstream/main

echo "pushing main to origin"
git -C "$ROOT_DIR" push origin main

echo "main is synced with upstream and pushed to origin"
echo "if you changed the workflow itself, update chore/contributing and merge it into local"
