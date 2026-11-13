# Daocut company CI

`ci.yml` checks the Windows company fork on pushes to `main`, pull requests and manual runs. It uses Node 24.16.0, the root `packageManager` version of pnpm, and frozen dependency locks.

| Job | Checks |
| --- | --- |
| Windows desktop | Studio server/UI and desktop chat/shell types; company authorization, cancellation, window lifecycle and update unit tests; release configuration and LAN publisher file/manifest tests |
| Company service | Independent `npm ci`, syntax checks, synthetic accounts/session revocation/feedback isolation, TLS and update HTTP/range tests |
| Source secret scan | Existing Gitleaks CLI against Git history, with redacted findings |

The service is excluded from `pnpm-workspace.yaml` and uses its own `npm ci` and lockfile for the native SQLite addon. Its integration tests also import the actual desktop client and Studio modules, so the job separately installs the locked pnpm workspace with scripts disabled. Service and desktop dependencies remain separate. Package caches and pnpm use `runner.temp`, overriding workstation cache paths. Service fixtures also use `runner.temp`; Studio tests use a separate shared home.

These jobs do not call a real model, use company credentials, upload artifacts or publish to npm. The service tests create temporary synthetic accounts and a local HTTPS server. One test uses the runner's own LAN address to verify that remote bootstrap is refused. Dependency installation still downloads packages and the service's native SQLite addon. Gitleaks downloads its pinned CLI release; no Gitleaks Action license or repository secret is needed. The exact synthetic desktop-feedback key is allowlisted only in its test file; history scanning remains enabled.

The publisher's combined service-route test requires both installs. It is deliberately excluded from the desktop-only job; the independent service job exercises the real update routes. To run that combined integration check locally, use Node 24.16.0, install the workspace with `pnpm install --frozen-lockfile`, run `npm ci` inside `apps/company-service`, then run this from the repository root:

```powershell
node --test apps/desktop/scripts/publish-lan-update.test.mjs
```

## Additional manual checks

The broader media/render checks remain available through the existing scripts. Run them in a disposable checkout on each of Linux, macOS and Windows, with FFmpeg/ffprobe installed:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter daocut exec playwright-core install --with-deps chromium-headless-shell
pnpm test
```

`pnpm check:pack` checks a locally created package; it does not publish. Build Studio first. The package profile has desktop updates disabled, and the check verifies that packing restores the checkout's original `product.json`. Company installers receive an update address only through their explicit build configuration.

`pnpm audit:public` remains a legacy content check. Its restrictions on Chinese text and workstation paths are not Daocut's publication policy, so it is not included in company CI. Gitleaks independently checks source history for secrets.

## Packaging

`daocut-windows.yml` is the retained, manually triggered Windows installer workflow. It uses the supplied company profile and update address, builds artifacts, and does not publish them. The unused repository-specific desktop release, npm release and nightly agent workflows have been removed. Pushes and tags do not trigger an automatic release.
