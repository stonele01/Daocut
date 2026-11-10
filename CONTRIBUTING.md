# Contributing to Daocut

Read the [development handoff](docs/DEVELOPMENT.md) for the current single-product analysis, structure composition, visual review, draft and export implementation. Use a feature branch and submit a pull request to [stonele01/Daocut](https://github.com/stonele01/Daocut).

## Setup

Use Node 24 (minimum 22.18), pnpm 9.15.9, Git, FFmpeg and ffprobe. Clone onto a data drive and install the locked dependencies:

```sh
git clone https://github.com/stonele01/Daocut.git
cd Daocut
pnpm install --frozen-lockfile
```

The root `.npmrc` uses the original workstation's D-drive cache paths. Before installing on another workstation, you can override `npm_config_store_dir` and `npm_config_cache` with absolute paths under your checkout (for example `.tmp/pnpm-store` and `.tmp/npm-cache`).

The company service is independent of the pnpm workspace. For changes to it, install its dependencies with `npm --prefix apps/company-service ci`.

## Keep development projects separate

Use a new checkout and new disposable directories. In PowerShell, from that checkout:

```powershell
$trialRoot = Join-Path (Get-Location) ".tmp/contributor-trial"
$env:DAOCUT_HOME = Join-Path $trialRoot "desktop"
$env:DAOCUT_STUDIO_HOME = Join-Path $trialRoot "studio"
$env:DAOCUT_SHARED_HOME = Join-Path $trialRoot "shared"
$env:DAOCUT_LIBRARY = Join-Path $trialRoot "projects"
$env:DAOCUT_EXPORTS = Join-Path $trialRoot "exports"
$env:DAOCUT_TRASH_DIR = Join-Path $trialRoot "trash"
$env:TEMP = Join-Path $trialRoot "temp"
$env:TMP = $env:TEMP
$env:DAOCUT_STUDIO_PORT = "5848"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $trialRoot "browsers"
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
```

Choose an unused Studio port. `pnpm dev` keeps its Studio state and exports under `packages/daocut/.dev/`, but honors the separate shared home and project library. Only run one dev process per checkout. The editor builds at startup; restart that development process after UI changes. Server and core source changes restart the development server automatically.

For desktop development, `DAOCUT_HOME` is essential: it controls the desktop's project library and application data. The dev flavor uses port 4857. Setting only `DAOCUT_LIBRARY` does not override the desktop flavor's library. Keep real provider credentials out of the development environment and inject mock clients for analysis tests.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start browser Studio in the configured development environment |
| `pnpm dev:desktop` | Build the shell and start Daocut Dev |
| `pnpm build` | Build the Studio editor and desktop shell |
| `pnpm typecheck` | Check workspace package types |
| `pnpm test` | Run workspace test suites |
| `pnpm --filter daocut test` | Run core/editor tests |
| `pnpm --filter @daocut/desktop test` | Run desktop tests |
| `pnpm --filter @daocut/shared test` | Run shared-module tests |
| `pnpm check:pack` | Check a local npm package; does not publish |

Start with the focused checks in [DEVELOPMENT.md](docs/DEVELOPMENT.md). Browser/render tests require Playwright's headless browser, which can be installed into the isolated path above:

```sh
pnpm --filter daocut exec playwright-core install chromium-headless-shell
```

Do not use a real model, production project, shared NAS or installed service as a test fixture. Verify changes with mock responses and synthetic media first. Tests that require a build or special fixture document their setup in the development guide.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/daocut/` | The `daocut` package: CLI, film format, renderer and Studio |
| `packages/daocut/studio/server/` | Projects, analysis, composition, drafts, exports and saved review evidence |
| `packages/daocut/studio/ui/` | React timeline editor and product/plan panels |
| `packages/shared/` | Private `@daocut/shared` workspace package |
| `apps/desktop/` | Electron app, chat, agent integration and company authentication |
| `apps/company-service/` | Account, feedback and company-update service |
| `skills/` | Agent entry skill |
| `docs/` | Development and operational documentation |

The core package is in `packages/daocut`. Old project/configuration migration identifiers remain supported; do not remove them as cosmetic text.

## Pull requests and releases

Explain the concrete problem, changed behavior and checks run. Preserve independent drafts, parent films, public results and recovery receipts. Unknown model outcomes or costs must not cause an automatic retry. Keep real media, credentials, local session links and production records out of commits.

Changesets can record a proposed version change, but merging a pull request does not publish to npm or release an installer. Both checked-in package profiles have automatic updates disabled. Company builds receive an update address explicitly; see the [Windows build guide](apps/desktop/scripts/BUILD-DAOCUT.md) and [company release guide](docs/DAOCUT-COMPANY-RELEASE.md). Building or deploying an installer is separate from validating a source change.

Preserve the [license](LICENSE), [third-party notices](packages/daocut/THIRD_PARTY_NOTICES.md) and applicable [trademark notices](TRADEMARK.md). Report bugs through [Daocut issues](https://github.com/stonele01/Daocut/issues); follow [SECURITY.md](SECURITY.md) for vulnerability reports.
