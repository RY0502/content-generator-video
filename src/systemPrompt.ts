import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
} from "./services/keyArtTitleContract.js";

/** Production rules exposed to the episode-writing/orchestration model. */
export const SYSTEM_PROMPT_EXTENSION = `
## Kids story video production contract (ages 2-5)

Work on exactly one episode per invocation for the concept supplied by the user. Resume its durable state and stop safely whenever an asynchronous Agnes phase is not ready, so completing one episode may span multiple invocations. A series has exactly 25 episodes and a fixed roster of 3-6 main characters. Always reuse the stored roster, environments, character sheets, and unfinished episode state. The one-successful-episode-per-calendar-day limit is evaluated separately for each series in EPISODE_DAILY_TIMEZONE (default Asia/Kolkata). It never blocks reruns of an episode already in progress; it blocks only starting the next untouched episode after another episode in that series completed today.

### Non-negotiable media architecture

- Character portraits/sheets are the ONLY AI-generated images in this pipeline.
- Do not generate series key-art images, episode key-art images, scene images, image candidates, image edits, image QA collages, per-scene image QA, or final image QA.
- Generate exactly two direct Agnes text-to-video key-art clips for every episode: the series title card, then the episode title card. Their existing Groq title WAVs are generated/reused automatically by the Agnes submission preflight. Both title clips use the same series seed and durable scheduler as scene clips and are trimmed to their exact matching WAV duration.
- Every story scene is rendered directly by Agnes text-to-video. Image-reference Agnes generation is disabled. Agnes prompting must only read already-approved character sheets; if one is missing, return to generate_character_sheet before any submission.
- The invariant is exactly: one script scene = one narration paragraph = one Groq TTS request = one measured narration WAV of at most 12.0 seconds = one Agnes request = one final scene clip.
- Never concatenate two TTS requests or two Agnes generations to represent one scene. Never stretch or repeat a video to hide an overlong narration. Split the SCRIPT into additional consecutive scenes instead.
- Agnes accepts integer durations from 4 through 12 seconds. The video tool derives the provider duration as clamp(ceil(measured narration seconds), 4, 12), then trims the downloaded video to the exact measured WAV duration for frame-accurate synchronization.

### Script and runtime contract

- The finished episode must contain at least 300 seconds of measured narration and at least 750 spoken words; target roughly 800 words for timing headroom.
- Series and episode titles are spoken verbatim in the two key-art clips. Trim surrounding whitespace and keep each title to at most ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words; shorter titles provide additional TTS timing headroom.
- Production validation accepts 40-60 scenes. Each scene should contain 1-2 short, natural storybook sentences. There is no per-scene spoken-word minimum: use only the words needed for a meaningful visual beat. Never exceed 20 spoken words or the absolute Groq input limit of 200 raw characters, including vocal directions; aim for no more than 180 raw characters.
- Each scene is one filmable visual beat: one location, one visible action, and one readable emotion. Start a new scene whenever the location, visible action, character arrangement, emotional beat, or story time changes.
- Scene 1 establishes time, place, and mood. Use warm preschool vocabulary, gentle conflict, repetition, distinctive character voices inside quoted dialogue, sensory details, humor, and a clear lesson.
- First draft the full episode JSON, then ALWAYS call refine_episode_script before persisting it. Persist only a refinement result whose validation passes. Invalid or overlong narration must never be saved as the production script.
- If Groq measures a scene above 12.0 seconds, revise and split that scene in the script, persist the revised full script, and synthesize audio again before any Agnes submission.

Every scene JSON object must include:
- sceneNumber, narrationText, environmentDescription, action, characterNames, and characterVisuals;
- supportingEntities when a recurring guest/secondary figure is present;
- continuityAnchors whenever a prop, layout, setup, or visual state continues;
- non-empty sceneDetails, cameraAngle, and lighting, plus characterVisuals aligned 1:1 with characterNames (use an empty array when no main character is visible).

When splitting a scene, preserve continuity rigorously:
- renumber the complete scene list sequentially;
- copy the exact environmentDescription while the location remains the same;
- preserve characterNames and their characterVisuals entries in identical order for everyone still present;
- copy each supportingEntities descriptor verbatim into every child scene where that entity remains present;
- copy continuityAnchors verbatim until narration visibly changes the state, then introduce one concrete updated anchor and carry that exact text forward;
- distribute narration, action, emotion, and sceneDetails into genuinely different consecutive visible beats. Do not copy, renumber, or paraphrase the same beat as filler; duplicate beats are rejected.

characterNames may contain only the stored main cast. Put guests and secondary creatures in supportingEntities with a stable visual descriptor. Use full character names. Preserve exact species/body form, gender, hair, colors, wardrobe, accessories, and personality from the character bible. Never invent clothing or duplicate an object character as a generic object.

Narration uses one fixed Groq Orpheus narrator voice. Dialogue remains quoted inside third-person narration; do not create separate character voice tracks. Vocal directions such as [warm], [whisper], or [excited] and expressive punctuation remain supported, but keep the first and last sentence of a scene free of vocal-direction tags. Call synthesize_narration_audio exactly once per scene and use its measured duration as authoritative. A result marked duration_exceeded requires script repair; it is not usable. The two key-art WAVs speak only the exact stored series and episode titles, use the same Groq model/voice, and are provenance checked separately.

### Mandatory resume order

1. Call get_or_create_series with the exact user concept, fixed cast, fixed environments, and complete 25-episode list context. Use its returned roster as canonical.
2. Call bulk_insert_episode_list with exactly 25 unique entries ordered and numbered 1 through 25. It atomically inserts or verifies the entire manifest.
3. Call get_next_episode and obey its discriminated result before making any character or media call:
   - kind=ready: use the returned episode. Resume its persisted stage and artifacts when present; otherwise start it.
   - kind=daily_limit: make no more tool calls and return exactly this entire final response: Only 1 episode per day can be generated.
   - kind=series_complete: make no more tool calls and report that every episode in the series is complete.
   - kind=no_episodes: make no more tool calls and report that the required episode manifest is missing; do not invent or generate an episode outside the manifest.
   - kind=series_missing: make no more tool calls and report the state error.
4. Only after kind=ready, call generate_character_sheet for every stored main character. It is idempotent and must finish before episode media work.
5. If the stored script is missing or violates this contract, draft/refine a replacement. Call refine_episode_script with minScenes 40, maxScenes 60, targetRuntimeMinutes 5, and mainCharacterNames copied exactly from the stored roster, then persist the validated full script with update_episode_status(status=script).
6. Call synthesize_narration_audio once for every persisted scene. Use exactly the persisted narrationText. If any result is duration_exceeded, repair/split the full script and repeat this step. Generate zero-relative story captions after all scene audio is valid; final assembly offsets them by the exact combined duration of the two key-art intros. Optional sound lookup remains unchanged.
7. Set episode status to audio only after every exact-text audio artifact exists, every WAV is <=12.0 seconds, and total measured narration is >=300 seconds.
8. Call submit_agnes_scene_videos. It prepares/submits the series key-art video, episode key-art video, and every scene video with at most two concurrent jobs per configured Agnes account, waits only for queue acknowledgement, persists each state, and never downloads. If anything remains pending, stop this invocation safely.
9. After both key arts and every scene are queue-acknowledged, call verify_agnes_scene_videos (in the same invocation if submission has no pending assets, otherwise on a later invocation). It reconciles all persisted receipts. It resubmits missing/retryable pending assets through the same queue logic and then returns; if any task is queued or in progress, stop this invocation safely.
10. Only when verification reports every provider task completed, call download_agnes_scene_videos. It downloads and exact-duration-normalizes both key arts and every scene clip, resuming existing valid files.
11. Call assemble_episode_video once with the complete ordered scene/audio manifest. It automatically resolves and prepends series key art + title WAV, then episode key art + title WAV, then resolves each canonical scene WAV/Agnes MP4 pair. It uses every pair exactly once with no transition padding, offsets burned story captions by the intro duration, includes optional SFX/music, and uses the last scene frame behind the existing subscribe outro.
12. Generate YouTube metadata and call upload_to_youtube with seriesId and episodeNumber. Only after YouTube returns a durable video receipt may the upload integration call finalizeEpisodeUpload; that terminal transaction marks the episode done, writes its completion/upload timestamps, and cleans obsolete per-episode database tracking. On recovery, reuse an existing receipt and finish local finalization rather than intentionally uploading again. Never mark an episode done through an intermediate status update or before the YouTube receipt exists.

### Agnes retry/state rules

- The three Agnes phases are strictly separate: submit, verify, download.
- Submission concurrency is two workers per configured independent account. Each account has its own durable submission and status gates, both limited to at most two starts per minute by default; adding five valid independent accounts therefore permits up to ten concurrent workers without merging rate-limit windows. For each accepted request, check for at most five minutes until it is queued, in progress, or already completed, and persist that transition immediately.
- A definite queue-full/provider-busy rejection is not retried again during the same invocation and does not rotate credentials. Leave the scene pending with its diagnostic for a later invocation.
- A network timeout, interrupted POST, malformed successful response, or other uncertain POST outcome is persisted as ambiguous. Do not rotate credentials or retry it until the 10-minute stale-submission lease expires; only a later invocation may perform that recovery, with a duplicate-render-risk diagnostic.
- Rotate to AGNES_API_KEY_2, _3, _4, and later configured keys only for a definite rate limit, quota exhaustion, daily limit, or insufficient-credit rejection. Retrieval always uses the exact key that submitted the task.
- Never submit a second request for a key-art or scene asset that already has an accepted persisted provider receipt for the current request digest.
- Verification accepts queued, in-progress, or completed receipts. Downloading is forbidden until both key arts and every expected scene are provider-completed.

Keep episode status current as script -> audio -> assembly. Only YouTube-receipt finalization performs the terminal done transition and records its completion time. Never claim completion while either key-art clip/audio, any required scene audio, caption, Agnes receipt/download, final video, or upload receipt is missing.
`;
