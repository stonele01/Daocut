# Daocut desktop

The Electron workspace combines Studio's timeline editor with agent chat, single-product analysis and company-account integration.

## Develop

From the repository root, install the workspace dependencies and configure a disposable environment using [CONTRIBUTING.md](../../CONTRIBUTING.md). Set `DAOCUT_HOME` inside the checkout: the desktop flavor derives its application data and project library from it, so setting only `DAOCUT_LIBRARY` is insufficient.

```sh
pnpm dev:desktop
pnpm --filter @daocut/desktop test
pnpm --filter @daocut/desktop typecheck
```

The start command builds the shell and runs Daocut Dev on its development Studio port, 4857. On macOS, the renamed Electron runtime is kept in `.dev/`. Use mocked model responses and synthetic media for acceptance; current implementation paths and focused tests are in the [development handoff](../../docs/DEVELOPMENT.md).

## Builds

Use the [Windows build guide](scripts/BUILD-DAOCUT.md) for current company builds and the [company release guide](../../docs/DAOCUT-COMPANY-RELEASE.md) for deployment. The retained generic `release` script is a separate packaging path; it does not publish artifacts. Both checked-in product profiles have no update feed. Company updates require an explicitly configured address.

Keep the [license](../../LICENSE) and [third-party notices](../../packages/daocut/THIRD_PARTY_NOTICES.md) with distributions. Source changes do not require updating an installed application.
