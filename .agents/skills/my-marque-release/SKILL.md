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
5. Push a GPG-signed `vX.Y.Z` tag. The tag triggers
   `.github/workflows/release.yml` (deb, rpm, AppImage); its runs are keyed
   on `headBranch == "vX.Y.Z"`.
6. The release is done only when all three assets exist on the GitHub
   release: `Marque-X.Y.Z-1.x86_64.rpm`, `Marque_X.Y.Z_amd64.AppImage`,
   `Marque_X.Y.Z_amd64.deb`.
7. **Post-release: download the rpm to `~/Downloads`** so it is ready to
   install locally:

   ```sh
   gh release download vX.Y.Z --pattern '*.rpm' --dir ~/Downloads --clobber
   ```

Watcher shape for steps 4–6: one background script that polls each stage
and fails loudly per stage (CI-FAILED / TAG-PUSH-FAILED / RELEASE-FAILED)
— never grep for success markers in prompt echoes; key on run conclusions.
