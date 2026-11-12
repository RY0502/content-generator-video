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
## Animated story episode production

Generate or resume exactly one episode. State, local files, and receipts are authoritative. Use only production tools.

### Simple media contract

- A series has 1-5 uniquely named main characters. Never create more than five.
- Generate images only for reusable character portraits under clear names like character_name.png.
- Main-character appearance comes from Agnes image references. Prompts contain exact character names, never a character sheet or appearance paragraph. Send only portraits for visible main characters in characterNames order.
- Cast presence: "The friends" includes ALL main characters (<=5). In 2-figure dialogue (Sunny says to Pip), characterNames lists ONLY those 2 so Agnes gets only their 2 reference images; other elements are text-locked.
- Locked negative bibles remain active across all generations to prevent defects.
- One scene = one narrationText = one Groq WAV = one Agnes request = one normalized final clip.
- Agnes receives an integer 4-12 second request; the measured WAV is authoritative. Provider audio is removed and downloaded video is trimmed to the exact WAV duration. Never stretch clips.
- Static QA checks durable rows, request/reference bindings, files, codec, dimensions, durations, and duplicate files; no Gemini/AnyAPI analysis call; never requests a QA rerender.

### Story and scene quality

Author one coherent 20-24 scene adventure (3-4 minutes runtime, 180-240s total) in a single write_episode_script_chunk call following assigned title/premise from get_next_episode with one naturally integrated learning idea using Story-First:
1. FULL NARRATIVE: In authoringPlan.narrativeScript, write a complete 500-900 word continuous progressive prose story before splitting scenes. Avoid filler and repeated beats; ensure a single, unique, forward-moving story with zero filler or dialogue loops.
2. LOCKED SETTINGS: Register 3-5 distinct backgrounds with detailed elements in authoringPlan.settingRegistry. Reuse settingId and environmentDescription verbatim until location changes.
3. SUPPORTING BIBLE & PHYSICAL SPEC: Identify all recurring guest figures AND all focal quest props/items (e.g. missing sock, broken kite, lost ribbon, secret map, basket, key, compass, baby bird, tiny mouse). Lock 3-4 key supporting entities in authoringPlan.supportingEntityBible; reuse text descriptors verbatim in supportingEntities across scenes. Partition figures from props:
- Living characters/creatures: specify concrete materials, colors, species, and exact eye design ("two identical round black bead eyes"). BANNED: "mismatched eyes", "button body", "odd buttons", or ambiguous traits. ANTI-FEATURE BLEEDING: never borrow clothing colors, accessories, or motifs from main characters.
- Inanimate props/structures: define complete physical blueprint (materials/fabrics, colors, patterns, textures, shape, size; e.g. "navy blue knitted sock: soft navy-blue wool knitted sock with ribbed cuff, two white horizontal toe stripes, and a rounded toe pouch"); strictly identical across all scenes. Inanimate structures/props never have creature anatomy.
4. 12-SECOND SCENE DECOMPOSITION: Split freely into scenes meeting the 12s target (10-16 spoken words narration, <=170 chars), omitting or retrofitting minor transitions if needed. Ensure the split faithfully segments the single narrative story without repeating actions.
- Stage 1 (1-4) Wonder: Clubhouse, friends in action, introduce situation.
- Stage 2 (5-8) Problem: Premise quest revealed. Club begins search.
- Stage 3 (9-16) Teamwork & Obstacle: Investigate clues, hit obstacles. Friends combine talents. Do not solve early.
- Stage 4 (17-20) Climax: Cooperative breakthrough to reach/retrieve/solve.
- Stage 5 (21-24) Celebration & Insight: Joyful reunion, return item, warm insight.
Pacing: scenes 5-20 focus on multi-stage problem solving (no early resolve). Limit celebration to scenes 22-24.

Every scene has sceneNumber, narrationText, environmentDescription, action, and characterNames (1-3 visible stored figures). Provide supportingEntities and non-empty continuityAnchors in every scene; sceneDetails, cameraAngle, and lighting are creative guidance, not semantic pass/fail tests. Do not write characterVisuals or appearance descriptions.
Narration: 1-2 sentences, target 10-16 spoken words (<=160 raw chars); hard limits are 20 spoken words and 200 raw characters. Include expressive quoted dialogue in third-person narration (e.g. "Look up there!" chirped Sunny.). Only an actual WAV over 12 seconds triggers narration-only repair.

CROSS-SCENE CONTINUITY: Adjacent scenes at the same location copy environmentDescription, continuityAnchors, and lighting VERBATIM. Reuse supportingEntities descriptors verbatim.
CRITICAL — FOCAL OBJECT, QUEST ITEM & RECURRING PROP CONTINUITY: When an episode features a central quest object, recurring prop, tool, or vehicle (sock, kite, ribbon, map, basket, compass, key, clock) OR a constructed structure/container (bridge, raft, ladder, shelter, treehouse, cart, refrigerator, laundry basket):
1. LOCKED VISUAL BLUEPRINT: In authoringPlan.supportingEntityBible (and the first scene it appears), define its exact physical design, specific materials, colors, patterns, and construction (e.g. 'navy blue knitted sock: soft navy-blue wool knitted sock with ribbed cuff, two white horizontal toe stripes, and a rounded toe pouch' or 'Bridge blueprint: two peeled birch logs spanning the creek with woven wild green-vine railings and flat river-stone footings').
2. MANDATORY DECLARATION WHERE PRESENT: Every scene where characters search for (once found), retrieve, carry, examine, hold, use, watch over, or interact with this item MUST include it:
- If carried, held, moved, or interacted with as an object: include in supportingEntities using its exact locked descriptor.
- If a stationary fixture, macro-structure, or container: include in continuityAnchors using its exact locked descriptor.
Never omit it from the scene manifest while the action or narration features it!
3. PROGRESSIVE CONSTRUCTION STAGES: For multi-scene building stories, explicitly track build stages in continuityAnchors and environmentDescription using locked materials (Stage 1: empty bank; Stage 2: logs placed; Stage 3: vine railings tied; Stage 4: completed bridge crossed).
4. MACRO-CONTAINER RETENTION: Scenes inside an object/appliance/room must prefix environmentDescription with "Inside the [Container]: [place]" and include continuityAnchors defining container interior. Never drop the parent container.

CRITICAL — VISUAL CO-PRESENCE LOCK (AUDIO & ACTION SYNCHRONIZATION): Every entity spoken about in narrationText or acted upon in action MUST be declared in that scene's manifest so Agnes renders it:
1. Supporting characters & creatures (e.g. mouse, snail, bird, guest): If narration or action mentions or depicts interacting with them (e.g. 'the mouse rested in the sock', 'Zoom checked security for the mouse', 'Lulu guided the tiny mouse'), that figure MUST be listed in supportingEntities with its locked descriptor. Never omit a supporting character from supportingEntities while narration or action describes them!
2. Focal props & quest items: If narration or action mentions or depicts carrying, holding, examining, watching, or interacting with them (e.g. 'moved the sock', 'peered into the sock', 'watched over the sock'), that prop MUST be listed in supportingEntities (or continuityAnchors).
3. What the audience hears in narration and what characters do in action MUST match what is visible on screen. If narration describes characters looking at, helping, carrying, tucking in, or watching over an entity, that entity MUST be in supportingEntities or continuityAnchors!
4. Do NOT list guest entities in supportingEntities in scenes where they are not physically present (e.g. do not include a guest clock toy or sleeping mouse before they are discovered or when they are absent).

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

Author through write_episode_script_chunk without visible planning or JSON prose. Call with operation=start, episodeId, targetSceneCount 20-24 (default 24), one compact complete authoringPlan for scenes 1-24 covering the 5 stages, and the complete sequence of scenes 1-24 in a single call. If resuming an existing draft, send the exact next contiguous range. Send real scene objects below 36,000 serialized characters. A plan guides story quality but is not semantically graded. Correct errors immediately. When complete, call refine_episode_script with episodeId/draftRevision only.

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
