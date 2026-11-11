#!/usr/bin/env bash
# Release preflight: the tag must be an annotated tag on main, signed by the
# maintainer key whose primary fingerprint is EXPECTED_FPR, and every version
# field plus the CHANGELOG must name the tag's version.
#
# Inputs (environment): TAG, EXPECTED_FPR, SIGNER_KEYS_URL.
# Outputs: tag, version, sha, tag_object, prerelease lines appended to $GITHUB_OUTPUT
# (or printed when it is unset, for local runs).
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

: "${TAG:?TAG is required}"
: "${SIGNER_KEYS_URL:?SIGNER_KEYS_URL is required}"
[[ -n "${EXPECTED_FPR:-}" ]] || fail "repository variable RELEASE_SIGNING_FINGERPRINT is not set"
[[ "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.]+)?$ ]] || fail "tag '$TAG' is not vMAJOR.MINOR.PATCH[-PRERELEASE]"
version="${TAG#v}"
prerelease=false
[[ -n "${BASH_REMATCH[2]}" ]] && prerelease=true

git fetch --quiet --force origin "refs/tags/$TAG:refs/tags/$TAG" main
[[ "$(git cat-file -t "refs/tags/$TAG")" == "tag" ]] || fail "$TAG is a lightweight tag; releases need an annotated, signed tag"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
chmod 700 "$GNUPGHOME"
trap 'rm -rf "$GNUPGHOME"' EXIT
curl -fsSL "$SIGNER_KEYS_URL" | gpg --batch --quiet --import 2>/dev/null \
  || fail "could not import signer keys from $SIGNER_KEYS_URL"

if ! status="$(git verify-tag --raw "$TAG" 2>&1 >/dev/null)"; then
  echo "$status" >&2
  fail "$TAG has no valid signature from a key published at $SIGNER_KEYS_URL"
fi
# VALIDSIG <sig-key-fpr> ... <primary-key-fpr>: pin the primary key so a
# subkey rotation keeps working and a different key never does.
primary="$(awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $NF }' <<<"$status")"
[[ "$primary" == "$EXPECTED_FPR" ]] || fail "$TAG is signed by primary key '$primary', expected '$EXPECTED_FPR'"

sha="$(git rev-list -n 1 "refs/tags/$TAG")"
tag_object="$(git rev-parse "refs/tags/$TAG")"
git merge-base --is-ancestor "$sha" origin/main || fail "$TAG ($sha) is not on main"

field() { git show "$sha:$1"; }
pkg="$(field package.json | jq -r .version)"
conf="$(field src-tauri/tauri.conf.json | jq -r .version)"
cargo="$(field src-tauri/Cargo.toml | sed -n 's/^version = "\(.*\)"$/\1/p' | head -n 1)"
for pair in "package.json:$pkg" "tauri.conf.json:$conf" "Cargo.toml:$cargo"; do
  [[ "${pair#*:}" == "$version" ]] || fail "${pair%%:*} has version '${pair#*:}', tag is $version"
done
field CHANGELOG.md | grep -qF "## [$version]" || fail "CHANGELOG.md has no '## [$version]' section"

echo "verified $TAG -> $sha (primary key $primary)"
{
  echo "tag=$TAG"
  echo "version=$version"
  echo "sha=$sha"
  echo "tag_object=$tag_object"
  echo "prerelease=$prerelease"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
