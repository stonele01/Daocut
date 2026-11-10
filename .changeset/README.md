# Changesets

A changeset records which workspace packages a change affects and whether the proposed version change is `patch`, `minor` or `major`. Run `pnpm changeset` to create one when a version change is needed.

The configuration groups `daocut`, `@daocut/desktop` and `@daocut/shared`. Changesets are release notes and versioning input; there is no automatic npm publication or installer release on merge or tag. See [CONTRIBUTING.md](../CONTRIBUTING.md) and the [Windows build guide](../apps/desktop/scripts/BUILD-DAOCUT.md) for the current workflow.
