import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { SeriesState } from "../state/seriesState.js";
import { ensureSeriesCharacterPortraits } from "../services/seriesCharacterPortraitService.js";
import { endTimer, logStep, startTimer } from "../utils/logger.js";

/** Production preflight for the complete immutable main-character roster. */
export function buildEnsureSeriesCharacterPortraitsTool(
  seriesState: SeriesState,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "ensure_series_character_portraits",
    description:
      "Ensures the complete stored 1-5 character roster has one local portrait and one verified public Supabase reference URL. " +
      "It reuses local or public images before generating, uploads missing public objects, and performs no character-sheet vision analysis. " +
      "Call exactly once before episode script/audio/video work.",
    schema: z.object({
      seriesId: z.number().int().positive().describe("The durable series id."),
    }),
    func: async ({ seriesId }) => {
      const timerName = `character_portrait_roster_${seriesId}`;
      startTimer(timerName);
      logStep(`Ensuring local and public portraits for series ${seriesId}`);
      const result = await ensureSeriesCharacterPortraits({ seriesState, seriesId });
      endTimer(timerName);
      return JSON.stringify({
        status: "complete_roster_portraits_ready",
        ...result,
        characters: result.characters.map((character) => ({
          name: character.name,
          imageName: character.imageName,
          status: character.status,
          publicUrl: character.publicUrl,
        })),
        nextAction: "Continue the exact durable resume action returned for this episode.",
      });
    },
  });
}
