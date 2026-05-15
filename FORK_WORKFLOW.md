# Fork Workflow

This fork uses a split between the original project, your personal fork, and local-only integration branches.

## Remotes

- `upstream`: `git@github.com:GRVYDEV/marky.git`
- `origin`: `git@github.com:superbiche/marky.git`

## Branch Roles

- `main`: clean branch that mirrors `upstream/main`, then gets pushed to `origin/main`
- `chore/contributing`: repo-local workflow, maintenance notes, and contribution helpers
- `compat/fedora-wayland`: local compatibility work that is tied to your machine or distro stack
- `feat/*`: one branch per upstreamable feature or fix
- `local`: integration branch for the exact build you want to run locally

Keep `main` clean. Do not commit local-only changes directly on it.

## Sync Upstream Into Main

Use the helper:

```bash
./scripts/sync-main.sh
```

Manual equivalent:

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

## Start New Work

Create upstreamable work from `main`:

```bash
git switch main
./scripts/sync-main.sh
git switch -c feat/short-description
```

Create workflow or maintenance updates from `main`:

```bash
git switch main
./scripts/sync-main.sh
git switch chore/contributing || git switch -c chore/contributing
git rebase main
```

Create machine-specific work from `main`:

```bash
git switch main
./scripts/sync-main.sh
git switch -c compat/some-topic
```

## Build Your Local Stack

Use `local` as the branch that combines whatever you want to run:

```bash
git switch local
git merge compat/fedora-wayland
git merge feat/short-description
git merge chore/contributing
```

If `local` accumulates many branches, prefer rebasing or recreating it from `main` once in a while instead of letting it drift indefinitely.

## Open PRs

Push upstreamable branches to your fork:

```bash
git push -u origin feat/short-description
```

Then open the PR against `GRVYDEV/marky:main`.

Keep environment-specific branches out of upstream PRs unless the change is clearly general-purpose.

## Maintain This Routine

Changes to [FORK_WORKFLOW.md](/home/michel/dev/lab/forks/marky/FORK_WORKFLOW.md) and [scripts/sync-main.sh](/home/michel/dev/lab/forks/marky/scripts/sync-main.sh) should go on `chore/contributing`.

After updating that branch:

```bash
git switch local
git merge chore/contributing
git push origin local
```

## Local Build Note

The Fedora/Wayland issue appears to be an AppImage/runtime packaging problem, not a repo patch.

Your local setup script builds from source against system `webkit2gtk4.1`, which is why the app works on your machine. The untracked `pnpm-workspace.yaml` is part of that local build flow and should stay local unless you decide the project should track it upstream.
