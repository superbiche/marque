#!/usr/bin/env bash
# Copy the installable bundles of one build job into OUT_DIR (flat).
# Bundle directories: deb, rpm, appimage (Linux); dmg (macOS); nsis, msi (Windows).
set -euo pipefail
out="${OUT_DIR:?OUT_DIR is required}"
mkdir -p "$out"
shopt -s nullglob
found=0
for f in src-tauri/target/release/bundle/{deb/*.deb,rpm/*.rpm,appimage/*.AppImage,nsis/*-setup.exe,msi/*.msi} \
         src-tauri/target/*/release/bundle/dmg/*.dmg; do
  cp "$f" "$out/"
  echo "collected $(basename "$f")"
  found=$((found + 1))
done
[[ $found -gt 0 ]] || { echo "::error::no bundle found under src-tauri/target" >&2; exit 1; }
