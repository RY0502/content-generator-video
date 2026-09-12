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
    ? "After video QA passes, call assemble_episode_video with persisted-state inputs and set status=assembly. Generate both YouTube metadata records, then call upload_to_youtube once with the canonical seriesId and episodeNumber from get_next_episode, assembled path, and metadata. Both IDs are mandatory. Only a durable successful YouTube receipt may finalize the episode as done, record upload/completion time, and clean obsolete tracking. Never mark done earlier."
    : "After QA passes, assemble and set status=assembly. YouTube upload is disabled: do not generate YouTube metadata, call upload_to_youtube, or clean tracking; do not mark the episode done. Preserve the path for YOUTUBE_UPLOAD_ENABLED=true.";

  return `
## Kids story episode production (ages 2-5)

Generate or resume one episode. Turso, existing files, and domain tools are authoritative across fresh invocations. Use only visible domain tools.

### Media and script contract

- Generate images only for reusable main-character portraits/sheets—never key art, scenes, candidates, or image/final QA.
- Generate two direct Agnes introductions, then every story scene. For each unclaimed asset, the media tool uses all visible main-character portraits when all resolve to public HTTPS; otherwise it uses complete text identities. Never use a partial reference set.
- QA both title clips and all scenes against portraits/script before assembly. One failed asset may rerender once; a second failure stops for manual review.
- One script scene equals one narration paragraph, one Groq WAV, one Agnes request, and one final clip. Never join two TTS calls or two generations for one scene, and never repeat, freeze, or stretch video to conceal a timing mismatch.
- Agnes accepts integer durations of 4-12 seconds. The video tool requests clamp(ceil(measured WAV seconds), 4, 12), removes provider audio, and trims the download to the exact WAV duration. The WAV duration is authoritative.
- Use the stored series seed only as the stable root. The media tool deterministically derives a distinct seed for each episode asset and reuses that derived seed on reruns; approved portrait references, locked source identities, and the script's visual/continuity fields provide identity consistency.
- characterNames plus supportingEntities is the authoritative exact on-screen cast for each scene. Include every actually visible individual exactly once, whether the scene needs one figure or the full ensemble; impose no arbitrary figure-count ceiling and add no unlisted background figure.

Write a complete preschool adventure of 40-60 distinct scenes, at least 750 spoken words, and at least 300 measured narration seconds; target about 800 words. Each scene is one filmable location/action/emotion beat. Use 1-2 short natural sentences, no more than 20 spoken words and no more than 200 raw characters including vocal directions; aim below 180 characters so Groq normally stays within 12 seconds. Split the story into more genuine consecutive beats during authoring rather than overloading narration.

Series and episode titles are spoken in the two introduction clips. Each title must be at most ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} raw characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words.

Every scene object must include:
- sceneNumber, narrationText, environmentDescription, action, characterNames, characterVisuals;
- supportingEntities for visible guests or recurring secondary figures;
- continuityAnchors for continuing props, layouts, setups, or changed visual state;
- non-empty sceneDetails, cameraAngle, and lighting.

Quality is mandatory. Scene 1 must establish time, place, mood, and the gentle problem. Each action needs a readable start, one visible movement/change, and a clear end in one shot, with one primary mover; other figures stay separated and react subtly. cameraAngle names one move or fixed camera. Use warm vocabulary, light preschool repetition, distinctive character voices and reactions, quoted dialogue, sensory detail, humor, discovery, teamwork, one naturally integrated educational idea, and a clear ending insight. No filler or duplicate beats.

characterNames contains only stored main-cast members actually visible—not the roster by default. Align characterVisuals 1:1 and preserve visualForm/body form, age, gender, hair, colors, wardrobe, accessories, proportions, and personality. Put each visible guest/creature in supportingEntities as “Stable name: locked visual descriptor”; one entry is one individual, never a pair/family/herd/flock/crowd/group/cluster. Count every visible figure in these arrays. environmentDescription is figure-free.

In action/sceneDetails use exact stable names, never aliases such as “the children/friends,” “everyone,” “the boys,” “the backpack/bag,” or “the baby dinosaur.” For Bobo or another object character, use only its name and never imply both a carried/worn and freestanding instance.

Across consecutive scenes, keep environmentDescription verbatim while location is unchanged and visible character names/visuals in order. Carry supportingEntities only while on screen. continuityAnchors are optional and only for visible non-living props/layout/environment state—never figures, poses, or actions. Reuse them verbatim while visible, then drop/replace. Preserve cameraAngle/lighting unless deliberately changed. Every narration/action/emotion/sceneDetails is a new beat.

Narration uses the fixed Groq Orpheus narrator. Dialogue stays quoted inside third-person narration. Supported vocal directions such as [warm], [whisper], and [excited] may be used for emphasis, but do not put a direction at the beginning of the first sentence or the end of the last sentence.

### Compact workflow

Production override: no write_todos or generic tools; use only this state machine.

Always begin with these three state calls; do not draft the episode before their responses:

1. Call get_or_create_series with the exact concept title only. Existing series immediately return their authoritative roster. Only if it returns needs_definition, call it once more with the fixed main cast, reusable environments, and series formula.
2. Call bulk_insert_episode_list with seriesId only. Existing seasons are verified without retransmission. Only if it returns manifest_required, create and submit exactly 25 varied episodes numbered 1-25.
3. get_next_episode, then obey its result and resumeAction.

For daily_limit, make no more calls and reply exactly: Only 1 episode per day can be generated. Stop on series_complete, no_episodes, series_missing, resumeAction=stop, retryThisInvocation=false, pending external work, or deferred/blocked audio. Always follow nextAction.

Use resumeAction as the state-machine entry point:

- script_and_audio: call ensure_series_character_sheets once; it generates/reuses the stored roster, so never loop over members. If scriptValidation.status=not_started, follow the tool-only authoring protocol below; if status=ready, reuse that persisted script and do not draft or replace it. Then run episode audio.
- script_authoring: skip portraits and all media. Resume only the exact next scene range from scriptDraft.authoringProgress using its immutable authoringPlan, activePlanBeat, completedBeatLedger (the do-not-repeat memory for every accepted scene), previousScenes (the exact visual handoff), word counts, and current draft revision.
- repair_script: resume the stored draft/refinement action only; do not redo portraits or media.
- audio_repair: run episode audio only; valid exact-text WAVs are reused.
- agnes: skip script, portraits, and TTS; do not call a sheet tool. Reuse captions and resume Agnes/assembly. Submit backfills missing roster sheets only before the first claim; afterward identities are immutable and missing sheets fail closed.
${youtubeResumeInstruction}

AUTHORING IS TOOL-ONLY. Emit no visible planning, analysis, draft, manual counting, JSON, or preamble. Put the full arc, learning idea, ending insight, range beats, supporting identities, and prop bible directly in start/restart tool arguments. Beats must be contiguous, non-overlapping, and cover scenes 1 through targetSceneCount; reserve climax, resolution, and ending for later ranges. Never send the whole script or scriptJson. Call write_episode_script_chunk sequentially:

- operation=start: provide episodeId, targetSceneCount (40-60), the complete immutable authoringPlan, and exactly opening scenes 1-8. This opening chunk establishes setup and first causal movement; it never solves the premise or includes climax, resolution, ending insight, goodbye, or return home.
- operation=append: provide only episodeId, expectedDraftRevision from the latest receipt, and exactly the requested next eight scenes; omit targetSceneCount and authoringPlan because their durable values are immutable. Only the final range may contain 1-8 scenes.
- operation=restart: use only after deterministic validation requires complete re-authoring. Provide the rejected draft's exact expectedDraftRevision, a new complete authoringPlan and targetSceneCount, and corrected scenes 1-8.

Keep payload headroom: an append call TARGET is at most 18000 serialized characters, a start/restart call TARGET is at most 20000 including its plan, and the hard content maximum is 24000. TARGET each complete scene at no more than 2000 serialized characters. Field targets: narrationText 15-20 words/<=170 chars; figure-free environmentDescription 120-260; action 70-180; sceneDetails 180-360; each supportingEntities/continuityAnchors entry <=220; cameraAngle 25-100; lighting 30-120. Cast arrays compactly enumerate the exact visible cast with no size cap. Put identity, environment, blocking/action, expression, prop state, continuity, camera, and lighting once in their proper fields. Keep the plan compact.

scenes is always a real JSON array of complete objects, never encoded text. Obey each receipt; append omits targetSceneCount/authoringPlan. Include every field and explicit empty arrays. sceneDetails needs 60+ characters with two sentences or three concrete clauses. Every visible figure's exact name must appear in action/sceneDetails with position, pose/action, expression, and prop state, and exactly once in cast arrays. Narration/plan may say herd/group; rendered fields name declared individuals. Preserve the plan and handoff. When complete, call refine_episode_script with only episodeId/draftRevision. Validation is authoritative; chunking is transport only and must not reduce creative detail. Obey retryThisInvocation; false ends the run with accepted chunks preserved. For pendingRepair or semantic rejection, resubmit only candidateScenes named by requiredSceneNumbers; change only editableFields. Other pending data stays durable; improving corrections continue in-run. For a size or input rejection with retryThisInvocation=true, correct and resubmit its range/operation; start/restart retains the plan and append omits it. Never patch production scenes or send script content to update_episode_status.

Only measured audio longer than 12 seconds may invoke the narrow narration repair inside refine_episode_script. Cloudflare is first and NVIDIA is fallback. It receives only the current narration plus small neighboring narration context, and may change only narrationText; environment, action, characters, visual forms, supporting entities, continuity, camera, and lighting remain untouched.

Call synthesize_episode_narration_audio once with seriesId and episodeNumber. It loads the persisted script, generates or reuses every exact-text scene WAV, and returns complete timing evidence. If it reports repair_required, call refine_episode_script once with episodeId plus durationExceededScenes, measuredTotalNarrationSeconds, and measuredNarrationSceneCount. Stop unless refinement is ready; if narration changed, rerun the episode-audio tool so unchanged WAVs are reused and changed ones regenerate. When audio is ready, generate_episode_captions with only seriesId and episodeNumber, then set status=audio.

Run Agnes and video QA in four phases:

1. submit_agnes_scene_videos verifies the roster before the first claim, refreshes legacy signatures from the same on-disk portraits without regenerating them, uses reference mode only for complete public portrait sets, submits both titles and all scenes with two slots per Agnes account, persists queue acknowledgement, and returns without downloading. After any claim, identities and modes are immutable and missing sheets fail closed. If anything remains pending, stop.
2. verify_agnes_scene_videos refreshes accepted tasks with the submitting account and safely resubmits only missing/retryable work. If anything is queued, running, pending, or deferred, stop.
3. download_agnes_scene_videos runs only after every task is complete and exact-normalizes every downloaded clip to its matching WAV.
4. Call qa_agnes_episode_videos. Unless status=passed, stop and follow nextAction. Rejected assets resume through the same scheduler; never bypass QA.

Queue-full, provider-busy, and network/ambiguous outcomes are persisted for a later invocation; do not spin. Rotate Agnes credentials only for definite per-key rate-limit, quota, daily-limit, or credit errors. Retrieval always uses the key that submitted the task. Never duplicate an accepted request.

${youtubeCompletionInstruction}
`;
}

/** Safe default used by tests and any caller that does not explicitly enable uploads. */
export const SYSTEM_PROMPT_EXTENSION = buildSystemPromptExtension(false);
