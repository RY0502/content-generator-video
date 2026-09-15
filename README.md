# Kids Story Video Generator

This project creates preschool story episodes with reusable character portraits,
Groq narration, and direct Agnes Video 2.5 Flash generation. Production generates
images only for the series' main-character portraits; scenes and both title cards
are videos generated directly by Agnes.

## Production flow

1. Create or resume a series and its fixed 25-episode manifest in Turso.
2. Select the unfinished episode, subject to the per-series daily completion gate.
3. Ensure one portrait for each of the series' 1-5 main characters. A portrait is
   reused locally, restored from Supabase Storage, or generated once and uploaded.
4. Author 40-60 sequential scenes in resumable chunks.
5. Generate one Groq narration WAV per scene plus the two title narration WAVs.
6. Submit both title videos and every scene video to Agnes. Each asset receives
   only the public portrait URLs for main characters visible in that asset.
7. On later runs, verify accepted Agnes tasks with the same account/key and
   download only after every required task is complete.
8. Mute and trim each scene clip to its exact measured narration duration.
9. Run deterministic static media validation, then assemble the title clips,
   scenes, narration, captions, and outro.
10. When YouTube upload is enabled, only a durable successful upload marks the
    episode complete. Completing the final manifest episode also removes that
    series' character portraits from Supabase.

Every phase stores durable state. A fresh process resumes missing portraits,
script chunks, audio, Agnes tasks, downloads, QA, assembly, or upload without
recreating accepted work.

## Character portrait references

A series must have between one and five uniquely named main characters. The
five-character limit matches Agnes' maximum reference-image count. Character
names should be explicit, for example `Bobo the Backpack`, and map to clear
object names such as `bobo_the_backpack.png`.

The portrait lookup order is:

1. Verified local portrait metadata and file.
2. The deterministic public Supabase URL for the series and character name.
3. A new AnyAPI portrait generation followed by Supabase upload and public
   re-download verification.

Scene and title prompts do not include full character sheets, extracted visual
descriptions, or appearance paragraphs. They contain exact names and an ordered
`<Picture N>` identity map. A scene sends only the portraits for main characters
listed in that scene's `characterNames`; off-screen character portraits are not
sent. A missing, non-public, or incomplete reference set fails before submission
instead of silently switching identity strategy.

Create `SUPABASE_STORAGE_BUCKET` as a public bucket. The service-role key stays
server-side and is used only for exact portrait upload and cleanup operations.

```dotenv
ANYAPI_BASE_URL=https://api.anyapi.ai
ANYAPI_KEY=
# ANYAPI_KEY_2=
ANYAPI_IMAGE_MODEL=google/gemini-3.1-flash-image-preview

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_STORAGE_BUCKET=agnes-character-references
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_CHARACTER_REFERENCE_PREFIX=series-characters
SUPABASE_STORAGE_REQUEST_TIMEOUT_MS=60000
```

## Scene and audio contract

The synchronization invariant is:

```text
one script scene
  = one narrationText
  = one Groq WAV
  = one Agnes request
  = one normalized final clip
```

Scenes remain visually detailed, with environment, action, supporting entities,
continuity anchors, camera, lighting, color, and atmosphere. Main-character
appearance is deliberately excluded from scene prose because portraits are the
identity authority.

Static script validation is intentionally narrow. It enforces sequential scenes,
required nonempty narration/environment/action, exact unique roster names, no
more than five main-character references, and narration limits of 200 raw
characters and 20 spoken words. Story plans and optional descriptive fields guide
quality but do not cause semantic rejection loops.

The measured WAV is authoritative and must be at most 12 seconds. Any overlong
WAV triggers narration-only repair; all other scene fields remain unchanged.
There is no five-minute aggregate narration gate. Agnes receives an integer
duration from 4 through 12 seconds:

```text
providerSeconds = clamp(ceil(measuredNarrationSeconds), 4, 12)
```

The downloaded clip must cover the WAV duration. It is muted and trim-only
normalized to the exact audio duration; the pipeline does not repeat, freeze,
stretch, or concatenate generated clips to hide a mismatch.

Every Agnes prompt carries an exact cast ledger and negative constraints against
duplicate/unlisted figures, duplicate object characters, identity or age drift,
photoreal/live presenters, extra limbs, and double/fused heads. Supporting
entities and continuity anchors are repeated only in scenes where they apply.

## Agnes scheduler and resumability

The generation lifecycle is split across four tools:

- `submit_agnes_scene_videos` submits both title cards and all scenes, persisting
  a pre-request claim and accepted provider receipt.
- `verify_agnes_scene_videos` polls accepted tasks with their submitting account
  and safely resubmits only work known not to have been accepted.
- `download_agnes_scene_videos` downloads and normalizes clips only after every
  required asset is provider-complete.
- `qa_agnes_episode_videos` performs static integrity validation without an LLM,
  image model, contact sheet, or automatic rerender.

Each configured Agnes account is an independent lane with two submission workers
by default. Submission and status request slots/cooldowns are persisted in Turso,
so restarts do not reset rate limits. Definite account-scoped quota/rate/credit
errors may rotate to another account. Queue-full, busy, network, timeout, 5xx,
authentication, validation, and ambiguous responses do not rotate an accepted or
possibly accepted request. Retrieval always uses the submitting credential.

```dotenv
AGNES_API_KEY=
# AGNES_API_KEY_2=
# AGNES_API_KEY_3=
# AGNES_API_KEY_4=
# AGNES_API_KEY_5=
# AGNES_ACCOUNT_ID=account-1
# AGNES_ACCOUNT_ID_2=account-2
AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_REQUEST_TIMEOUT_MS=60000
AGNES_POLL_INTERVAL_MS=30000
AGNES_POLL_WINDOW_MS=480000
AGNES_QUEUE_POLL_INTERVAL_MS=30000
AGNES_QUEUE_POLL_WINDOW_MS=300000
AGNES_SUBMISSION_BATCH_SIZE=2
AGNES_SUBMISSION_RPM_PER_ACCOUNT=2
AGNES_STATUS_RPM_PER_ACCOUNT=2
AGNES_SUBMISSION_INTERVAL_MS=0
AGNES_MAX_DOWNLOAD_BYTES=500000000
AGNES_SEED=
```

`AGNES_SEED` is only a preferred initial series seed. The first value is stored
and reused. Each title/scene then receives a deterministic derived seed so reruns
are reproducible without forcing every different shot toward one composition.

## Static video QA

QA makes no Gemini or AnyAPI analysis calls. It validates the durable asset set
and each current source binding, including:

- both title clips and every scripted scene are present;
- ordered visible-character references exactly match approved public portraits;
- frozen prompt/reference/request digests still match;
- the normalized file is one 1920x1080 H.264 video stream with no audio stream;
- duration covers and matches the corresponding WAV within tolerance; and
- two distinct required assets are not byte-identical files.

Results are persisted against the current asset set and source digest, so later
runs reuse valid passes. Failures are actionable and terminal for that source;
static QA never spends Agnes quota on speculative rerenders.

## Daily gate and completion

The one-episode-per-day rule is scoped to each series and uses
`EPISODE_DAILY_TIMEZONE` (default `Asia/Kolkata`). It counts only genuinely
completed episodes. An episode in script, audio, Agnes, QA, assembly, failure, or
upload-recovery state can be resumed as many times as needed. When the latest
episode completed today, a new one is not started and the agent returns:

```text
Only 1 episode per day can be generated.
```

An episode is marked `done` only after YouTube upload succeeds and its upload and
completion timestamps are stored. Set `YOUTUBE_UPLOAD_ENABLED=false` to omit the
upload tool entirely and leave assembled episodes resumable at `assembly`.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Required groups in `.env` are:

- Neon for framework/checkpoint state and Turso for durable production state;
- AnyAPI for portrait generation;
- Supabase public Storage for portrait references;
- Groq Orpheus for narration;
- one or more independently approved Agnes accounts; and
- YouTube OAuth only when uploads are enabled.

Tables and additive columns are initialized automatically. They can also be
created explicitly with `npm run db:setup`.

Run or resume a concept with:

```bash
npm run dev -- "Generate the next episode for the Tiny Heroes Club concept"
```

Every canonical invocation first runs the Neon framework-state cleanup. Whether
the run succeeds, stops normally, or throws, it then sends one bounded GET to
`${PAUSE_BASE_URL}/pause/vm?machine=${MACHINE_NO}`. Run only one canonical agent
invocation at a time for a deployment because startup cleanup is schema-global.

## Output layout

```text
assets/
  series_<id>/characters/<Character_Name>/<request_digest>/
    <clear_character_name>.png

output/series_<id>/episode_<number>/
  audio/
    scene_001_narrator.wav
    scene_001_narrator.metadata.json
  captions.srt
  agnes_text/
    key_art/series/series_key_art.mp4
    key_art/episode/episode_key_art.mp4
    prompts/
    raw/
    scenes/scene_001.mp4
    qa/static_media_integrity_v1.json
  <Series>_episode_<number>_agnes_text.mp4
```

Legacy character sheets, key-art images, and scene images may remain on disk for
old episodes, but the registered production flow neither creates nor reads them.
