# Development handoff

Current implementation: **0.2.29**. Read [the current handoff](HANDOFF-0.2.29.md) for the three prompts, legacy-result upgrade entry, validation evidence and remaining acceptance work.

## Current behavior

- Select one product lecture occurrence. Text analysis and structure composition are separate operations. Do not silently combine returning lectures.
- Reuse saved public analysis. Completed results are not automatically re-analyzed; uncertain results/costs are not automatically resubmitted.
- AI composition can choose complete continuous cue ranges within longer analyzed units, retaining necessary context. Non-purchase units can open a video; one or two selling-point units and a purchase close are required. New v2 plans use 1.3x playback and a 30–40 second finished duration. Existing v1 plans retain their speed and contents; body ordering rules are unchanged.
- AI selects the source ranges and order; code validates and deduplicates the returned plans. Do not claim mathematical exhaustion from a model completion flag. Preview leaves the timeline untouched; editing opens an independent personal draft. An explicit new-rules entry preserves old results and reuses a colleague's existing new result before offering a paid request.
- Each draft preserves its own trimming, order, subtitles and settings. Existing parent films and public baselines are not overwritten by personal edits.
- Selected plans export using the existing Jianying draft exporter. Personal drafts take priority and each export freezes its own input.
- Single-product analysis reuses local look sampling and the existing desktop image-capable chat model. Save the raw reply, receipt, product-match/display observations and evidence times for later composition reuse. A sampled still image does not establish continuous action or audio meaning.

## Setup and isolation

Use Node 24 (minimum 22.18), pnpm 9.15.9, Git, FFmpeg and ffprobe. Install workspace dependencies with pnpm install --frozen-lockfile. The independent company service has its own lockfile: npm --prefix apps/company-service ci. No existing company data directory is needed.

Before using development commands, set DAOCUT_HOME, DAOCUT_STUDIO_HOME, DAOCUT_SHARED_HOME, DAOCUT_LIBRARY, DAOCUT_EXPORTS, DAOCUT_TRASH_DIR and TEMP/TMP to directories inside a new disposable checkout. Use a distinct DAOCUT_STUDIO_PORT for browser Studio. The desktop dev flavor uses port 4857 and derives its library and app data from DAOCUT_HOME; setting only DAOCUT_LIBRARY is insufficient. Do not point these values at installed data or real shared storage. The default pnpm dev command can otherwise reuse a shared library. See CONTRIBUTING.md for a PowerShell setup example.

For development and tests, inject mock model/transcription clients and use synthetic media. Never read a colleague's provider configuration. Build the editor with pnpm --filter daocut build:ui. Use pnpm typecheck for type checks. Do not run package/update/release workflows to test an editing change.

## Main implementation

- packages/daocut/studio/server/live-analysis.mjs and product-workflow.mjs: analysis, confirmation, recovery and reuse.
- product-media-review.mjs and product-visual-review.mjs: local sample evidence, model judgment validation and durable records.
- apps/desktop/src/product-vision-client.mjs and desktop-analysis-service.mjs: existing SDK/model/receipt integration.
- approved-prompts.mjs and studio/server/prompts/*.txt: complete reviewed prompts; docs/prompts-review-20261111/*.txt is the test baseline.
- ai-structure.mjs, ai-structure-ranges.mjs and ai-structure-plans.mjs: AI requests, complete subranges, exact version selection, confirmation and recovery. structure-composition.mjs and structure-plans.mjs retain shared input and legacy validation support.
- structure-drafts.mjs and structure-workspace.mjs: independent personal drafts.
- structure-batch-exports.mjs: selected Jianying exports.
- studio/ui/src/components/ProductVisualReview.tsx, ProductPanel.tsx and StructureWorkspace.tsx: review details, selected lecture and plan/draft UI.

## Focused checks

Run from the repository root with temporary directories inside the disposable checkout:

    node --test packages/daocut/studio/server/product-visual-review.test.mjs packages/daocut/studio/server/live-analysis-visual-integration.test.mjs packages/daocut/studio/server/structure-plans.test.mjs
    node --test apps/desktop/src/product-vision-client.test.mjs apps/desktop/src/desktop-analysis-service.test.mjs apps/desktop/src/visual-review-desktop-e2e.test.mjs

The desktop end-to-end fixture creates synthetic audio/video, runs actual local sampling and the actual SDK, and mocks provider responses. Browser tests require the editor build and Playwright Chromium; set DAOCUT_STRUCTURE_UI to that build for structure-workspace-browser.test.mjs. Legacy suites may expect a .test-temp directory in the working directory.

The current visual integration passed 225 focused checks in the originating isolated environment. These checks establish wiring, evidence validation, reuse, draft protection and recovery; they do not establish real-model visual accuracy, real NAS behavior or a fresh-machine installation. A separate real-data acceptance requires explicit authorization.

## Collaboration

Create a feature branch and submit a pull request. State what changed, why, tests run and remaining limits. Do not commit real source media, local session URLs/keys, raw production model receipts, private project data or deployment handoff notes. Do not automatically retry model requests whose outcome is unknown. Preserve copyright notices and keep company account/configuration values out of examples.

## Performance checks

Desktop benchmark tools remain in `apps/desktop/bench/`. Run a new baseline on the current machine and compare only runs made under the same conditions. The repository does not bundle historical benchmark measurements. From `apps/desktop`, use `node bench/run.mjs --label baseline` to generate `bench/results/baseline.json`, then give your result files explicitly to `node bench/report.mjs`. Use the isolated development directories described above; these commands launch disposable benchmark app instances.

Keep generated benchmark output, production recordings, project data, secrets and local session links out of commits. The root .npmrc names workstation-local caches; contributors can override npm_config_store_dir and npm_config_cache with directories inside their own checkout.
