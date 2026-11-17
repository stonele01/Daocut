# Daocut 0.2.71

Updated 2026-11-17. This patch fixes batch Jianying export failures after restoring a shared product layout. Installer delivery is recorded separately in the local deployment log.

## Changes

- Public exports accept the exact, confirmed historical analysis scope already used by saved plans and private drafts. Source, product, scope ID, bounds and clip limits still have to match. Unconfirmed, changed or ambiguous scopes are rejected. Export does not request a new analysis or rewrite the saved plan.
- Shared video snapshots retain their sampled identity format. A sampled digest is checked using that format instead of being compared with a full-file digest. Frozen copies are also verified against the complete original contents; unchanged size alone is insufficient.
- Before copying a new shared batch source, export checks free space in the destination and reports the required and available GB. An ENOSPC failure is remembered for the rest of that batch; an explicit retry can try again after space is available. Existing verified copies can be reused without allocating another full source copy.
- Failed batches use the warning progress color. Their completed and failed counts remain separate.

The batch still retains one full original video per batch so exported drafts remain independent of later source changes and can be trimmed in Jianying. All plans in that batch share it. Selecting a different drive does not eliminate this storage requirement. No existing project, cloud result, draft or user file is deleted to reclaim space.

## Verification

- 62 focused tests passed for snapshots, batches, private drafts and Jianying serialization.
- Three export integration tests passed. Synthetic video produced real Jianying draft files from a restored historical public plan and an edited private copy; source time, 1.3x/2x speed, captions and shared media reuse were checked.
- The browser regression for stale export selections passed; private edits survived the refresh.
- Server/UI type checks and isolated Studio/desktop-shell builds passed.
- Four existing saved public plans passed metadata capture against a read-only production source. The production video was not copied or exported; insufficient destination space was rejected before any large copy. Existing analysis and saved plan records were unchanged.
- Model requests and paid transcription requests: zero. New tests use blocked network/model paths and isolated fixtures.

After upgrading, reselect the plans and create a new export batch for the earlier range-error failures. Those failed items contain no frozen snapshot, so they cannot be resumed as the same batch. Space failures with a saved snapshot can be resumed after freeing sufficient space; choose a new batch when changing the destination folder. Do not reanalyze or regenerate saved plans to work around either error.

The full production recording and another physical computer still need user-side Jianying acceptance. Synthetic draft generation and metadata checks do not establish that a full production export has completed on that computer.
