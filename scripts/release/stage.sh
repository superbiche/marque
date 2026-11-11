#!/usr/bin/env bash
# Check the downloaded bundles in ASSET_DIR against the expected inventory for
# VERSION, then write SHA256SUMS over every asset (bundles and SBOM).
set -euo pipefail
dir="${ASSET_DIR:?ASSET_DIR is required}"
version="${VERSION:?VERSION is required}"
here="$(cd "$(dirname "$0")" && pwd)"

expected="$("$here/expected-assets.sh" "$version" | sort)"
actual="$(find "$dir" -maxdepth 1 -type f ! -name SHA256SUMS ! -name '*.spdx.json' -printf '%f\n' | sort)"
if [[ "$expected" != "$actual" ]]; then
  echo "::error::bundle inventory does not match the expected release assets"
  diff <(echo "$expected") <(echo "$actual") || true
  exit 1
fi
(cd "$dir" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
cat "$dir/SHA256SUMS"
