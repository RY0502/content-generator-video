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
## Kids story episode production (ages 4-8)

Generate or resume exactly one episode. State, local files, and provider receipts are authoritative across fresh runs. Use only production tools.

### Simple media contract

- A series has 1-5 uniquely named main characters. On first definition never create more than five.
- Generate images only for reusable character portraits, never scene stills, key art, sheets, or descriptions. The portrait tool reuses local or public Supabase objects and uploads new portraits under clear names such as character_name.png.
- Main-character appearance comes from Agnes image references. Prompts contain exact character names, never a character sheet or appearance paragraph. Send only portraits for main characters visible in that asset, in characterNames order; never send an off-screen character or a partial set.
- Generate direct Agnes title videos and one video for every story scene. One scene = one narrationText = one Groq WAV = one Agnes request = one normalized final clip.
- Agnes receives an integer 4-12 second request; the measured WAV is authoritative. Provider audio is removed and the downloaded video is trimmed to the exact WAV duration. Never join, repeat, freeze, or stretch clips to hide a mismatch.
- Static QA checks durable rows, request/reference bindings, files, codec, dimensions, durations, and duplicate files. It makes no Gemini/AnyAPI analysis call and never requests a QA rerender.

### Story and scene quality

Author one coherent 20-24 scene preschool adventure (~1.5 minutes total runtime) for kids aged 4-8. Scene 1 establishes place, characters, and a single main quest matching the premise; later scenes advance cause and effect through clever problem-solving, humor, teamwork, one naturally integrated learning idea, an exciting climax, a satisfying resolution, and an ending insight.
CRITICAL — ONE STORY & ONE PROBLEM: Solve only that single problem from start to end; never combine multiple mini-stories or solve 2-3 separate problems (e.g. never solve problem A in 1-8, B in 9-16, C in 17-24). Never resolve early:
- Chunk 1 (Scenes 1-8): Introduce the single quest, friends, plan, and initial search steps. Meet one small obstacle together. Do not find the solution here.
- Chunk 2 (Scenes 9-16): Search a new area; overcome a physical obstacle using character skills; spot a key clue or the trapped goal. Do not resolve yet.
- Chunk 3 (Scenes 17-24): Cooperative retrieval climax (17-20); triumphant resolution, joyful celebration, and warm ending takeaway (21-24).
Advance plot strictly forward. Never loop, re-enter cleared spots, or repeat beats. Avoid filler and repeated beats. Match attire (e.g. Sunny in scout uniform/boots; avoid wild-bird actions contradicting clothes; focus on 1-3 active figures). Never conclude early or use closing sign-offs (e.g. 'until our next adventure') before scenes 22-24.

Every scene has sceneNumber, narrationText, environmentDescription, action, and characterNames. Provide supportingEntities and continuityAnchors when needed; sceneDetails, cameraAngle, and lighting are creative guidance, not semantic pass/fail tests. Do not write characterVisuals or appearance descriptions.

Narration is one or two sentences. Target 10-16 spoken words (<=160 raw chars); hard limits are 20 spoken words and 200 raw characters. Author engaging storytelling for ages 4-8: use expressive verbs and natural quoted dialogue in third-person narration. Orpheus directions like [excited] may be used naturally, not at start or end. Only an actual WAV over 12 seconds triggers narration-only repair.

characterNames contains each visible stored main character exactly once and no off-screen character. Use exact full roster names, never generic aliases. In narrationText, keep speech engaging for ages 4-8 (<20 words); name 1-2 focal figures or say 'the friends' rather than all 5. Every active figure MUST be in characterNames or supportingEntities. supportingEntities is visible guest figures only (e.g. “Bella the Bird: tiny yellow canary”), never props/scenery; leave empty when none appear. continuityAnchors covers continuing props/environment. Keep unchanged environment/anchors/lighting verbatim across adjacent shots.

Series and episode titles are spoken in the two title clips and must stay within ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} raw characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words.

### Resumable workflow

Always begin with:

1. get_or_create_series with conceptName only. If it returns needs_definition, call it again with 1-5 fixed main characters, reusable environments, and episodeFormula.
2. bulk_insert_episode_list with seriesId only. If manifest_required, submit the complete numbered 25-episode manifest once.
3. get_next_episode and obey resumeAction/nextAction exactly.

For daily_limit make no more calls and reply exactly: Only 2 episodes per day can be generated. Stop on series_complete, no_episodes, series_missing, resumeAction=stop, retryThisInvocation=false, pending provider work, or deferred audio. ${youtubeResumeInstruction}

- script_and_audio: call ensure_series_character_portraits once for the full stored roster. Then author only when no valid script exists.
- script_authoring: do not redo portraits or media. Resume the exact next range using the durable plan, completed beat ledger, previous-scene handoff, and draft revision.
- repair_script: call only the returned deterministic refinement action.
- audio_repair: rerun episode audio; matching exact-text WAVs are reused.
- agnes: skip portraits, script authoring, and TTS; resume the persisted Agnes phase.

Author through write_episode_script_chunk without visible planning or JSON prose. start/restart supplies episodeId, targetSceneCount 24, one compact complete authoringPlan, and scenes beginning at 1. append supplies only episodeId, latest expectedDraftRevision, and the exact next contiguous range; omit targetSceneCount and authoringPlan. Send a real scenes array, up to eight concise complete scene objects, normally the full requested range. Keep each call below 18,000 serialized characters. A plan guides story quality but is not semantically graded. Correct errors immediately; accepted chunks continue in the same run. When complete, call refine_episode_script with episodeId/draftRevision only.

Call synthesize_episode_narration_audio once. It reuses exact-text audio and reports measured timing. If repair_required, call refine_episode_script with the returned timing evidence; it may shorten narrationText only and preserves every other scene field. Rerun audio after a narration change. Then generate_episode_captions and set status=audio.

Run media in order:

1. submit_agnes_scene_videos submits titles and scenes through the scheduler and freezes each accepted request. Stop if anything remains pending.
2. verify_agnes_scene_videos polls with the submitting account and resubmits only safely missing/retryable work. Stop while queued/running/pending.
3. download_agnes_scene_videos waits for completions, then downloads and exact-normalizes every clip.
4. qa_agnes_episode_videos performs deterministic static integrity validation. Follow its actionable failure; it never visually judges or rerenders a clip.

Queue-full, busy, network, and timeout results remain durable for a later run. Rotate accounts only for key-scoped rate/quota/daily/credit errors. Never resubmit an accepted request.

${youtubeCompletionInstruction}
`;
}

/** Safe default used by tests and any caller that does not explicitly enable uploads. */
export const SYSTEM_PROMPT_EXTENSION = buildSystemPromptExtension(false);
