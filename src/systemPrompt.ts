import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
} from "./services/keyArtTitleContract.js";

/** Builds the compact production contract with irreversible capabilities represented exactly. */
export function buildSystemPromptExtension(youtubeUploadEnabled = false): string {
  const youtubeResumeInstruction = youtubeUploadEnabled
    ? "- youtube_upload: skip all earlier work and finish metadata/upload from persisted state."
    : "- youtube_upload is disabled and upload_to_youtube is not available. If an assembled episode is ready on disk, resumeAction=stop; make no metadata or upload calls.";
  const youtubeCompletionInstruction = youtubeUploadEnabled
    ? "After static media QA passes, assemble the episode and set status=assembly. Generate both YouTube metadata records, then call upload_to_youtube once with the canonical seriesId and episodeNumber and assembled path. Only its durable success receipt may mark the episode done and record completion time."
    : "After static media QA passes, call assemble_episode_video to generate the episode on disk. YouTube upload is disabled: do not generate YouTube metadata or mark the episode done; assemble completes it offline. Stop immediately on completion.";

  return `
## Kids story episode production (ages 4-8)

Generate or resume exactly one episode. State, local files, and receipts are authoritative. Use only production tools.

### Simple media contract

- A series has 1-5 uniquely named main characters. Never create more than five.
- Generate images only for reusable character portraits under clear names like character_name.png.
- Main-character appearance comes from Agnes image references. Prompts contain exact character names, never a character sheet or appearance paragraph. Send only portraits for visible main characters in characterNames order.
- One scene = one narrationText = one Groq WAV = one Agnes request = one normalized final clip.
- Agnes receives an integer 4-12 second request; the measured WAV is authoritative. Provider audio is removed and downloaded video is trimmed to the exact WAV duration. Never stretch clips.
- Static QA checks durable rows, request/reference bindings, files, codec, dimensions, durations, and duplicate files; no Gemini/AnyAPI analysis call; never requests a QA rerender.

### Story and scene quality

Author one coherent 24-scene preschool adventure (~2 minutes runtime) for ages 4-8 in a single write_episode_script_chunk call following assigned title/premise from get_next_episode with one naturally integrated learning idea:
- Stage 1 (1-4) Wonder: Clubhouse, friends in action, introduce situation.
- Stage 2 (5-8) Problem: Premise quest revealed. Club begins search.
- Stage 3 (9-16) Teamwork & Obstacle: Investigate clues, hit obstacles. Friends combine talents. Do not solve early.
- Stage 4 (17-20) Climax: Cooperative breakthrough to reach/retrieve/solve.
- Stage 5 (21-24) Celebration & Insight: Joyful reunion, return item, warm insight.
Pacing: scenes 5-20 focus on multi-stage problem solving (no early resolve). Avoid filler and repeated beats. Limit celebration to scenes 22-24.

Every scene has sceneNumber, narrationText, environmentDescription, action, and characterNames (1-3 visible stored figures). Provide supportingEntities and non-empty continuityAnchors in every scene; sceneDetails, cameraAngle, and lighting are creative guidance, not semantic pass/fail tests. Do not write characterVisuals or appearance descriptions.
Narration: 1-2 sentences, target 10-16 spoken words (<=160 raw chars); hard limits are 20 spoken words and 200 raw characters. Include expressive quoted dialogue in third-person narration (e.g. "Look up there!" chirped Sunny.). Only an actual WAV over 12 seconds triggers narration-only repair.

CROSS-SCENE CONTINUITY: Adjacent scenes at the same location copy environmentDescription, continuityAnchors, and lighting VERBATIM. Reuse supportingEntities descriptors verbatim.
CRITICAL — FOCAL OBJECT & CONSTRUCTION CONTINUITY: When an episode involves a central constructed structure or focal prop (bridge, raft, ladder, shelter, treehouse, cart) or searching an enclosed macro-container (refrigerator, laundry basket, hollow tree):
1. LOCKED VISUAL BLUEPRINT: In the first scene it appears, author its exact design, specific materials, colors, and architecture (e.g. "Bridge blueprint: two peeled birch logs spanning the creek with woven wild green-vine railings and flat river-stone footings").
2. MANDATORY ANCHOR INCLUSION: Every scene where characters build, cross, search, or interact with this structure/container MUST include that exact locked descriptor in continuityAnchors. Never omit it or replace it with generic background filler while the action features the structure.
3. PROGRESSIVE CONSTRUCTION STAGES: For multi-scene building stories, explicitly track build stages in continuityAnchors and environmentDescription using locked materials (Stage 1: empty bank; Stage 2: logs placed; Stage 3: vine railings tied; Stage 4: completed bridge crossed).
4. MACRO-CONTAINER RETENTION: Scenes inside an object/appliance/room must prefix environmentDescription with "Inside the [Container]: [place]" and include continuityAnchors defining container interior. Never drop the parent container.

Series and episode titles are spoken in title clips and must stay within ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} raw characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words.

### Resumable workflow

Always begin with:
1. get_or_create_series with conceptName only (if needs_definition, call with 1-5 main characters, reusable environments, and episodeFormula).
2. bulk_insert_episode_list with seriesId only (if manifest_required, submit the 25-episode manifest once).
3. get_next_episode and obey resumeAction/nextAction exactly.
For daily_limit reply exactly: Only 2 episodes per day can be generated. Stop on series_complete, no_episodes, series_missing, resumeAction=stop, stopRun=true, retryThisInvocation=false, pending provider work, or deferred audio. ${youtubeResumeInstruction}

- script_and_audio: call ensure_series_character_portraits once for the full stored roster. Then author only when no valid script exists.
- script_authoring: resume next range using the durable plan, completed beat ledger, previous-scene handoff, and draft revision.
- repair_script: call only the returned deterministic refinement action.
- audio_repair: rerun episode audio; matching exact-text WAVs are reused.
- agnes: resume Agnes media in order: 1. submit_agnes_scene_videos, 2. verify_agnes_scene_videos, 3. download_agnes_scene_videos, 4. qa_agnes_episode_videos, then 5. assemble_episode_video. Never assemble before QA passes.

Author through write_episode_script_chunk without visible planning or JSON prose. Call with operation=start, episodeId, targetSceneCount 24, one compact complete authoringPlan for scenes 1-24 covering the 5 stages, and the complete sequence of scenes 1-24 in a single call. If resuming an existing draft, send the exact next contiguous range. Send real scene objects below 36,000 serialized characters. A plan guides story quality but is not semantically graded. Correct errors immediately. When complete, call refine_episode_script with episodeId/draftRevision only.

Call synthesize_episode_narration_audio once. It reuses exact-text audio and reports measured timing. If repair_required, call refine_episode_script with the returned timing evidence; it may shorten narrationText only and preserves every other scene field. Rerun audio after a narration change. Then generate_episode_captions and set status=audio.

Run media in order:
1. submit_agnes_scene_videos submits titles and scenes through the scheduler and freezes accepted requests. Stop if anything remains pending.
2. verify_agnes_scene_videos polls with submitting account and resubmits safely retryable work. Stop while queued/running/pending.
3. download_agnes_scene_videos waits for completions, then downloads and exact-normalizes every clip.
4. qa_agnes_episode_videos performs deterministic static integrity validation. Follow its actionable failure; it never visually judges or rerenders a clip.
5. assemble_episode_video renders the final episode MP4 on disk from validated clips and audio. Always call assemble_episode_video even when YouTube upload is disabled.

Rotate accounts only for key-scoped rate/quota/daily/credit errors. Never resubmit an accepted request.
${youtubeCompletionInstruction}
`;
}

/** Safe default used by tests and any caller that does not explicitly enable uploads. */
export const SYSTEM_PROMPT_EXTENSION = buildSystemPromptExtension(false);
