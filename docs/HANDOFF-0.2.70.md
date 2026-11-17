# Daocut 0.2.70

Updated 2026-11-17. Version 0.2.70 was published to the configured company update feed on 2026-11-16. The actual Electron updater detected and downloaded it, and its SHA512 matched the verified installer. Publishing did not install it on, restart, or close the user's running desktop.

## Completed behavior

- Shared readers restore the original confirmed product layout and exact saved analysis associations. Layout revisions are separate from immutable model results. Existing candidate IDs, historical ranges, source selections and personal drafts survive refreshes and later layout corrections.
- Normal product saves publish the confirmed layout. Failed shared writes retain a pending receipt for retry without another model request. First analyses completed after an initial shared import can also be recovered.
- Public transcription, discovery, analysis and composition results are saved to the shared live folder when the normal shared workflow completes. Other computers can reuse them. Local-only plans and personal edited copies remain local; explicit reanalysis and private transcript changes do not silently replace public baselines.
- Shared composition restores exact published rounds and preserves prior plan IDs. Joined scopes retain their original analysis ranges. Product discovery reconciles continuous speech and aliases across windows while keeping real return visits separate.
- Candidate filters and source-timeline highlights resolve through the displayed product's saved-analysis mapping. Loading no longer labels an unverified candidate as expired or tells the user to pay for reanalysis.
- Short edits from recordings longer than ten minutes prepare only the selected video range, with a small handle on either side. Preview time maps back to original source time; saved edits and exports keep original coordinates. Existing full proxies can be reused.
- Short audio ranges are prepared separately. Timestamp gaps are filled before PCM playback so browser decoding preserves the selected duration. Long sounds avoid full in-memory decoding.
- A status read hashes the transcript once, and the UI reuses candidate indexes. Idle polling is ten seconds; active-task polling remains two seconds. Windows draft publication uses the existing bounded rename retry.

Composition v8 still requires introduction, selling point, current quoted price and purchase close, with up to three substantively different plans per opening. Historical analysis, plans and prompt versions are preserved; refresh and recovery do not request a new model result.

## Validation and measured limits

Release validation used synthetic fixtures and read-only recovery of completed production artifacts. Model and transcription clients were blocked during the zero-paid-call regression.

| Check | Observed result |
| --- | --- |
| New and existing shared readers | 72 visible products, 1459 candidates, 50 exact analysis associations |
| Saved composition | 58 entry points checked; all 1122 saved plan references across 29 workspaces retained |
| Private work | Original project hashes unchanged; existing reader candidates, film, source selections and private draft bytes preserved |
| Focused regressions | Shared/live: 32 passed; media/drafts: 46 passed; final audio: 9 passed; final draft/browser: 14 passed; UI helpers: 12 passed. These suites overlap and must not be added as a unique-test total |
| Package verification | 294 source/UI files compared; 1109 application files matched the extracted installer, plus the expected installer elevation helper |
| Update delivery | HTTPS manifest, HEAD, Range and blockmap checks passed; actual Electron updater downloaded 305843007 bytes with matching SHA512 |

On the tested six-hour HEVC recording, warm status reads improved from approximately 1.56–1.68 seconds to 0.19–0.45 seconds. Preparing a 30-second preview for the first time took approximately 23.4 seconds; a cached read took approximately 0.11 seconds. A 30-second audio selection decoded to exactly 30 seconds. Real video at 1.3x and after trimming landed at the expected original source time.

These are measurements on one machine, not latency guarantees. Another physical computer still needs installation, login, playback/audio, independent edit/reopen and export acceptance. First-time range preparation still has a visible wait. Unanalyzed material remains unanalyzed. New analysis/composition can incur normal provider charges; shared-result reuse and upload-only retries do not repeat those requests.

## Development checks and continuation

Use isolated test roots and mocked providers as described in [DEVELOPMENT.md](DEVELOPMENT.md). Relevant suites include `shared-workflow-folder-open.test.mjs`, `shared-analysis-workflow.test.mjs`, `shared-composition-scopes.test.mjs`, `shared-product-entry-browser.test.mjs`, `source-playback-browser.test.mjs`, `proxies.test.mjs`, `derived.test.mjs` and `structure-drafts.test.mjs`. Browser tests need a fresh Studio build and the documented `DAOCUT_STRUCTURE_UI` override.

Next acceptance work is the second physical computer and broader recordings/network conditions. Keep production recordings, personal projects, provider receipts, deployment addresses and local acceptance artifacts outside Git. Git synchronization is separate from installer publication; this source update does not run another release or model job.
