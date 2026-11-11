#!/usr/bin/env bash
# Print the packslip release.toml for VERSION, describing every installer that
# expected-assets.sh lists under ASSET_DIR. The AppImages are the program
# itself, so they are `raw` executables exporting `marque`; the deb and rpm
# install /usr/bin/marque; the dmg carries Marque.app; the Windows installers
# declare no command (the installer chooses the directory).
set -euo pipefail
v="${1:?usage: packslip-manifest.sh VERSION ASSET_DIR}"
dir="${2:?usage: packslip-manifest.sh VERSION ASSET_DIR}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="${GITHUB_REPOSITORY:-superbiche/marque}"

cat <<HEAD
project = "github.com/$repo"
version = "$v"
url_base = "https://github.com/$repo/releases/download/v$v"

[source]
repo = "https://github.com/$repo"
tag = "v$v"
HEAD

dmg=""
while read -r name; do
  printf '\n[[artifact]]\npath = "%s/%s"\n' "$dir" "$name"
  case "$name" in
    *.AppImage) printf 'format = "raw"\nbin = ["marque"]\n' ;;
    *.deb | *.rpm) printf 'bin = ["usr/bin/marque"]\n' ;;
    *.dmg) printf 'bin = []\n'; dmg="$name" ;;
    *.exe | *.msi) printf 'bin = []\n' ;;
    *) echo "packslip-manifest.sh: no description for $name" >&2; exit 1 ;;
  esac
done < <("$here/expected-assets.sh" "$v")

[[ -n "$dmg" ]] || { echo "packslip-manifest.sh: no dmg in the inventory" >&2; exit 1; }
cat <<TAIL

[[resource]]
kind = "app"
artifact = "$dmg"
archive = "Marque.app"

[[resource]]
kind = "sbom"
format = "spdx"
asset = "$dir/Marque_$v.spdx.json"
TAIL
