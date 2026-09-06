# Standalone script safety

The production episode flow runs through the agent and its persisted Turso
state. It enforces one scene, one canonical narrator WAV of at most 12 seconds,
and one canonical Agnes text-to-video clip, plus two canonical Agnes key-art
title-card/video pairs. Assembly uses series key art, episode key art, and every
scene exactly once and adds no inter-scene transition padding.

These historical utilities intentionally fail closed because their contracts
predate that flow:

- `evaluateAgnesFirstScenes.ts` split one long scene into multiple Agnes jobs
  and appended the results.
- `manualEpisodeTest.ts` generated key art and scene images.
- `manualReassembleAndUpload.ts` assembled still images/key art and bypassed
  persisted upload state.

They remain in place so old direct commands produce a clear migration message
instead of silently creating incompatible or duplicate-looking output.

## Gated historical image utilities

The following utilities retain bespoke recovery or diagnostic logic, but they
are not production entry points and their scene/key-art images are not consumed
by Agnes-only assembly:

- `regenerateSeries28Media.ts` archives/removes and regenerates legacy Series 28
  key art and scene images.
- `generateConceptTestSet.ts` creates historical concept key art and scene-image
  test sets.
- `manualEdit.ts` sends one legacy scene PNG to paid image-edit providers.
- `testEpisodeSceneDrift.ts` drafts test scripts and generates legacy scene
  images across several episodes.
- `testAnyApiImage.ts` makes a direct paid scene-image smoke-test request.

All five fail before database, filesystem, or provider work unless the operator
deliberately supplies `--allow-legacy-image-flow`. Supplying the flag does not
make their outputs production-compatible; it only acknowledges the historical
diagnostic and its possible provider cost.
