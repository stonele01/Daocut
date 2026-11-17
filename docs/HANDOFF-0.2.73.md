# Daocut 0.2.73

Updated 2026-11-17. Selected plans can be exported as separate Jianying projects (the existing default) or as one new combined project, using the same export dialog and queue.

- Combined mode places only checked plans consecutively in their displayed plan-number order. Each plan retains its matching personal edit when available, including trims, speed, audio levels and subtitle text/language. Unedited plans use their saved public version.
- The first plan supplies the combined canvas and frame rate. Other canvas sizes fit within it. Video/audio clips and subtitles remain editable; the plans are not flattened into one rendered video. Subtitle appearance follows the existing native Jianying exporter.
- Both modes retain the existing Jianying draft-library / selected-folder destination choices, selected-range extraction and batch media sharing. They do not copy the complete livestream recording.
- Every selected edit is frozen before the combined export starts. An unreadable plan fails the combined item rather than silently omitting it. Retry uses frozen versions; a completed draft's receipt prevents a duplicate export after restart.
- Transcription, product discovery, analysis, composition prompts, existing shared results and private drafts are unchanged. No additional analysis or model requests are needed.

Verification: 67 focused snapshot, selected-media, batch, private-draft and real Jianying serialization tests passed. A two-plan integration case checks one native draft, ordered consecutive time ranges, 1.3x / 2x speeds, private captions, selected-only media, unchanged parent/private edits, restart recovery and the existing separate export mode. Capture-failure coverage checks that no partial combined draft is dispatched. Studio server/UI type checks passed. Installer and deployment evidence is recorded separately in the local release log; opening the output in another computer's Jianying remains user-side acceptance.
