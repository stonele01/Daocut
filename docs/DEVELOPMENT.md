# Development handoff

Current implementation: **0.2.51**. Read [the current release handoff](HANDOFF-0.2.51.md) for composition rules, playback fixes and validation scope. [The 0.2.29 handoff](HANDOFF-0.2.29.md) remains a historical record; its rule descriptions are superseded below.

Composition v8 preserves historical results and independent drafts. The local desktop was updated to 0.2.51 on 2026-11-13 after packaged and real UI verification. Source synchronization does not publish an installer or update the company feed. Existing analysis is not automatically rerun, and model completion is not proof that every valid combination was covered. Offline recovery of a completed window does not authorize requesting missing windows or publishing incomplete analysis.

## Current behavior

- Use one **Transcribe and discover products** entry. Reuse saved transcription and join continuous same-product speech across text batches. Select one product lecture occurrence; saved manual range edits determine the next analysis scope. Analysis and composition are separate operations. Do not silently combine returning lectures.
- Reuse saved public analysis. Completed results are not automatically re-analyzed; uncertain results/costs are not automatically resubmitted.
- Analysis keeps independently understandable speech and necessary continuous context. Product introduction describes what is sold; selling points describe its attractive qualities. Price and benefits are separate roles. Complete comparisons can coexist with usable independent subranges.
- Composition v8 requires an introduction, a selling point, a current quoted price and a purchase close. It evaluates price changes against the selected lecture's chronological transcript with cue evidence; an old or reference price alone does not qualify. New plans use 1.3x playback and a 30–40 second finished duration. Historical prompts, results and drafts retain their identities.
- One opening has at most three substantively different plans, including existing valid plans. Fewer are allowed; changing only the purchase close does not count. Requested-opening progress is separate from accepted-plan coverage. Refresh/reopen/recovery never sends a model request. Preview leaves the timeline untouched; editing opens an independent personal draft.
- Successful reanalysis archives only unchanged previous AI candidates in that scope. Manual additions/edits and other scopes remain intact. Old plans and personal drafts are not rewritten to match new prices or rules.
- The first video sizes an otherwise empty default canvas; populated/custom canvases remain unchanged. Paused cold seeks retain the visible frame until the target decodes. Cold-start captions prepare the actual shared media references before reading saved transcription.
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
- ai-structure.mjs, ai-structure-priced.mjs, ai-structure-required.mjs, ai-structure-variants.mjs and ai-structure-plans.mjs: cue evidence, current price validation, mandatory roles, distinct plans, opening progress, version selection and recovery. Historical implementations remain available for saved versions.
- structure-drafts.mjs and structure-workspace.mjs: independent personal drafts.
- structure-batch-exports.mjs: selected Jianying exports.
- studio/ui/src/components/ProductVisualReview.tsx, ProductPanel.tsx and StructureWorkspace.tsx: review details, selected lecture and plan/draft UI.

## Focused checks

Run from the repository root with temporary directories inside the disposable checkout:

    node --test packages/daocut/studio/server/product-visual-review.test.mjs packages/daocut/studio/server/live-analysis-visual-integration.test.mjs packages/daocut/studio/server/structure-plans.test.mjs
    node --test apps/desktop/src/product-vision-client.test.mjs apps/desktop/src/desktop-analysis-service.test.mjs apps/desktop/src/visual-review-desktop-e2e.test.mjs

The desktop end-to-end fixture creates synthetic audio/video, runs actual local sampling and the actual SDK, and mocks provider responses. Browser tests require the editor build and Playwright Chromium; set DAOCUT_STRUCTURE_UI to that build for structure-workspace-browser.test.mjs. Legacy suites may expect a .test-temp directory in the working directory.

See the [0.2.51 handoff](HANDOFF-0.2.51.md) for packaged test counts and real playback acceptance. Existing CI covers desktop/company types and selected authorization, update and service tests; it is not a complete media-workflow acceptance suite. A broader rollout still needs fresh-machine installation/update/rollback and representative multi-machine shared-storage trials.

## Collaboration

Create a feature branch and submit a pull request. State what changed, why, tests run and remaining limits. Do not commit real source media, local session URLs/keys, raw production model receipts, private project data or deployment handoff notes. Do not automatically retry model requests whose outcome is unknown. Preserve copyright notices and keep company account/configuration values out of examples.

## Performance checks

Desktop benchmark tools remain in `apps/desktop/bench/`. Run a new baseline on the current machine and compare only runs made under the same conditions. The repository does not bundle historical benchmark measurements. From `apps/desktop`, use `node bench/run.mjs --label baseline` to generate `bench/results/baseline.json`, then give your result files explicitly to `node bench/report.mjs`. Use the isolated development directories described above; these commands launch disposable benchmark app instances.

Keep generated benchmark output, production recordings, project data, secrets and local session links out of commits. The root .npmrc names workstation-local caches; contributors can override npm_config_store_dir and npm_config_cache with directories inside their own checkout.
