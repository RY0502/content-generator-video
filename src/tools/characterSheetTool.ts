import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "node:path";
import { SeriesState } from "../state/seriesState.js";
import { ensureCharacterSheet } from "../services/characterSheetService.js";
import { startTimer, endTimer, logSheetFinalized, logStep } from "../utils/logger.js";
import type { CustomStateStore } from "freetier-deepagent-framework";

/**
 * Deep-agent tool: generates the character's single full-body reference
 * portrait (no poses/collage), then extracts an exhaustive text description
 * of it via a vision model for accurate identity constraints in every scene.
 *
 * Flow:
 * 1. A single portrait is generated via AnyAPI using Google Gemini.
 * 2. The portrait is analyzed (framework provider rotation) to extract an
 *    extremely detailed text description of the character alone (no background):
 *    colors, eyes, face shape, nose, lips, hair, clothing patterns, accessories,
 *    body shape, etc.
 * 3. An LLM distills that exhaustive description into a compact ≤250 char
 *    "signature prompt" capturing only the most visually significant traits.
 * 4. The compact signature prompt is saved as this character's
 *    `generationPrompt`, reused in every direct Agnes scene-video prompt.
 *
 * Idempotent:
 * - Whole-character short-circuit: skips entirely if already approved in DB.
 * - Checkpoint: if a previous run completed portrait generation/detail-extraction
 *   before crashing, re-running resumes without redoing it.
 */
export function buildCharacterSheetTool(
  seriesState: SeriesState,
  customState?: CustomStateStore,
  promptHash?: string
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_character_sheet",
    description:
      "Generates (or reuses if already approved) the character's single full-body reference " +
      "portrait for one series character using Google Gemini, then extracts an exhaustive text " +
      "description of it (via a vision model) used to render this character accurately and " +
      "consistently in every direct Agnes scene video. Always call this before submitting " +
      "any scene involving a character that doesn't yet have an approved sheet.",
    schema: z.object({
      seriesId: z.number().int().positive().describe("The series id returned by get_or_create_series."),
      characterName: z.string().describe("Exact character name, e.g. 'Pip the Ant'."),
      characterDescription: z
        .string()
        .describe(
          "Fixed, verbatim textual description of the character's COMPLETE appearance (species, colors, clothing, accessories) AND its complete persona/personality as established in the story (e.g. brave, shy, curious, energetic) so the rendered portrait reflects both. This becomes the locked identity used in every video prompt."
        ),
    }),
    func: async ({ seriesId, characterName, characterDescription }) => {
      const timerName = `character_${characterName}`;
      startTimer(timerName);
      logStep(`Generating character portrait for ${characterName}`);

      // Guard against stale/deleted series ids (e.g. DB cleanup happened but
      // a resumed run/checkpoint still references an old seriesId).
      if (!(await seriesState.seriesExists(seriesId))) {
        throw new Error(
          `Series id ${seriesId} does not exist. This usually means the domain tables were cleaned but ` +
          "a previous run resumed with stale state. Re-run from the beginning so get_or_create_series " +
          "creates a fresh series id, or run db:cleanup to clear framework resume/checkpoint tables too."
        );
      }

      const { status, referenceImagePaths, generationPrompt } = await ensureCharacterSheet({
        seriesState,
        seriesId,
        characterName,
        characterDescription,
        customState,
        promptHash,
      });

      endTimer(timerName);
      logSheetFinalized({
        type: "character",
        name: characterName,
        path: path.dirname(referenceImagePaths.portrait.path),
      });
      return JSON.stringify({ status, sheet: referenceImagePaths, generationPrompt });
    },
  });
}
