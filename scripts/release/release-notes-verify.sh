#!/usr/bin/env bash
# Append-ready "Verify this release" section for the release notes.
# Inputs (environment): TAG, SHA, VERSION, EXPECTED_FPR, GITHUB_REPOSITORY.
set -euo pipefail
: "${TAG:?}" "${SHA:?}" "${VERSION:?}" "${EXPECTED_FPR:?}" "${GITHUB_REPOSITORY:?}"
owner="${GITHUB_REPOSITORY%%/*}"
cat <<NOTES

### Verify this release

The tag \`$TAG\` (commit \`$SHA\`) is signed by the maintainer's OpenPGP key \`$EXPECTED_FPR\`, published at https://github.com/$owner.gpg. The release workflow refuses any other signer. Every asset below is listed in \`SHA256SUMS\` and carries GitHub build provenance from this repository's release workflow.

\`\`\`sh
# 1. The tag is the maintainer's (in a clone of the repository): the last
#    command must print exactly $EXPECTED_FPR
curl -fsSL https://github.com/$owner.gpg | gpg --import
git fetch origin tag $TAG
git verify-tag --raw $TAG 2>&1 | awk '\$2 == "VALIDSIG" { print \$NF }'

# 2. The file you downloaded (any asset, SHA256SUMS included) is the one this
#    workflow built from that tag
gh attestation verify Marque_${VERSION}_amd64.deb \\
  --repo $GITHUB_REPOSITORY \\
  --signer-workflow $GITHUB_REPOSITORY/.github/workflows/release.yml \\
  --source-ref refs/tags/$TAG \\
  --source-digest $SHA

# 3. Checksums
sha256sum --ignore-missing -c SHA256SUMS
\`\`\`
NOTES
