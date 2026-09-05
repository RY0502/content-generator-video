import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
  canonicalizeKeyArtTitle,
} from "../services/keyArtTitleContract.js";
import { SERIES_EPISODE_COUNT, SeriesState } from "../state/seriesState.js";

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

  const parseJsonObjectInput = (value: unknown) => {
    if (typeof value !== "string") {
      return value;
    }

    const parsedValue = tryParseJson(value);
    if (parsedValue !== undefined) {
      return parsedValue;
    }

    return value;
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
      "Looks up the series by concept name, creating it (with its character/environment roster and " +
      "episode formula) if it doesn't exist yet. The concept name is the spoken series title and must have at most " +
      `${KEY_ART_TITLE_MAX_RAW_CHARACTERS} characters and ${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words. ` +
      "Always call this first. Returns { seriesId, characters, environments }.",
    schema: z.object({
      conceptName: canonicalTitleSchema("series"),
      characters: z
        .preprocess(
          parseJsonArrayInput,
          z.array(z.object({ name: z.string(), description: z.string() }))
        )
        .describe("Fixed character roster with verbatim visual descriptions. Can be JSON string or array."),
      environments: z
        .preprocess(
          parseJsonArrayInput,
          z.array(z.object({ name: z.string(), description: z.string() }))
        )
        .describe("Fixed location roster with verbatim visual descriptions. Can be JSON string or array."),
      episodeFormula: z
        .string()
        .default(
          "Approved preschool story patterns: classic 8-beat teamwork rescue, repeated-attempt problem solving, " +
            "gentle mystery/clue trail, journey/quest, celebration/preparation, or character-feeling growth. " +
            "If the user requests a specific formula, use that exactly; otherwise choose the best-fit pattern for each episode and vary across the series."
        )
        .describe("The approved episode pattern guidance text for this series."),
    }),
    func: async ({ conceptName, characters, environments, episodeFormula }) => {
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
      `Validates and atomically inserts exactly ${SERIES_EPISODE_COUNT} episodes numbered 1-${SERIES_EPISODE_COUNT}, ` +
      `each with a non-empty title (at most ${KEY_ART_TITLE_MAX_RAW_CHARACTERS} characters and ` +
      `${KEY_ART_TITLE_MAX_SPOKEN_WORDS} spoken words) and premise. On later calls it verifies that the stored season is ` +
      "complete and valid without overwriting it.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodes: z.preprocess(
        normalizeEpisodesInput,
        seasonEpisodeListSchema,
      ),
    }),
    func: async ({ seriesId, episodes }) => {
      await seriesState.bulkInsertEpisodesIfEmpty(seriesId, episodes);
      return JSON.stringify({ status: "ok" });
    },
  });

  const getNextEpisode = new DynamicStructuredTool({
    name: "get_next_episode",
    description:
      "Returns a discriminated episode-availability result. kind=ready includes the lowest-numbered " +
      "resumable episode. kind=daily_limit means today's episode was already uploaded; stop immediately " +
      "and repeat its exact message: 'Only 1 episode per day can be generated.' kind=series_complete, " +
      "kind=no_episodes, and kind=series_missing are also terminal for this invocation. Never start media " +
      "work unless kind=ready, and resume from the returned episode's durable status instead of restarting.",
    schema: z.object({ seriesId: z.number().int().positive() }),
    func: async ({ seriesId }) => {
      const availability = await seriesState.getNextEpisodeAvailability(seriesId);
      return JSON.stringify(availability);
    },
  });

  const updateEpisodeStatus = new DynamicStructuredTool({
    name: "update_episode_status",
    description:
      "Persists an episode's resumable stage (pending/script/audio/assembly/failed), plus a validated " +
      "production script or assembled output path when applicable. New scripts must contain 40-60 sequential " +
      "one-audio/one-video scenes that satisfy the shared narration contract. The terminal done transition is " +
      "intentionally unavailable here: upload_to_youtube records the durable receipt, marks done, and cleans " +
      "per-episode Agnes tracking after a successful upload.",
    schema: z.object({
      episodeId: z.number(),
      status: z.enum(["pending", "script", "audio", "assembly", "failed"]),
      scriptJson: z.preprocess(parseJsonObjectInput, z.unknown()).optional(),
      outputPath: z.string().optional(),
    }),
    func: async ({ episodeId, status, scriptJson, outputPath }) => {
      await seriesState.updateEpisodeStatus(episodeId, status, { scriptJson, outputPath });
      return JSON.stringify({ status: "ok" });
    },
  });

  return [getOrCreateSeries, bulkInsertEpisodes, getNextEpisode, updateEpisodeStatus];
}
