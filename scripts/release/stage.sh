#!/usr/bin/env bash
# Check ASSET_DIR against the release inventory for VERSION: the bundles that
# expected-assets.sh lists, the SBOM, and the packslip bundle when
# WITH_PACKSLIP=true. Then write SHA256SUMS over every asset. The publish job
# runs it again once the packslip bundle has joined the staged files.
set -euo pipefail
dir="${ASSET_DIR:?ASSET_DIR is required}"
version="${VERSION:?VERSION is required}"
here="$(cd "$(dirname "$0")" && pwd)"

expected="$( {
  "$here/expected-assets.sh" "$version"
  echo "Marque_$version.spdx.json"
  if [[ "${WITH_PACKSLIP:-false}" == "true" ]]; then echo packslip.sigstore.json; fi
} | sort)"
actual="$(find "$dir" -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\n' | sort)"
if [[ "$expected" != "$actual" ]]; then
  echo "::error::release inventory does not match the expected assets"
  diff <(echo "$expected") <(echo "$actual") || true
  exit 1
fi
(cd "$dir" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
cat "$dir/SHA256SUMS"
