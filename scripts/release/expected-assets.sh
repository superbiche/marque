#!/usr/bin/env bash
# The release inventory for a version: one name per line. The stage and
# publish jobs refuse to go on unless the bundles match this list exactly.
set -euo pipefail
v="${1:?usage: expected-assets.sh VERSION}"
cat <<LIST
Marque_${v}_amd64.deb
Marque-${v}-1.x86_64.rpm
Marque_${v}_amd64.AppImage
Marque_${v}_arm64.deb
Marque-${v}-1.aarch64.rpm
Marque_${v}_aarch64.AppImage
Marque_${v}_universal.dmg
Marque_${v}_x64-setup.exe
Marque_${v}_x64_en-US.msi
LIST
