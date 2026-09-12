# Kids Story Video Generator

This project creates preschool YouTube episodes with fixed character designs,
Groq narration, and direct Agnes Video 2.5 Flash scene generation. Character
portraits are the only generated images in the production pipeline.

## Production flow

1. Create or resume a series in Turso, then atomically validate or insert its
   exact 25-episode manifest (episodes 1 through 25).
2. Select the episode in durable state. An episode already in progress is
   resumed; starting another episode after one completed today is stopped by
   the per-series daily gate.
3. Only after an episode is selected, generate or reuse one portrait/sheet for
   each fixed main character.
4. Draft and refine the selected episode into 40-60 short scenes.
5. Generate exactly one Groq narration WAV for every scene. Agnes preflight
   also generates/reuses one provenance-bound title WAV for each of the two
   key-art clips.
6. Generate captions and optional sound assets.
7. Submit two Agnes key-art title-card requests (series, then episode) and one
   Agnes request for every scene. New assets use all visible approved character
   portraits in reference mode when public HTTPS references are available; an
   incomplete or unconfigured reference set falls back atomically to text mode.
8. In the next phase, verify the persisted Agnes jobs (usually on later runs,
   but immediately when submission already reports every job complete); download
   only after all jobs are provider-complete.
9. Normalize every muted Agnes clip to its exact matching Groq duration. Build
   high-resolution start/middle/end contact sheets and have Gemini on AnyAPI
   compare every clip with the approved portrait board and exact scene contract.
10. If QA rejects an asset, archive that render and send only that asset through
   the normal Agnes scheduler once more. A second rejection stops for manual
   review. Once every current render passes, assemble
   `series key art -> episode key art -> scenes -> subscribe outro`,
   and hold only the last scene frame behind the existing outro.
11. Upload the canonical Agnes episode to YouTube. Only a successful YouTube
    receipt can finalize the episode as `done`; finalization records the upload
    and completion timestamps and removes transient episode-generation rows.

There are no generated key-art images, generated scene images, image-edit QA,
or static-video branch in the registered production tools. Both key arts are
direct Agnes videos. The post-download contact-sheet review judges video frames
but never creates or edits scene art. Approved reusable character portraits may
also be passed as Agnes identity references; no scene frame is generated for
that use.

## Daily episode gate

The one-episode-per-day rule is scoped independently to each series and uses the
calendar date in `EPISODE_DAILY_TIMEZONE` (default `Asia/Kolkata`). It limits
successful completed episodes, not CLI invocations: an episode in `script`,
`audio`, `assembly`, failed/retryable, or persisted Agnes/upload-recovery state
can be resumed as many times as necessary, including later on the same day.

After that episode receives its YouTube receipt and is finalized, an untouched
next episode cannot start until the next calendar day. `get_next_episode`
returns a discriminated availability result. When its kind is `daily_limit`, the
agent makes no character, audio, Agnes, assembly, or upload calls and returns
exactly:

```text
Only 1 episode per day can be generated.
```

`ready` supplies the episode to start or resume. `series_complete` stops because
the manifest is finished; `no_episodes` stops because the required manifest is
missing; and `series_missing` reports an invalid series reference. Character
sheets and all episode media work begin only after a `ready` result.

## Scene/audio contract

The synchronization invariant is:

```text
one script scene
  = one narration paragraph
  = one Groq request and WAV
  = one Agnes request
  = one final scene clip
```

Each production narration is limited to 200 raw characters and 20 spoken words;
there is no per-scene spoken-word minimum. The measured WAV—not a word-count
estimate—is authoritative and must be at most 12 seconds. A longer result is
rejected and the script must be split into new, sequential visual beats. Exact
or renumbered duplicate beats are rejected, and the pipeline never concatenates
multiple TTS or Agnes generations for one scene.

Production scripts use 40-60 sequential scenes, at least 750 spoken words, and
at least 300 seconds of measured narration. Narration metadata sidecars bind
each canonical WAV to its exact script text, model, and voice so stale files
cannot be reused after a scene split or renumber. Assembly resolves that WAV
and the matching canonical Agnes MP4 by scene number, includes each pair exactly
once, and adds no inter-scene transition padding.

Every scene and key-art prompt ends with the same explicit character-integrity
negative bible: no duplicate characters, no extra limbs beyond the locked
species/body form, and no double, extra, fused, or conjoined heads/faces.
Series and episode titles are trimmed and limited to 100 characters/12 spoken
words; their Groq WAVs must also measure at most 12 seconds.

## Agnes lifecycle and video QA

The agent exposes three separate resumable generation tools followed by one QA
gate:

- `submit_agnes_scene_videos`: schedules both key arts and every scene across the configured account
  lanes, with at most two submission workers per account, and persists a
  pre-POST claim plus every accepted provider receipt.
- `verify_agnes_scene_videos`: resubmits only safe pending rows, or retrieves the
  exact accepted task using the account/key that created it.
- `download_agnes_scene_videos`: runs only when both key arts and every scene are
  provider-complete, then downloads and duration-normalizes the clips.
- `qa_agnes_episode_videos`: samples start/middle/end frames at 1024x576 per
  tile, normally reviews three target clips per 3072-pixel-wide sheet, and sends
  the sheet plus one high-resolution labeled portrait board to Gemini through
  AnyAPI. For a 50-scene episode plus both titles this is normally 18 calls;
  batching automatically grows to remain within `VIDEO_QA_MAX_VISION_CALLS`.

QA checks exact cast counts, duplicate people/creatures/object characters,
identity and age drift, anatomy, locked 2D painterly style, scene/action match,
neighboring-scene reuse, and title correctness. Each verdict is bound to the
normalized MP4 SHA-256, Gemini model, portrait-board digest, and QA policy.
Judgments below `VIDEO_QA_MIN_CONFIDENCE` remain pending for another analysis
and do not consume the one Agnes rerender. Sheets are capped at 8192 pixels in
height; incompatible call-limit/batch settings fail before a request rather
than silently reducing review quality.
Passed assets are skipped on later runs. A first failure archives the completed
receipt/video and atomically creates deterministic render revision 1 with a new
seed plus bounded category-specific correction text. A revision-1 failure is
marked `exhausted`; it cannot enter an automatic rerender loop. Assembly and
terminal completion both fail closed unless every current asset has passed.

Each configured Agnes account has independent durable submission and status
gates. Both default to two request starts per minute per account, and their
slots/cooldowns are stored in Turso so a process restart does not reset the
window. A durable slot is reserved before each provider request.
Queue-acknowledgement retrievals use the same per-account status gate. An
intermediate submission state is checked within a five-minute
queue-acknowledgement window. A definite queue-full or provider-busy rejection
remains pending for a later invocation. An ambiguous POST outcome—including a
network timeout after the request may have started—is held for a 10-minute stale
lease before a later-run recovery may submit again. Cross-account failover is
allowed only after a definite key-scoped rate-limit, daily-limit,
quota-exhausted, or insufficient-credit rejection. It is not used for queue
capacity, authentication/configuration/validation failures, network/timeout/5xx
errors, or malformed-success ambiguity. A provider `retryAfter` cools only the
rejected account. Accepted tasks remain bound to the exact account/key that
created them and are never resubmitted merely to move them between lanes.

Every series stores one deterministic Agnes root seed. `AGNES_SEED`, when
supplied, is only the preferred value while that series has no stored seed;
otherwise a random root is created. The first committed value wins. Each key
art and numbered scene receives its own deterministic seed derived from that
root, episode number, and asset identity. This preserves exact rerun behavior
without forcing adjacent, highly similar prompts toward the same composition.
Character continuity comes from the immutable source identity, refreshed
portrait signature, optional approved portrait references, supporting-entity
descriptors, continuity anchors, environment, camera, and lighting—not from
reusing one sampling seed for every shot.

Agnes Flash receives an integer duration from 4 through 12 seconds:

```text
providerSeconds = clamp(ceil(measuredNarrationSeconds), 4, 12)
```

The downloaded video must cover the narration duration (within one 30 fps
frame), then it is muted and trim-only normalized to the exact WAV duration.
Short provider clips are rejected rather than frozen-frame padded. See the official
[Agnes Video 2.5 Flash documentation](https://www.agnes-ai.com/en/docs/agnes-video-25-flash).

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Required services/credentials are documented in `.env.example`. The important
groups are:

- Neon and the deep-agent provider configuration.
- `PAUSE_BASE_URL` and `MACHINE_NO` for the guaranteed final VM-pause GET.
- Turso/libSQL for durable series, episode, Agnes, output, and upload state.
- `EPISODE_DAILY_TIMEZONE`, an IANA timezone for the per-series daily boundary
  (defaults to `Asia/Kolkata`).
- AnyAPI for main-character portrait generation and Gemini video contact-sheet QA;
  OpenRouter/framework vision remains limited to character-sheet extraction.
- Groq Orpheus for the single narrator voice.
- Up to five documented/tested independent Agnes lanes via `AGNES_API_KEY`
  (or `_1`) through `AGNES_API_KEY_5`, with matching optional stable
  `AGNES_ACCOUNT_ID` values. Higher numeric suffixes remain supported.
- YouTube OAuth credentials for terminal upload/finalization.

Turso tables and supported additive columns are created automatically before
the first agent call. They can also be initialized explicitly:

```bash
npm run db:setup
```

Run or resume the next episode with the same concept prompt:

```bash
npm run dev -- "Generate the next episode for the Tiny Heroes Club concept"
```

Agnes is asynchronous, so a normal episode spans multiple invocations. Reusing
the same concept resumes the active episode and its exact persisted receipts,
even on the same calendar day. Once YouTube finalization completes that episode,
a further run that day returns `Only 1 episode per day can be generated.` instead
of starting the next manifest entry.

## Agent lifecycle configuration

```dotenv
PAUSE_BASE_URL=https://your-controller.example
MACHINE_NO=your-machine-number
```

The fixed callback route is `/pause/vm` and its fixed query key is `machine`.
`MACHINE_NO` is also accepted as an uppercase compatibility alias.

## Agnes configuration

```dotenv
AGNES_API_KEY=
# AGNES_API_KEY_2=
# AGNES_API_KEY_3=
# AGNES_API_KEY_4=
# AGNES_API_KEY_5=
# AGNES_ACCOUNT_ID=account-1
# AGNES_ACCOUNT_ID_2=account-2
# AGNES_ACCOUNT_ID_3=account-3
# AGNES_ACCOUNT_ID_4=account-4
# AGNES_ACCOUNT_ID_5=account-5
AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_REQUEST_TIMEOUT_MS=60000
AGNES_POLL_INTERVAL_MS=30000
AGNES_QUEUE_POLL_INTERVAL_MS=30000
AGNES_QUEUE_POLL_WINDOW_MS=300000
AGNES_SUBMISSION_BATCH_SIZE=2
AGNES_SUBMISSION_RPM_PER_ACCOUNT=2
AGNES_STATUS_RPM_PER_ACCOUNT=2
AGNES_SUBMISSION_INTERVAL_MS=0
AGNES_MAX_DOWNLOAD_BYTES=500000000
AGNES_SEED=
# Optional, only when approved local portraits should be published for Agnes:
# AGNES_REFERENCE_UPLOAD_BASE_URL=https://uploads.example.com/agnes-references
# AGNES_REFERENCE_PUBLIC_BASE_URL=https://cdn.example.com/agnes-references
# AGNES_REFERENCE_UPLOAD_BEARER_TOKEN=
```

Video QA uses the same numbered `ANYAPI_KEY` pool but a separate analysis model:

```bash
ANYAPI_BASE_URL=https://api.anyapi.ai
ANYAPI_IMAGE_MODEL=google/gemini-3.1-flash-image
ANYAPI_VIDEO_QA_MODEL=google/gemini-3.1-pro-preview
VIDEO_QA_SCENES_PER_SHEET=3
VIDEO_QA_MAX_VISION_CALLS=20
VIDEO_QA_REQUEST_TIMEOUT_MS=120000
VIDEO_QA_ANYAPI_RPM_PER_KEY=9
VIDEO_QA_MIN_CONFIDENCE=0.8
VIDEO_QA_MAX_REGENERATIONS=1
```

The analysis request uses AnyAPI's OpenAI-compatible chat-completions endpoint,
multiple base64 `image_url` inputs, a strict JSON-only prompt, and local schema
validation. `ANYAPI_IMAGE_MODEL` controls portrait generation only, while
`ANYAPI_VIDEO_QA_MODEL` controls the contact-sheet judge only. The deprecated
`ANYAPI_MODEL` name remains a fallback only when `ANYAPI_IMAGE_MODEL` is absent.
`ANYAPI_BASE_URL` must be HTTPS and cannot contain credentials, query parameters,
or a fragment. Request starts rotate across the numbered key pool and default
to nine per minute per key, leaving headroom below the documented free limit.
See AnyAPI's [vision input guide](https://docs.anyapi.ai/api-reference/models/vision-models/overview),
[Gemini 3.1 Pro model page](https://anyapi.ai/ai-models/google-gemini-3-1-pro-preview),
and [parameter guide](https://docs.anyapi.ai/guides/parameters).

The unsuffixed key and account ID are lane 1 aliases for their `_1` forms.
Every numbered key must belong to a separately approved Agnes account; multiple
keys for one account must not be presented as independent rate-limit pools.
Account IDs are non-secret durable scheduler identities and default to
`account-1`, `account-2`, and so on. Keep an ID stable when its credential is
replaced, but retain the exact old credential until all tasks submitted with it
are terminal because status retrieval is fingerprint-bound. Conflicting
aliases, duplicate keys/IDs, malformed IDs, and IDs with no matching key are
rejected during configuration loading.

If every approved portrait path is already a public HTTPS URL, reference mode
needs no publisher configuration. Local portraits require both reference base
URLs above. The upload endpoint must accept HTTP `PUT`; the public endpoint must
serve the same object key anonymously over HTTPS until Agnes finishes. The
bearer token, when present, is sent only to the upload endpoint. If any visible
portrait cannot be resolved, that whole asset remains text-to-video rather than
mixing referenced and unreferenced main characters. Accepted/in-flight legacy
text jobs are never upgraded or resubmitted.

`AGNES_SUBMISSION_RPM_PER_ACCOUNT` and `AGNES_STATUS_RPM_PER_ACCOUNT` both
default to two. Legacy interval settings are additional minimum spacing, never
a way around those budgets: effective submission spacing is the larger of the
per-account RPM interval and `AGNES_SUBMISSION_INTERVAL_MS`; status retrieval
also honors the RPM interval, `AGNES_POLL_INTERVAL_MS`, and the production
30-second floor. Thus `AGNES_SUBMISSION_INTERVAL_MS=0` means “add no extra
delay,” not “submit without rate limiting.” Queue-acknowledgement cadence is
also controlled by `AGNES_QUEUE_POLL_INTERVAL_MS`, while every resulting GET
must still reserve a status slot.

`AGNES_SEED` is an optional initial preferred series seed. It is persisted only
when that series does not already have a seed; blank selects a random initial
value. Later runs always use the stored value, even if `AGNES_SEED` changes.

Every `npm run dev` or `npm start` invocation first performs the same full
framework-state cleanup as `npm run db:cleanup:neon`. After the invocation
settles—successfully, by early return, or with an error—it makes one bounded GET
to `${PAUSE_BASE_URL}/pause/vm?machine=${MACHINE_NO}`. A failed pause response
fails an otherwise successful invocation; if the agent already failed, its
original error remains the reported failure.

Run only one canonical agent invocation at a time for a given deployment
because startup cleanup is intentionally global to its Neon schema. Agnes
request slots and cooldowns are nevertheless durable in Turso and coordinate
overlapping processes by stable account ID.

## Output layout

```text
assets/
  series_<id>/characters/<Character_Name>/<request_digest>/
    portrait.png

output/series_<id>/episode_<number>/
  audio/
    scene_001_narrator.wav
    scene_001_narrator.metadata.json
  captions.srt
  agnes_text/
    key_art/
      series/
        series_key_art_narrator.wav
        series_key_art_narrator.metadata.json
        series_key_art.mp4
        prompts/
        raw/
      episode/
        episode_key_art_narrator.wav
        episode_key_art_narrator.metadata.json
        episode_key_art.mp4
        prompts/
        raw/
    prompts/
    raw/
    scenes/
      scene_001.mp4
  <Series>_episode_<number>_agnes_text.mp4
```

Existing legacy key-art images and scene-image files are left untouched on
disk. They are not read by the production flow.
