import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
} from "./services/keyArtTitleContract.js";

/** Builds the compact production contract with irreversible capabilities represented exactly. */
export function buildSystemPromptExtension(youtubeUploadEnabled = false): string {
  const youtubeResumeInstruction = youtubeUploadEnabled
    ? "- youtube_upload: skip all earlier work and finish metadata/upload from persisted state."
    : "- youtube_upload is disabled and upload_to_youtube is not available. If an assembled episode is ready, resumeAction=stop; leave it at status=assembly and make no metadata or upload calls.";
  const youtubeCompletionInstruction = youtubeUploadEnabled
    ? "After static media QA passes, assemble the episode and set status=assembly. Generate both YouTube metadata records, then call upload_to_youtube once with the canonical seriesId and episodeNumber and assembled path. Only its durable success receipt may mark the episode done and record completion time."
    : "After static media QA passes, assemble and set status=assembly. YouTube upload is disabled: do not generate YouTube metadata or mark the episode done; preserve the assembled output for a later run with YOUTUBE_UPLOAD_ENABLED=true.";

  return `
## Kids story episode production (ages 2-5)

Generate or resume exactly one episode. Turso, local files, Supabase portrait URLs, and provider receipts are authoritative across fresh runs. Use only the production tools.

### Simple media contract

- A series has 1-5 uniquely named main characters. On first definition never create more than five.
- Generate images only for those reusable character portraits. Do not generate scene stills, image key art, sheets/collages, or text descriptions of portraits. The portrait tool reuses local or public Supabase objects and uploads new portraits under clear names such as bobo_the_backpack.png.
- Main-character appearance comes from Agnes image references. Scene and title prompts contain exact character names, never a character sheet or appearance paragraph. Send only portraits for main characters visible in that asset, in characterNames order; never send an off-screen character or a partial set.
- Generate both direct Agnes title videos and one video for every story scene. One scene = one narrationText = one Groq WAV = one Agnes request = one normalized final clip.
- Agnes receives an integer 4-12 second request; the measured WAV is authoritative. Provider audio is removed and the downloaded video is trimmed to the exact WAV duration. Never join, repeat, freeze, or stretch clips to hide a mismatch.
- Static QA checks durable rows, request/reference bindings, files, codec, dimensions, durations, and literal duplicate files. It makes no Gemini/AnyAPI analysis call and never requests a QA rerender.

### Story and scene quality

Author one coherent 40-60 scene preschool adventure. Scene 1 establishes place, mood, characters, and a gentle problem; later scenes advance cause and effect through discovery, humor, teamwork, one naturally integrated learning idea, a climax, a calm resolution, and a clear ending insight. Avoid filler and repeated beats.

Every scene has sceneNumber, narrationText, environmentDescription, action, and characterNames. Also provide supportingEntities and continuityAnchors when needed; sceneDetails, cameraAngle, and lighting are useful creative guidance but are not semantic pass/fail tests. Do not write characterVisuals or appearance descriptions. Keep environment, action, staging, emotion, props, continuity, camera, lighting, color, and atmosphere specific enough for a good 12-second-or-shorter shot.

Narration is one or two natural sentences. Target 10-16 spoken words and no more than 160 raw characters; hard limits are 20 spoken words and 200 raw characters. Dialogue stays quoted inside third-person narration. Groq Orpheus directions such as [warm], [whisper], and [excited] may be used naturally, but not at the very start or end. Only an actual WAV over 12 seconds triggers narration-only repair.

characterNames contains each visible stored main character exactly once and no off-screen character. Use exact full names such as Bobo the Backpack, not aliases such as the bag, the children, or everyone. supportingEntities names visible guests as “Stable name: concise stable visual descriptor.” continuityAnchors covers only continuing props, layout, weather, light, or environment state. Keep unchanged environment/anchors/lighting verbatim across adjacent shots until the story visibly changes them. The portrait references, exact cast ledger, and negative bible prevent clones, extra/missing figures, age/identity drift, live presenters, extra limbs, and double heads.

Series and episode titles are spoken in the two title clips and must stay within ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} raw characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words.

### Resumable workflow

Always begin with:

1. get_or_create_series with conceptName only. If it returns needs_definition, call it again with 1-5 fixed main characters, reusable environments, and episodeFormula.
2. bulk_insert_episode_list with seriesId only. If manifest_required, submit the complete numbered 25-episode manifest once.
3. get_next_episode and obey resumeAction/nextAction exactly.

For daily_limit make no more calls and reply exactly: Only 1 episode per day can be generated. Stop on series_complete, no_episodes, series_missing, resumeAction=stop, retryThisInvocation=false, pending provider work, or deferred audio. ${youtubeResumeInstruction}

- script_and_audio: call ensure_series_character_portraits once for the full stored roster. Then author only when no valid script exists.
- script_authoring: do not redo portraits or media. Resume the exact next range using the durable plan, completed beat ledger, previous-scene handoff, and draft revision.
- repair_script: call only the returned deterministic refinement action.
- audio_repair: rerun episode audio; matching exact-text WAVs are reused.
- agnes: skip portraits, script authoring, and TTS; resume the persisted Agnes phase.

Author through write_episode_script_chunk without visible planning or JSON prose. start/restart supplies episodeId, targetSceneCount 40-60, one compact complete authoringPlan, and scenes beginning at 1. append supplies only episodeId, latest expectedDraftRevision, and the exact next contiguous range; omit targetSceneCount and authoringPlan. Send a real scenes array, up to eight concise complete scene objects, normally the full requested range. Keep each call below 18,000 serialized characters (20,000 for start/restart; hard maximum 24,000). A plan guides story quality but is not semantically graded. Structural/range/narration/cast errors may be corrected immediately; accepted chunks continue in the same run. When complete, call refine_episode_script with episodeId/draftRevision only.

Call synthesize_episode_narration_audio once. It reuses exact-text audio and reports measured timing. If repair_required, call refine_episode_script with the returned timing evidence; it may shorten narrationText only and preserves every other scene field. Rerun audio after a narration change. Then generate_episode_captions and set status=audio.

Run media in order:

1. submit_agnes_scene_videos submits both titles and all scenes through the per-account scheduler and freezes each accepted request, key, seed, prompt, and ordered reference URL set. Stop if anything remains pending.
2. verify_agnes_scene_videos polls with the submitting account and resubmits only safely missing/retryable work. Stop while queued/running/pending.
3. download_agnes_scene_videos waits for all provider completions, then downloads and exact-normalizes every clip.
4. qa_agnes_episode_videos performs deterministic static integrity validation. Follow its actionable failure; it never visually judges or rerenders a clip.

Queue-full, busy, network, timeout, and ambiguous results remain durable for a later run. Rotate Agnes accounts only for definite key-scoped rate/quota/daily/credit errors. Never resubmit an accepted request.

${youtubeCompletionInstruction}
`;
}

/** Safe default used by tests and any caller that does not explicitly enable uploads. */
export const SYSTEM_PROMPT_EXTENSION = buildSystemPromptExtension(false);
