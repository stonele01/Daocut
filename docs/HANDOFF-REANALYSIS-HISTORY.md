# Reanalysis defaults and retained history — unreleased

Ordinary reanalysis of an existing shared speech result previously produced a local-only run. The existing shared-version workflow now publishes a successful rerun and makes it the active result. The earlier analysis remains available as a historical scope with the same structure-plan input identity. Failed analysis or interrupted publication keeps the previous result active. Explicitly creating a shared draft still requires the existing adoption action.

The product card continues to analyze and compose from its saved full lecture range. History rows have a **View old structures** action that only reads saved plans. Returning to the product card's compose action uses the current full result. New plans still require the user's compose action; reanalysis does not generate plans automatically or replace edited personal drafts.

An existing colleague project can refresh shared analysis to read the published result, and a newly opened project reads the version referenced by the shared product layout. Old ranges, candidate references, and personal files remain available. Repeated refreshes do not duplicate the versions. There is no background push into an idle colleague project.

Targeted tests use synthetic responses and isolated projects. They cover successful and failed reruns, imported and edited old candidates, interrupted publication with and without an outbox, interrupted version adoption, old plan input identity, full-range completion after a colleague has read the old parts, new and existing colleague readers, and read-only history UI. No real model or transcription service is called.

This is a source change awaiting release. Installed applications and the company update feed are unchanged. Prohibiting all repeated requests, analyzing only missing portions, and automatically completing historical partial results are outside this change.
