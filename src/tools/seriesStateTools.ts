import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
  canonicalizeKeyArtTitle,
} from "../services/keyArtTitleContract.js";
import { DEFAULT_PRODUCTION_MIN_SCENES } from "../services/narrationContract.js";
import {
  inspectProductionScriptReadiness,
} from "../services/productionScriptContract.js";
import {
  buildEpisodeScriptPendingRepairPayload,
  episodeScriptChunkDraftRequiresRestart,
  getEpisodeScriptChunkAuthoringProgress,
} from "./scriptRefinementTool.js";
import {
  SERIES_EPISODE_COUNT,
  EpisodeAudioReadinessError,
  SeriesState,
  type EpisodeScriptDraftValidation,
  type EpisodeScriptPendingChunkRow,
} from "../state/seriesState.js";
import { canonicalCharacterImageName } from "../providers/supabaseCharacterReferenceStore.js";

const INVALID_STATUS_UPDATE = Symbol("invalid-status-update");

type InvalidStatusUpdate = {
  readonly [INVALID_STATUS_UPDATE]: true;
  readonly episodeId?: number;
  readonly invalidPaths: string[];
  readonly omittedIssueCount: number;
};

function isInvalidStatusUpdate(value: unknown): value is InvalidStatusUpdate {
  return Boolean(value)
    && typeof value === "object"
    && (value as Partial<InvalidStatusUpdate>)[INVALID_STATUS_UPDATE] === true;
}

function publicDraftValidation(
  validation: EpisodeScriptDraftValidation | null,
  options: {
    authoringInProgress?: boolean;
    pendingRepair?: boolean;
    restartRequired?: boolean;
  } = {},
): unknown {
  if (!validation) return validation;
  const { repairEvidence, ...summary } = validation;
  if (options.authoringInProgress) {
    return {
      ...summary,
      requiredAction: options.restartRequired
        ? "restart_script_authoring"
        : options.pendingRepair
        ? "correct_pending_chunk"
        : "continue_authoring",
    };
  }
  if (!repairEvidence) {
    return {
      ...summary,
      requiredAction: "refine",
    };
  }
  const durationExceededSceneCount = repairEvidence.durationExceededScenes?.length ?? 0;
  return {
    ...summary,
    requiredAction: validation.pass
      ? "refine"
      : durationExceededSceneCount > 0
        ? "resume_narration_repair"
        : "refine",
    durableTimingEvidence: {
      durationExceededSceneCount,
      hasMeasuredTotalNarrationSeconds:
        repairEvidence.measuredTotalNarrationSeconds !== undefined,
      measuredNarrationSceneCount:
        repairEvidence.measuredNarrationSceneCount,
    },
  };
}

function pendingChunkValidationMessages(
  pendingChunk: EpisodeScriptPendingChunkRow,
): string[] {
  const messages: string[] = [];
  for (const issue of pendingChunk.structuredIssues) {
    const issueMessages = Array.isArray(issue.messages)
      ? issue.messages.filter((message): message is string => (
          typeof message === "string" && Boolean(message.trim())
        ))
      : [];
    if (issueMessages.length > 0) {
      messages.push(...issueMessages);
      continue;
    }
    if (typeof issue.message === "string" && issue.message.trim()) {
      messages.push(issue.message);
    }
  }
  return [...new Set(messages)];
}

/**
 * Deep-agent tools exposing the durable series/episode state (Turso/libSQL-backed,
 * see src/state/seriesState.ts). These are the tools the main agent must call
 * FIRST each run to determine which episode to work on and resume correctly
 * across separate invocations (see systemPromptExtension in src/index.ts).
 */
export interface SeriesStateToolsOptions {
  /** When false, assembled episodes remain resumable but cannot route to an upload capability. */
  youtubeUploadEnabled?: boolean;
  /** Idempotent remote cleanup invoked only for a genuinely uploaded complete season. */
  onSeriesComplete?: (seriesId: number) => Promise<void>;
}

export function buildSeriesStateTools(
  seriesState: SeriesState,
  options: SeriesStateToolsOptions = {},
): DynamicStructuredTool[] {
  const youtubeUploadEnabled = options.youtubeUploadEnabled ?? true;
  const tryParseJson = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };

  const repairJsonObjectArrayString = (value: string) => {
    return value
      .replace(/\{\s*name\s*:/g, '{"name":')
      .replace(/,\s*description\s*:/g, ', "description":');
  };

  const parseJsonArrayInput = (value: unknown) => {
    if (typeof value === "string") {
      const parsedValue = tryParseJson(value);
      if (parsedValue !== undefined) {
        return parsedValue;
      }

      const repairedValue = repairJsonObjectArrayString(value);
      const reparsedValue = tryParseJson(repairedValue);
      if (reparsedValue !== undefined) {
        return reparsedValue;
      }

      return value;
    }
    return value;
  };

  const normalizeEpisodesInput = (value: unknown) => {
    const parsedValue = parseJsonArrayInput(value);
    if (!Array.isArray(parsedValue)) {
      return parsedValue;
    }

    return parsedValue.map((episode) => {
      if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
        return episode;
      }

      const normalizedEpisode = { ...episode } as Record<string, unknown>;
      if (typeof normalizedEpisode.premise !== "string" && typeof normalizedEpisode.preprise === "string") {
        normalizedEpisode.premise = normalizedEpisode.preprise;
      }
      return normalizedEpisode;
    });
  };

  const canonicalTitleSchema = (kind: "series" | "episode") => z.string().transform(
    (value, context) => {
      try {
        return canonicalizeKeyArtTitle(value, kind);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    },
  );

  const seasonEpisodeListSchema = z
    .array(
      z.object({
        episodeNumber: z.number().int().min(1).max(SERIES_EPISODE_COUNT),
        title: canonicalTitleSchema("episode"),
        premise: z.string().trim().min(1, "Episode premise must not be empty."),
      }),
    )
    .length(
      SERIES_EPISODE_COUNT,
      `The season list must contain exactly ${SERIES_EPISODE_COUNT} episodes.`,
    )
    .superRefine((episodes, context) => {
      const episodeNumbers = episodes.map((episode) => episode.episodeNumber);
      const uniqueEpisodeNumbers = new Set(episodeNumbers);
      const isSequential = episodeNumbers.every(
        (episodeNumber, index) => episodeNumber === index + 1,
      );
      if (uniqueEpisodeNumbers.size !== SERIES_EPISODE_COUNT || !isSequential) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Episode numbers must be unique and sequential from 1 through ${SERIES_EPISODE_COUNT}.`,
        });
      }
    });

  const getOrCreateSeries = new DynamicStructuredTool({
    name: "get_or_create_series",
    description:
      "Looks up the series by concept name. On a rerun, send conceptName only and it returns the stored roster. " +
      "Only when status=needs_definition, call it again with the complete fixed character/environment rosters and " +
      "episode formula to create the series. The concept name is the spoken series title and must have at most " +
      `${KEY_ART_TITLE_MAX_RAW_CHARACTERS} characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words. ` +
      "Always call this first. Returns { seriesId, characters, environments }.",
    schema: z.object({
      conceptName: canonicalTitleSchema("series"),
      characters: z
        .preprocess(
          parseJsonArrayInput,
          z.array(z.object({
            name: z.string().trim().min(1),
            description: z.string().trim().min(1),
          }))
            .min(1, "A series must have at least one main character.")
            .max(5, "A series may have at most five main characters because Agnes accepts at most five image references.")
            .superRefine((characters, context) => {
              const names = new Set<string>();
              const imageNames = new Set<string>();
              characters.forEach((character, index) => {
                const normalizedName = character.name.normalize("NFKC").toLowerCase();
                if (names.has(normalizedName)) {
                  context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Duplicate main-character name: ${character.name}.`,
                    path: [index, "name"],
                  });
                }
                names.add(normalizedName);

                const imageName = canonicalCharacterImageName(character.name);
                if (imageNames.has(imageName)) {
                  context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Main-character name collides at public filename ${imageName}.png.`,
                    path: [index, "name"],
                  });
                }
                imageNames.add(imageName);
              });
            })
            .optional()
        )
        .describe("Complete fixed roster of 1-5 uniquely named main characters for first creation only. Can be JSON string or array."),
      environments: z
        .preprocess(
          parseJsonArrayInput,
          z.array(z.object({ name: z.string(), description: z.string() })).optional()
        )
        .describe("Complete fixed location roster for first creation only. Can be JSON string or array."),
      episodeFormula: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The complete approved episode-pattern guidance for first creation only."),
    }),
    func: async ({ conceptName, characters, environments, episodeFormula }) => {
      const existingSeriesId = await seriesState.findSeriesIdByConceptName(conceptName);
      if (existingSeriesId !== null) {
        const [storedCharacters, storedEnvironments] = await Promise.all([
          seriesState.getSeriesCharacters(existingSeriesId),
          seriesState.getSeriesEnvironments(existingSeriesId),
        ]);
        return JSON.stringify({
          seriesId: existingSeriesId,
          characters: storedCharacters,
          environments: storedEnvironments,
        });
      }

      const missingFields = [
        ...(characters === undefined ? ["characters"] : []),
        ...(environments === undefined ? ["environments"] : []),
        ...(episodeFormula === undefined ? ["episodeFormula"] : []),
      ];
      if (
        characters === undefined
        || environments === undefined
        || episodeFormula === undefined
      ) {
        return JSON.stringify({
          status: "needs_definition",
          persisted: false,
          conceptName,
          missingFields,
          retryThisInvocation: true,
          nextAction:
            "Call get_or_create_series once more with conceptName plus the complete characters, environments, and episodeFormula definition.",
        });
      }

      const seriesId = await seriesState.getOrCreateSeries(conceptName, characters, environments, episodeFormula);
      const storedCharacters =
        typeof seriesState.getSeriesCharacters === "function"
          ? await seriesState.getSeriesCharacters(seriesId)
          : [];
      const storedEnvironments =
        typeof seriesState.getSeriesEnvironments === "function"
          ? await seriesState.getSeriesEnvironments(seriesId)
          : [];
      return JSON.stringify({
        seriesId,
        characters: storedCharacters && storedCharacters.length > 0 ? storedCharacters : characters,
        environments: storedEnvironments && storedEnvironments.length > 0 ? storedEnvironments : environments,
      });
    },
  });

  const bulkInsertEpisodes = new DynamicStructuredTool({
    name: "bulk_insert_episode_list",
    description:
      "On a rerun, send seriesId only to verify the stored season. If status=manifest_required, call it again with " +
      `exactly ${SERIES_EPISODE_COUNT} episodes numbered 1-${SERIES_EPISODE_COUNT}; it validates and atomically inserts them. ` +
      `each with a non-empty title (at most ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} characters and ` +
      `${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words) and premise. Stored seasons are never overwritten. ` +
      "If status=invalid_series_id, call get_or_create_series before retrying this tool.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodes: z.preprocess(
        normalizeEpisodesInput,
        seasonEpisodeListSchema.optional(),
      ),
    }),
    func: async ({ seriesId, episodes }) => {
      const manifestStatus = await seriesState.bulkInsertEpisodesIfEmpty(seriesId, episodes);
      if (manifestStatus === "series_missing") {
        return JSON.stringify({
          // Keep this distinct from get_next_episode.kind=series_missing,
          // which is a terminal availability result. A stale bootstrap id is
          // recoverable in this invocation by resolving the concept again.
          status: "invalid_series_id",
          persisted: false,
          seriesId,
          retryThisInvocation: true,
          nextAction:
            "Call get_or_create_series with the requested concept before calling bulk_insert_episode_list again with its returned seriesId.",
        });
      }
      if (manifestStatus === "manifest_required") {
        return JSON.stringify({
          status: "manifest_required",
          persisted: false,
          seriesId,
          retryThisInvocation: true,
          nextAction:
            `Call bulk_insert_episode_list once more with seriesId and the complete ${SERIES_EPISODE_COUNT}-episode manifest.`,
        });
      }
      return JSON.stringify({ status: "ok" });
    },
  });

  const getNextEpisode = new DynamicStructuredTool({
    name: "get_next_episode",
    description:
      "Returns the next resumable episode and a compact resumeAction. Obey that action exactly. " +
      "When scriptDraft.pendingRepair is present, copy and resubmit only its requiredSceneNumbers from candidateScenes; " +
      "change only its per-scene editableFields because every other pending scene and field is retained durably. " +
      "daily_limit, series_complete, no_episodes, series_missing, and resumeAction=stop end the invocation. " +
      (youtubeUploadEnabled
        ? "A validated assembled episode may return youtube_upload. "
        : "YouTube upload is disabled; a validated assembled episode returns stop and remains at assembly for later enablement. ") +
      "The production script stays in Turso; this receipt never retransmits it.",
    schema: z.object({ seriesId: z.number().int().positive() }),
    func: async ({ seriesId }) => {
      const availability = await seriesState.getNextEpisodeAvailability(seriesId);
      if (availability.kind !== "ready") {
        if (
          availability.kind === "series_complete"
          && options.onSeriesComplete
          && await seriesState.isSeriesFullyCompleted(seriesId)
        ) {
          await options.onSeriesComplete(seriesId);
        }
        return JSON.stringify(availability);
      }

      const [characters, agnesRows, privateDraft, storedPendingChunk] = await Promise.all([
        seriesState.getSeriesCharacters(seriesId),
        seriesState.listAgnesSceneGenerations(
          seriesId,
          availability.episode.episodeNumber,
        ),
        typeof seriesState.getEpisodeScriptDraft === "function"
          ? seriesState.getEpisodeScriptDraft(availability.episode.id)
          : Promise.resolve(null),
        typeof seriesState.getEpisodeScriptPendingChunk === "function"
          ? seriesState.getEpisodeScriptPendingChunk(availability.episode.id)
          : Promise.resolve(null),
      ]);
      const scriptValidation = inspectProductionScriptReadiness(
        availability.episode.scriptJson,
        characters.map((character) => character.name),
        agnesRows,
      );
      const baseScriptAuthoringProgress = privateDraft
        ? getEpisodeScriptChunkAuthoringProgress(
            privateDraft.scriptJson,
            privateDraft.validation,
          )
        : null;
      const restartRequired = Boolean(
        privateDraft
        && baseScriptAuthoringProgress?.status === "in_progress"
        && episodeScriptChunkDraftRequiresRestart(privateDraft.validation),
      );
      const pendingChunk = privateDraft
        && !restartRequired
        && storedPendingChunk
        && storedPendingChunk.episodeId === privateDraft.episodeId
        && storedPendingChunk.acceptedDraftRevision === privateDraft.revision
        && storedPendingChunk.acceptedDraftDigest === privateDraft.contentDigest
          ? storedPendingChunk
          : null;
      const pendingValidationMessages = pendingChunk
        ? pendingChunkValidationMessages(pendingChunk)
        : [];
      const pendingRepair = pendingChunk
        ? buildEpisodeScriptPendingRepairPayload(pendingChunk)
        : null;
      const scriptAuthoringProgress = baseScriptAuthoringProgress
        ? restartRequired
          ? {
              ...baseScriptAuthoringProgress,
              requiredAction: "restart_script_authoring",
              nextSceneNumber: 1,
              nextSceneEnd: Math.min(8, baseScriptAuthoringProgress.targetSceneCount),
            }
          : pendingChunk
            ? {
                ...baseScriptAuthoringProgress,
                requiredAction: "correct_pending_chunk",
                nextSceneNumber: pendingChunk.sceneStart,
                nextSceneEnd: pendingChunk.sceneEnd,
                validationIssues: pendingValidationMessages.slice(0, 8),
              }
            : baseScriptAuthoringProgress
        : null;
      const publicScriptDraftValidation = privateDraft
        ? publicDraftValidation(privateDraft.validation, {
            authoringInProgress: scriptAuthoringProgress?.status === "in_progress",
            pendingRepair: pendingChunk !== null,
            restartRequired,
          })
        : null;
      const scriptDraft = privateDraft
        ? {
            episodeId: privateDraft.episodeId,
            revision: privateDraft.revision,
            contentDigest: privateDraft.contentDigest,
            validation: publicScriptDraftValidation,
            ...(scriptAuthoringProgress === null
              ? {}
              : { authoringProgress: scriptAuthoringProgress }),
            ...(pendingRepair === null
              ? {}
              : { pendingRepair }),
            createdAt: privateDraft.createdAt,
            updatedAt: privateDraft.updatedAt,
          }
        : null;
      const initialScriptRequired = availability.episode.scriptJson == null
        && scriptDraft === null
        && !scriptValidation.agnesSubmissionStarted;
      let resumeAction: "stop" | "repair_script" | "script_and_audio" | "script_authoring" | "audio_repair" | "agnes" | "youtube_upload";
      let audioValidation: unknown = null;
      let assemblyValidation: unknown = null;
      let youtubeUploadValidation: unknown = null;
      if (scriptValidation.status === "repair_blocked") {
        resumeAction = "stop";
      } else if (
        scriptAuthoringProgress?.status === "in_progress"
        && !scriptValidation.agnesSubmissionStarted
      ) {
        // A bounded prefix is already durable. Resume from its exact next
        // range instead of regenerating portraits or retransmitting the full
        // accumulated script through the model/tool boundary.
        resumeAction = "script_authoring";
      } else if (initialScriptRequired) {
        // A brand-new episode has nothing to repair yet. Route it through the
        // authoring path so the model creates and stages its first complete
        // script instead of asking refine_episode_script for a missing draft.
        resumeAction = "script_and_audio";
      } else if (scriptValidation.status === "repair_required") {
        resumeAction = "repair_script";
      } else if (scriptDraft !== null && !scriptValidation.agnesSubmissionStarted) {
        // An unfinished private revision wins before any provider claim. This
        // is what lets a later run resume capped narration repair or full
        // re-authoring instead of repeatedly auditing the older production
        // script merely because its episode stage still says audio.
        resumeAction = "repair_script";
      } else if (
        ["audio", "assembly"].includes(availability.episode.status) ||
        scriptValidation.agnesSubmissionStarted
      ) {
        // Durable provider evidence is more authoritative than a stale or
        // pessimistically-written episode stage. Once a claim exists, never
        // fall back through script/character/audio generation merely because
        // an earlier run left the coarse episode status as pending/failed.
        try {
          const readyAudio = await seriesState.assertEpisodeAudioReady(availability.episode.id);
          if (scriptValidation.agnesSubmissionStarted) {
            await seriesState.assertEpisodeKeyArtAudioReady(
              seriesId,
              availability.episode.episodeNumber,
            );
          }
          audioValidation = { status: "ready", ...readyAudio };
          const completedAssemblyReceipt = typeof seriesState.listEpisodeVideoOutputs === "function"
            ? (await seriesState.listEpisodeVideoOutputs(
                seriesId,
                availability.episode.episodeNumber,
              )).some((output) =>
                output.variant === "agnes_text"
                && output.status === "completed"
                && Boolean(output.outputPath)
              )
            : false;
          if (availability.episode.status === "assembly" || completedAssemblyReceipt) {
            try {
              await seriesState.assertEpisodeReadyForDone(availability.episode.id);
              assemblyValidation = { status: "ready" };
              if (youtubeUploadEnabled) {
                resumeAction = "youtube_upload";
              } else {
                resumeAction = "stop";
                youtubeUploadValidation = {
                  status: "disabled",
                  enabled: false,
                  message:
                    "YouTube upload is disabled. The assembled episode remains at status=assembly and is not marked complete.",
                };
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              assemblyValidation = {
                status: "repair_required",
                message: message.length <= 300 ? message : `${message.slice(0, 297)}...`,
              };
              // Re-entering the idempotent Agnes/download path also repairs a
              // missing normalized input before assembly is attempted again.
              resumeAction = "agnes";
            }
          } else {
            resumeAction = "agnes";
          }
        } catch (error) {
          if (!(error instanceof EpisodeAudioReadinessError)) throw error;
          const locked = scriptValidation.agnesSubmissionStarted;
          const message = error.message.length <= 300
            ? error.message
            : `${error.message.slice(0, 297)}...`;
          audioValidation = {
            status: locked ? "repair_blocked" : "repair_required",
            reason: error.reason,
            ...(error.sceneNumber === undefined ? {} : { sceneNumber: error.sceneNumber }),
            ...(error.assetKind === undefined ? {} : { assetKind: error.assetKind }),
            ...(error.durationSeconds === undefined
              ? {}
              : { durationSeconds: error.durationSeconds }),
            ...(error.totalDurationSeconds === undefined
              ? {}
              : { totalDurationSeconds: error.totalDurationSeconds }),
            message,
          };
          resumeAction = locked ? "stop" : "audio_repair";
        }
      } else {
        resumeAction = "script_and_audio";
      }
      // The production tools read the canonical script directly from Turso.
      // Returning it on every resume duplicated tens of thousands of
      // characters into the agent context even when the next action was only
      // Agnes verification or YouTube upload.
      const { scriptJson: _scriptJson, ...episodeReceipt } = availability.episode;
      return JSON.stringify({
        ...availability,
        episode: episodeReceipt,
        resumeAction,
        scriptValidation: initialScriptRequired
          ? {
              status: "not_started",
              pass: false,
              sceneCount: 0,
              nextAction:
                `After the one roster preflight, immediately call write_episode_script_chunk with operation=start, targetSceneCount=${DEFAULT_PRODUCTION_MIN_SCENES} for episode "${availability.episode.title}" with premise: "${availability.episode.premise}". The entire story MUST strictly follow this title and premise across a single continuous ${DEFAULT_PRODUCTION_MIN_SCENES}-scene arc (2 chunks). Put the complete plan for scenes 1-${DEFAULT_PRODUCTION_MIN_SCENES} and only opening scenes 1-${Math.min(8, DEFAULT_PRODUCTION_MIN_SCENES)} directly in its tool arguments. Do NOT conclude the story in scenes 1-8. Emit no visible planning, manual counting, draft, JSON, or preamble.`,
            }
          : scriptAuthoringProgress?.status === "in_progress"
            ? {
                status: "authoring_in_progress",
                pass: false,
                sceneCount: scriptAuthoringProgress.completedSceneCount,
                targetSceneCount: scriptAuthoringProgress.targetSceneCount,
                nextAction: restartRequired
                  ? `Your next assistant action must be write_episode_script_chunk with no visible planning or preamble. ` +
                    `Restart authoring with operation=restart, episodeId=${availability.episode.id}, ` +
                    `expectedDraftRevision=${privateDraft!.revision}, targetSceneCount=` +
                    `${scriptAuthoringProgress.targetSceneCount}, the complete immutable authoringPlan returned in ` +
                    `scriptDraft.authoringProgress, and corrected scenes 1-${Math.min(
                      8,
                      scriptAuthoringProgress.targetSceneCount,
                    )}. Do not append to the legacy prefix.`
                  : pendingChunk
                  ? `Your next assistant action must be write_episode_script_chunk with no visible planning or preamble. ` +
                    `Against draft revision ${privateDraft!.revision}, copy and resubmit only complete scenes ` +
                    `${pendingRepair!.requiredSceneNumbers.join(", ")} from ` +
                    `scriptDraft.pendingRepair.candidateScenes. Change only each scene's fields listed in ` +
                    `scriptDraft.pendingRepair.editableFields; every other pending scene and field stays durable. ` +
                    `Do not resend accepted scenes, targetSceneCount, authoringPlan, ` +
                    `or call refinement yet.`
                  : `Your next assistant action must be write_episode_script_chunk with no visible planning or preamble. Append only scenes ` +
                    `${scriptAuthoringProgress.nextSceneNumber}-${scriptAuthoringProgress.nextSceneEnd} ` +
                    `to draft revision ${privateDraft!.revision}. Continue the SAME single quest from scene 1 without resolving early or starting a second adventure. Do not call refinement yet.`,
              }
          : scriptValidation,
        scriptDraft,
        ...(audioValidation === null ? {} : { audioValidation }),
        ...(assemblyValidation === null ? {} : { assemblyValidation }),
        ...(youtubeUploadValidation === null ? {} : { youtubeUploadValidation }),
      });
    },
  });

  const updateEpisodeStatusSchema = z.object({
    episodeId: z.number().int().positive(),
    status: z.enum(["pending", "audio", "assembly", "failed"]),
    outputPath: z.string().optional(),
  }).strict().catch(({ error, input }) => {
    const raw = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "input"))];
    return {
      [INVALID_STATUS_UPDATE]: true,
      episodeId: Number.isSafeInteger(raw.episodeId) && Number(raw.episodeId) > 0
        ? Number(raw.episodeId)
        : undefined,
      invalidPaths: paths.slice(0, 8),
      omittedIssueCount: Math.max(0, paths.length - 8),
    } as unknown as {
      episodeId: number;
      status: "pending" | "audio" | "assembly" | "failed";
      outputPath?: string;
    };
  });

  const updateEpisodeStatus = new DynamicStructuredTool({
    name: "update_episode_status",
    description:
      "Persists only an episode's lightweight resumable stage (pending/audio/assembly/failed) and optional " +
      "assembled output path. It never accepts or persists script content: write_episode_script_chunk and " +
      "refine_episode_script exclusively own draft storage, validation, and promotion to the production script. " +
      (youtubeUploadEnabled
        ? "The terminal done transition is intentionally unavailable here: upload_to_youtube records the durable receipt, marks done, and cleans per-episode Agnes tracking after a successful upload."
        : "The terminal done transition is intentionally unavailable. YouTube upload is disabled, so a finished episode remains safely at assembly and is never marked done."),
    schema: updateEpisodeStatusSchema,
    func: async (input) => {
      if (isInvalidStatusUpdate(input)) {
        return JSON.stringify({
          status: "invalid_input",
          updated: false,
          ...(input.episodeId === undefined ? {} : { episodeId: input.episodeId }),
          invalidPaths: input.invalidPaths,
          omittedIssueCount: input.omittedIssueCount,
          retryThisInvocation: false,
          message:
            "update_episode_status accepts only episodeId, status=pending|audio|assembly|failed, and optional outputPath. Script content must never be sent to this tool.",
          nextAction:
            "Use write_episode_script_chunk for bounded script authoring, then refine_episode_script with only its compact episode/revision reference.",
        });
      }

      const { episodeId, status, outputPath } = input;
      await seriesState.updateEpisodeStatus(episodeId, status, { outputPath });
      return JSON.stringify({ status: "ok" });
    },
  });

  return [getOrCreateSeries, bulkInsertEpisodes, getNextEpisode, updateEpisodeStatus];
}
