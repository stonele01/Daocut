# Daocut 0.2.72

Updated 2026-11-17. New selected-plan Jianying exports retain only the source ranges used by those plans. They no longer copy a complete live recording to save a few short drafts. Installer delivery is recorded separately in the local deployment log.

## Behavior

- The existing selected-plan batch exporter freezes public plans or the matching personal edits, extracts their used ranges, and passes a rebased edit to the existing Jianying exporter. Clip order, speed, subtitles, translations and style retain the saved values.
- FFmpeg precisely cuts each used range at the original resolution, encoding H.264 CRF 18 and AAC audio. This is a new encode, not a lossless copy. The shipped FFmpeg dependency is reused. Accurate input seeking with transcoding discards the lead-in before the requested point; see the [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html#Main-options).
- Identical source ranges in the same batch share one extracted file. Hard links avoid per-plan media copies on supported destinations; other destinations copy only the short extracted files. Completed draft media is independent of the original recording.
- Free-space estimates use the selected ranges. Interrupted work cannot publish an incomplete clip, and changed source or extracted media is rejected. Retry preserves the frozen edit rather than taking later changes.
- Product cards, product discovery, transcription, analysis and structure composition are unchanged. Existing product results and shared plans are not rewritten or regenerated.

The exported media ends at the selected range boundaries. To extend an edit into footage outside those ranges, change the selection in Daocut and export again. Original recordings remain available in the source project.

## Verification

- 65 focused tests passed across snapshots, batches, private drafts, selected media and Jianying integration. The media tests compare decoded video frames and audio timing, preserve word-level captions and translations with mixed speeds, verify duplicate-range sharing, reject corrupted cache files, and cover destinations without hard links. Legacy full-file identities remain checked with their original format and verified cache; an uncached legacy identity may need an initial full read, but not a full copy.
- Four existing public plans, lasting approximately 30.6–40.0 seconds, were exported from a read-only 30,248,294,018-byte production recording into isolated real Jianying draft files. Their 18 clip uses shared nine unique segments totaling 200,507,821 bytes. Extraction plus draft generation took 45.96 seconds on the acceptance machine; this is a measured example, not a performance guarantee for another computer or source.
- All four drafts retained their saved clip counts, 1.3x speed and captions. The existing 1,459 candidates, 72 display intervals and 30 saved plan-workspace files were preserved. No full original-media copy occurred.
- Model and paid transcription requests: zero. Tests block those network paths and reuse saved results.
- CI now runs the selected-media and Jianying integration tests using the desktop's existing checksum-pinned FFmpeg download.

After upgrading, select the existing plans and create a **new export batch**. Already-frozen version-1 batches retain their previous full-source behavior for compatibility; “continue unfinished” does not convert those old batches. Reanalysis and plan regeneration are unnecessary. This patch does not delete previous export media or failed output folders.

Real draft generation has passed on the acceptance machine. Opening the resulting drafts in Jianying on another physical computer remains a separate user-side acceptance step.
