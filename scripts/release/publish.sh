#!/usr/bin/env bash
# Publish a staged release: create (or reuse) a DRAFT release, upload every
# asset, check the uploaded inventory against SHA256SUMS, and only then make
# the release public. A failure at any step leaves at most an unpublished draft.
#
# Inputs (environment): TAG, VERSION, SHA, TAG_OBJECT, PRERELEASE (true|false),
# ASSET_DIR, GITHUB_REPOSITORY, GH_TOKEN.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
: "${TAG:?}" "${VERSION:?}" "${SHA:?}" "${TAG_OBJECT:?}" "${PRERELEASE:?}" "${ASSET_DIR:?}" "${GITHUB_REPOSITORY:?}"
repo="$GITHUB_REPOSITORY"
here="$(cd "$(dirname "$0")" && pwd)"

# The tag must still be the object verify checked: a tag moved or replaced
# while the assets were built would publish them under another commit.
tag_still_verified() {
  local refs object peeled
  refs="$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
  object="$(awk -v r="refs/tags/$TAG" '$2 == r { print $1 }' <<<"$refs")"
  peeled="$(awk -v r="refs/tags/$TAG^{}" '$2 == r { print $1 }' <<<"$refs")"
  [[ "$object" == "$TAG_OBJECT" && "$peeled" == "$SHA" ]] \
    || fail "tag $TAG now points at object '$object' / commit '$peeled', verified '$TAG_OBJECT' / '$SHA'"
}
tag_still_verified

notes="$(mktemp)"
# VERSION is awk data (-v), never part of the program text.
awk -v version="$VERSION" 'index($0, "## [" version "]") == 1 {found=1; next} /^## /{if(found) exit} found{print}' CHANGELOG.md > "$notes"
[[ -s "$notes" ]] || fail "CHANGELOG.md has no notes for $VERSION"
"$here/release-notes-verify.sh" >> "$notes"

state="$(gh release view "$TAG" --repo "$repo" --json isDraft --jq .isDraft 2>/dev/null || echo missing)"
case "$state" in
  missing)
    flags=(--draft --verify-tag --title "Marque $TAG" --notes-file "$notes")
    [[ "$PRERELEASE" == "true" ]] && flags+=(--prerelease)
    gh release create "$TAG" --repo "$repo" "${flags[@]}"
    ;;
  true)
    echo "reusing existing draft release $TAG"
    gh release edit "$TAG" --repo "$repo" --notes-file "$notes" --prerelease="$PRERELEASE"
    ;;
  *)
    fail "release $TAG is already published; a published release is never modified"
    ;;
esac

gh release upload "$TAG" --repo "$repo" --clobber "$ASSET_DIR"/*

expected="$( (awk '{print $2}' "$ASSET_DIR/SHA256SUMS"; echo SHA256SUMS) | sort)"
uploaded="$(gh release view "$TAG" --repo "$repo" --json assets --jq '.assets[].name' | sort)"
if [[ "$expected" != "$uploaded" ]]; then
  diff <(echo "$expected") <(echo "$uploaded") || true
  fail "uploaded assets do not match SHA256SUMS; the release stays a draft"
fi

# Re-download and check every digest before publication.
check="$(mktemp -d)"
gh release download "$TAG" --repo "$repo" --dir "$check"
(cd "$check" && sha256sum --quiet -c SHA256SUMS) || fail "downloaded assets do not match SHA256SUMS; the release stays a draft"

tag_still_verified
latest=(--latest)
[[ "$PRERELEASE" == "true" ]] && latest=(--latest=false)
gh release edit "$TAG" --repo "$repo" --draft=false "${latest[@]}"
echo "published $TAG ($SHA)"
