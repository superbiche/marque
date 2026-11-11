---
description: "Marque release recipe: semver intent, version bump, CHANGELOG, tag, CI/release watch, post-release rpm download"
user-invocable: false
---

# Marque release recipe

## Semver intent (pre-1.0)

Non-breaking feature slices and fixes bump PATCH (`0.4.z`). Bump MINOR only
for breaking changes (settings/file format, CLI behavior, capability
regressions) or structural rewrites. Ambiguous cases: ask, don't guess.

## Recipe

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`, then run `cargo check` inside `src-tauri/` to
   refresh `Cargo.lock`. (`cargo` is safe-gated on this machine; a
   `safe: BLOCKED` refusal is escalated per the gate contract, never
   bypassed.)
2. Retitle the CHANGELOG `[Unreleased]` section to `## [X.Y.Z] - <date>`.
   (Slices land under `[Unreleased]` as they merge; the release workflow
   extracts the version section for release notes.)
3. Commit the five files as `vX.Y.Z` and push to `main`.
4. Wait for CI green on the release commit. When querying
   `gh run list --commit`, use the FULL 40-char SHA — a short SHA silently
   matches nothing.
5. Push a GPG-signed annotated `vX.Y.Z` tag on the release commit. The tag
   triggers `.github/workflows/release.yml`: `verify` refuses a tag whose
   primary key fingerprint differs from the repository variable
   `RELEASE_SIGNING_FINGERPRINT`, or whose version fields / CHANGELOG section
   disagree with the tag; then gates (the CI workflow), four build jobs, stage
   (inventory, SBOM, SHA256SUMS) and publish (provenance, draft, upload,
   digest re-check, publication). Runs are keyed on `headBranch == "vX.Y.Z"`.
6. The release is done only when it is published (not a draft) with the
   inventory of `scripts/release/expected-assets.sh X.Y.Z` plus
   `SHA256SUMS` and `Marque_X.Y.Z.spdx.json`. A failed run leaves at most a
   draft. A transient failure is re-run with
   `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z -f dry_run=false`
   (dispatched on the tag, so provenance names the tagged commit; verify
   refuses any other ref; publish.sh reuses the draft and never touches a
   published release). A fix that changes the tree ships as the
   next patch version, never by moving the tag.
7. **Post-release: download the rpm to `~/Downloads`** so it is ready to
   install locally:

   ```sh
   gh release download vX.Y.Z --pattern '*.x86_64.rpm' --dir ~/Downloads --clobber
   ```

To exercise the pipeline without releasing (a workflow change, a new
platform): `gh workflow run release.yml --ref <branch> -f tag=<latest signed tag>`
(`dry_run` defaults to true: it verifies that tag, builds the branch head and
stages, but publishes nothing).

Watcher shape for steps 4–6: one background script that polls each stage
and fails loudly per stage (CI-FAILED / TAG-PUSH-FAILED / RELEASE-FAILED)
— never grep for success markers in prompt echoes; key on run conclusions.
