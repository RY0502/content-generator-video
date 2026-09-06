import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
  canonicalizeKeyArtTitle,
} from "../services/keyArtTitleContract.js";
import {
  inspectProductionScriptReadiness,
} from "../services/productionScriptContract.js";
import { getEpisodeScriptChunkAuthoringProgress } from "./scriptRefinementTool.js";
import {
  SERIES_EPISODE_COUNT,
  EpisodeAudioReadinessError,
  SeriesState,
  type EpisodeScriptDraftValidation,
} from "../state/seriesState.js";

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
  options: { authoringInProgress?: boolean } = {},
): unknown {
  if (!validation) return validation;
  const { repairEvidence, ...summary } = validation;
  if (options.authoringInProgress) {
    return {
      ...summary,
      requiredAction: "continue_authoring",
    };
  }
  if (!repairEvidence) {
    const onlyDiscardedLegacyTimingIssue = !validation.pass
      && validation.omittedIssueCount === 0
      && validation.issues.length > 0
      && validation.issues.every((issue) =>
        /^Measured total narration was\s+[\d.]+\s+seconds/iu.test(issue)
      );
    return {
      ...summary,
      requiredAction: validation.pass || onlyDiscardedLegacyTimingIssue
        ? "refine"
        : "reauthor_complete_script",
    };
  }
  const durationExceededSceneCount = repairEvidence.durationExceededScenes?.length ?? 0;
  return {
    ...summary,
    requiredAction: validation.pass
      ? "refine"
      : durationExceededSceneCount > 0
        ? "resume_narration_repair"
        : "reauthor_complete_script",
    durableTimingEvidence: {
      durationExceededSceneCount,
      hasMeasuredTotalNarrationSeconds:
        repairEvidence.measuredTotalNarrationSeconds !== undefined,
      measuredNarrationSceneCount:
        repairEvidence.measuredNarrationSceneCount,
    },
  };
}

/**
 * Deep-agent tools exposing the durable series/episode state (Turso/libSQL-backed,
 * see src/state/seriesState.ts). These are the tools the main agent must call
 * FIRST each run to determine which episode to work on and resume correctly
 * across separate invocations (see systemPromptExtension in src/index.ts).
 */
export function buildSeriesStateTools(seriesState: SeriesState): DynamicStructuredTool[] {
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
          z.array(z.object({ name: z.string(), description: z.string() })).optional()
        )
        .describe("Complete fixed character roster for first creation only. Can be JSON string or array."),
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
      `${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words) and premise. Stored seasons are never overwritten.`,
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodes: z.preprocess(
        normalizeEpisodesInput,
        seasonEpisodeListSchema.optional(),
      ),
    }),
    func: async ({ seriesId, episodes }) => {
      const manifestStatus = await seriesState.bulkInsertEpisodesIfEmpty(seriesId, episodes);
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
      "daily_limit, series_complete, no_episodes, series_missing, and resumeAction=stop end the invocation. " +
      "The production script stays in Turso; this receipt never retransmits it.",
    schema: z.object({ seriesId: z.number().int().positive() }),
    func: async ({ seriesId }) => {
      const availability = await seriesState.getNextEpisodeAvailability(seriesId);
      if (availability.kind !== "ready") return JSON.stringify(availability);

      const [characters, agnesRows, privateDraft] = await Promise.all([
        seriesState.getSeriesCharacters(seriesId),
        seriesState.listAgnesSceneGenerations(
          seriesId,
          availability.episode.episodeNumber,
        ),
        typeof seriesState.getEpisodeScriptDraft === "function"
          ? seriesState.getEpisodeScriptDraft(availability.episode.id)
          : Promise.resolve(null),
      ]);
      const scriptValidation = inspectProductionScriptReadiness(
        availability.episode.scriptJson,
        characters.map((character) => character.name),
        agnesRows,
      );
      const scriptAuthoringProgress = privateDraft
        ? getEpisodeScriptChunkAuthoringProgress(
            privateDraft.scriptJson,
            privateDraft.validation,
          )
        : null;
      const scriptDraft = privateDraft
        ? {
            episodeId: privateDraft.episodeId,
            revision: privateDraft.revision,
            contentDigest: privateDraft.contentDigest,
            validation: publicDraftValidation(privateDraft.validation, {
              authoringInProgress: scriptAuthoringProgress?.status === "in_progress",
            }),
            ...(scriptAuthoringProgress === null
              ? {}
              : { authoringProgress: scriptAuthoringProgress }),
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
              resumeAction = "youtube_upload";
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
                "Plan the complete episode, then call write_episode_script_chunk with operation=start and scenes 1-8 as real arrays/objects, never an encoded scriptJson string.",
            }
          : scriptAuthoringProgress?.status === "in_progress"
            ? {
                status: "authoring_in_progress",
                pass: false,
                sceneCount: scriptAuthoringProgress.completedSceneCount,
                targetSceneCount: scriptAuthoringProgress.targetSceneCount,
                nextAction:
                  `Obey resumeAction=script_authoring and append only scenes ` +
                  `${scriptAuthoringProgress.nextSceneNumber}-${scriptAuthoringProgress.nextSceneEnd} ` +
                  `to draft revision ${privateDraft!.revision}. Do not call refinement yet.`,
              }
          : scriptValidation,
        scriptDraft,
        ...(audioValidation === null ? {} : { audioValidation }),
        ...(assemblyValidation === null ? {} : { assemblyValidation }),
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
      "The terminal done transition is " +
      "intentionally unavailable here: upload_to_youtube records the durable receipt, marks done, and cleans " +
      "per-episode Agnes tracking after a successful upload.",
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
