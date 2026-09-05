# Direct Agnes Episode Walkthrough

## 1. Resume durable series state

`SeriesState.initialize()` creates the Turso schema and applies supported
additive migrations to older databases. The agent then calls
`get_or_create_series`; `bulk_insert_episode_list` validates and atomically
inserts exactly 25 unique, ordered entries numbered 1 through 25 (or verifies
the existing manifest); and `get_next_episode` returns a discriminated episode
availability result before any character or media work begins.

A `ready` result contains the episode to start or resume. Persisted work always
wins over the daily gate, so the same episode can span as many invocations as
needed. If the latest YouTube-confirmed episode for that series completed on the
current calendar date in `EPISODE_DAILY_TIMEZONE` (default `Asia/Kolkata`) and
the next episode is untouched, the result is `daily_limit`. The agent stops all
tool calls and responds exactly `Only 1 episode per day can be generated.` A
`series_complete` result ends normal season work; `no_episodes` reports a missing
manifest; and `series_missing` reports invalid durable state. None of those
three results may start character or media generation.

The fixed character and environment rosters returned from Turso are canonical.
Existing character sheets are reused. A missing main-character sheet creates
the only new image used by the pipeline: that character's portrait.

## 2. Build a video-sized script

The episode is refined before persistence. The production validator requires:

- 40-60 sequential scenes;
- no hard per-scene spoken-word minimum, no more than 20 spoken words, and no
  more than 200 raw characters per narration;
- at least 750 spoken words across the episode;
- one visible action/location/emotional beat per scene;
- aligned `characterNames` and `characterVisuals`;
- stable `supportingEntities`, `continuityAnchors`, environment, camera, and
  lighting across any child scenes created by splitting.
- genuinely distinct visual beats; an exact beat copied under a new scene
  number is rejected.

Only a refinement result with `status: "ready"` includes `scriptJson`. The Turso
save path independently enforces the same core narration manifest, so an old
long-scene script cannot accidentally become the current production script.

A stored script may be replaced only before Agnes submission has begun. A
genuine pre-submission replacement invalidates zero-attempt Agnes and assembled
output rows; accepted, submitting, or ambiguous provider work is never silently
discarded. Files remain recoverable on disk, and request/audio digests decide
whether each file is safe to reuse.

## 3. Generate exact-text narration

`synthesize_narration_audio` receives one persisted scene narration and makes
one Groq Orpheus request. It preserves the configured voice/model and vocal
directions.

Each WAV has a JSON sidecar containing a SHA-256 request digest, measured
duration, spoken-word count, and duration result. A matching valid pair is
reused. A missing or mismatched sidecar causes regeneration.

If ffprobe measures more than 12 seconds, the tool returns
`duration_exceeded`, `readyForAgnes: false`, and `needsScriptSplit: true`. It does
not expose a usable audio path and does not split or concatenate audio. The
agent must split the script scene, persist the complete revised script, and run
TTS for the affected sequential scenes.

The `audio` episode stage is accepted only after all exact-text WAVs are valid,
each is at most 12 seconds, and their measured total is at least 300 seconds.

## 4. Generate captions and optional sound

Captions use the known narration text and measured duration; no speech
recognition is needed. The SRT remains zero-relative to scene 1; when captions
are burned into the final episode, assembly shifts a private copy by the exact
combined duration of the series and episode key-art videos. Vocal-direction
tags are omitted from caption text.

The existing optional sound-effect/background-music lookup remains available.
Agnes audio is never used.

## 5. Submit Agnes requests

`submit_agnes_scene_videos(seriesId, episodeNumber)` first generates or reuses
the two provenance-bound Groq title WAVs, then builds the required manifest as
`series key art -> episode key art -> every persisted scene`. Key-art prompts
and scene prompts use the approved character sheets and the same explicit
negative anatomy/duplication bible. Before any billable POST it verifies each
matching audio sidecar and measured duration.

Series and episode titles are canonicalized before persistence and limited to
100 characters and 12 spoken words. The generated title WAV is still measured
and must be no longer than 12 seconds before either matching Agnes video is
submitted.

For each key-art or scene asset it computes:

```text
provider seconds = clamp(ceil(WAV seconds), 4, 12)
request digest   = hash(model + prompt + seconds + seed + exact WAV duration)
```

Before preparing requests, the series atomically stores one Agnes seed.
`AGNES_SEED` is only the preferred initial value when that row is still empty;
blank creates a random initial value. The first committed value is sent
unchanged for both key arts and every scene, account, episode, and rerun in that series,
regardless of later environment changes.

A pre-POST claim is written atomically to Turso. This prevents two local
invocations from knowingly submitting the same asset. The accepted receipt
stores `video_id`, task identity, provider status, and a fingerprint of the key
that submitted it.

Each `AGNES_API_KEY[_N]` represents one separately approved Agnes account, not
another credential for a shared account. Its optional matching
`AGNES_ACCOUNT_ID[_N]` is the stable, non-secret scheduler identity and defaults
to `account-N`. Submission and status request starts use separate durable Turso
gates, each limited to two requests per minute per account by default. A slot
is reserved before the outbound request, with at most two local submission
workers per account. This means adding a valid independent account adds an
independent budget without merging or resetting another account's window.

Legacy timing settings can only slow those gates further. The effective POST
spacing is the larger of the submission RPM interval and
`AGNES_SUBMISSION_INTERVAL_MS`; zero adds no extra delay but does not disable
the RPM gate. Status GETs likewise honor the status RPM interval,
`AGNES_POLL_INTERVAL_MS`, and the 30-second production floor. The normal Agnes
POST already returns `queued` (or a later status); any intermediate
acknowledgement is checked for at most five minutes, and its GETs also reserve
status slots for the submitting account.

Failure policy:

- only definite key-scoped rate-limit, daily-limit, quota-exhausted, or
  insufficient-credit errors permit cross-account failover; a provider
  `retryAfter` cools only the rejected account;
- a definite queue-full/provider-busy rejection stays `pending`, does not fail
  over, and is retried only on a later invocation;
- authentication/configuration/validation failures, network/timeout/5xx errors,
  and malformed-success ambiguity never trigger cross-account failover;
- a network timeout, interrupted POST, malformed successful response, or other
  uncertain POST result is persisted as `ambiguous` and cannot be retried until
  its 10-minute stale lease expires;
- a crashed pre-POST claim is also reclaimed only after that lease; recovery of
  a post-started or ambiguous claim reports the unavoidable duplicate-render
  risk because Agnes does not expose an idempotency key or task-history lookup;
- a persisted accepted receipt is never replaced;
- retrieval always uses the exact submitting account and key fingerprint.

Do not remove or replace a submitting key while its tasks are still active;
the provider requires that exact credential for later status retrieval.

## 6. Verify after queue acknowledgement

`verify_agnes_scene_videos` can run in the same invocation when submission has
no pending assets; normally it runs on a later invocation while Agnes renders.
It first finds missing or safe-pending key-art/scene assets. If any exist, it applies the same
submission logic once and returns `stopRun: true`.

When both key arts and every scene have accepted receipts, verification retrieves each task once
and persists `queued`, `in_progress`, `completed`, or `failed`. Provider
completion is distinct from local download completion:

```text
status = completed
download_status = pending
```

If any task is still rendering, the run ends safely. No accepted task is
submitted twice.

## 7. Download only when globally ready

`download_agnes_scene_videos` first verifies that every expected task is
provider-complete and has an output URL. If even one is not ready, nothing is
downloaded.

Once globally ready, downloads run with bounded concurrency. Raw scene media is
stored beneath `agnes_text/raw`, while key-art raw media stays in each dedicated
key-art directory. ffmpeg removes all provider audio, converts to the assembly
format, and trims each canonical MP4 so it exactly matches its Groq WAV.
Successful rows become:

```text
status = completed
download_status = downloaded
normalized_output_path = .../agnes_text/scenes/scene_NNN.mp4
```

## 8. Assemble one canonical episode

`assemble_episode_video` accepts only the ordered narration/SFX manifest. It
automatically resolves and prepends the canonical series and episode key-art
video/audio pairs, then resolves scene audio exclusively from canonical
`audio/scene_NNN_narrator.wav` paths and visuals from
`agnes_text/scenes/scene_NNN.mp4`. It checks order, Turso completion/download
state, audio provenance, and measured duration equality, uses every pair
exactly once, and inserts no transition padding.

The output is `<Series>_episode_<N>_agnes_text.mp4`. Optional music and caption
burn-in remain supported. The subscribe outro reuses the last scene frame; no
new still image is created.

## 9. Upload and clean state

Before YouTube upload, the tool verifies that the requested path is the
canonical ready output. If durable episode or recovery state already contains
a YouTube receipt, it returns that receipt without intentionally uploading the
same episode again and can finish any interrupted local finalization.

After YouTube returns a video id, the integration durably records the receipt
for recovery and calls `finalizeEpisodeUpload`. This is the only terminal path:
intermediate status updates cannot mark an episode done. Finalization:

1. stores the YouTube id/URL and canonical output path;
2. marks the episode `done` and records its upload/completion timestamp plus the
   corresponding local calendar date in `EPISODE_DAILY_TIMEZONE`;
3. clears the completed script payload;
4. removes that episode's Agnes-generation and final-output tracking rows;
5. removes obsolete legacy key-art rows;
6. clears any temporary upload-recovery record once the episode receipt and
   cleanup have committed.

Series/episode identity, the final output path, YouTube receipt, completion
timestamp/date, fixed roster, and character sheets remain. Therefore reruns keep
selecting an unfinished active episode, while the invocation after a successful
upload is prevented from starting the next untouched episode until the next
configured calendar day. Completed local media remains available on disk.
