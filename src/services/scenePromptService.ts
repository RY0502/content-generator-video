import type { CustomStateStore } from "freetier-deepagent-framework";
import {
  buildStylizedScenePrompt,
  type SceneCharacterVisual,
} from "../promptBuilder.js";
import type { SeriesState } from "../state/seriesState.js";
import { ensureCharacterBibleEntry } from "./characterSheetService.js";

export interface ScenePromptInput {
  seriesId: number;
  sceneNumber: number;
  characterNames: string[];
  characterVisuals?: SceneCharacterVisual[];
  environmentDescription: string;
  narrationText: string;
  action: string;
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
}

export interface MaterializedScenePrompt {
  prompt: string;
  characterNames: string[];
  characterDescriptions: string[];
}

/**
 * Materializes the canonical prompt used by Agnes text-to-video. Character
 * bible entries still come from the approved portrait-generation stage, while
 * no scene image is created or required.
 */
export async function materializeScenePrompt(params: {
  seriesState: SeriesState;
  input: ScenePromptInput;
  customState?: CustomStateStore;
  promptHash?: string;
  requestedBy?: string;
  /** Legacy-only escape hatch. Production Agnes prompting never creates images. */
  allowCharacterSheetGeneration?: boolean;
}): Promise<MaterializedScenePrompt> {
  const { seriesState, input, customState, promptHash } = params;
  const characterNames: string[] = [];
  const characterDescriptions: string[] = [];
  const canonicalNames = params.allowCharacterSheetGeneration
    ? null
    : new Set(
        (await seriesState.getSeriesCharacters(input.seriesId))
          .map((character) => character.name.trim()),
      );

  for (const rawCharacterName of input.characterNames) {
    // Preserve the scene tool's historical sanitization so old/refined scripts
    // produce byte-for-byte equivalent prompts in every media branch.
    const characterName = rawCharacterName
      .split("\n")[0]
      .split("?")[0]
      .split(",")[0]
      .trim();
    if (!characterName) continue;
    if (canonicalNames && !canonicalNames.has(characterName)) {
      throw new Error(
        `Scene ${input.sceneNumber} contains "${characterName}" in characterNames, but that name is not in ` +
        "the fixed series roster. Put guests and secondary creatures in supportingEntities instead.",
      );
    }

    const characterVisual = input.characterVisuals?.find(
      (item) => item.name.trim() === characterName,
    );
    let generationPrompt: string;
    if (params.allowCharacterSheetGeneration) {
      generationPrompt = await ensureCharacterBibleEntry({
        seriesState,
        seriesId: input.seriesId,
        characterName,
        characterVisual,
        customState,
        promptHash,
        requestedBy: params.requestedBy ?? `scene ${input.sceneNumber}`,
      });
    } else {
      const sheet = await seriesState.getCharacterSheet(input.seriesId, characterName);
      if (!sheet?.approvedAt || !sheet.generationPrompt?.trim()) {
        throw new Error(
          `Approved character sheet for "${characterName}" is missing. Call ensure_series_character_sheets ` +
          "before the first Agnes submission; scene-video prompting never generates images.",
        );
      }
      generationPrompt = sheet.generationPrompt.trim();
    }
    characterNames.push(characterName);
    characterDescriptions.push(generationPrompt);
  }

  return {
    characterNames,
    characterDescriptions,
    prompt: buildStylizedScenePrompt({
      characterNames,
      characterVisuals: input.characterVisuals,
      characterDescriptions,
      environmentDescription: input.environmentDescription,
      action: input.action,
      narrationText: input.narrationText,
      cameraAngle: input.cameraAngle ?? "establishing",
      lighting: input.lighting ?? "warm morning sunlight",
      supportingEntities: input.supportingEntities,
      continuityAnchors: input.continuityAnchors,
      sceneDetails: input.sceneDetails,
    }),
  };
}
