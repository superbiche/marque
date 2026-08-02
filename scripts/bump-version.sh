#!/usr/bin/env bash
# Bump the version in package.json, src-tauri/tauri.conf.json, and
# src-tauri/Cargo.toml. No git operations — commit/tag manually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/bump-version.sh <version>"
  echo "Example: ./scripts/bump-version.sh 0.2.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in semver format (X.Y.Z), got: $VERSION"
  exit 1
fi

# Portable in-place sed: GNU sed and BSD sed disagree on -i syntax,
# so write a .bak backup and remove it.
sed_inplace() {
  local expr="$1" file="$2"
  sed -i.bak "$expr" "$file"
  rm -f "$file.bak"
}

echo "Bumping version to $VERSION"

echo "Updating package.json..."
sed_inplace "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"$VERSION\"/" "$ROOT_DIR/package.json"

echo "Updating src-tauri/tauri.conf.json..."
sed_inplace "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"$VERSION\"/" "$ROOT_DIR/src-tauri/tauri.conf.json"

# Cargo.toml — only the package version (line 3)
echo "Updating src-tauri/Cargo.toml..."
sed_inplace "3s/version = \"[0-9]*\.[0-9]*\.[0-9]*\"/version = \"$VERSION\"/" "$ROOT_DIR/src-tauri/Cargo.toml"

echo ""
echo "Done. Versions bumped to $VERSION."
echo "Note: Cargo.lock updates on the next cargo build/check."
