import type { CustomStateStore } from "freetier-deepagent-framework";
import {
  buildStylizedScenePrompt,
  type SceneCharacterVisual,
} from "../promptBuilder.js";
import type { SeriesState } from "../state/seriesState.js";
import { canonicalizeSceneCast } from "./sceneCastCanonicalizer.js";

export const MAX_AGNES_CHARACTER_REFERENCES = 5;

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
  /** Approved public portraits in the exact same order as characterNames. */
  characterReferenceSources: Array<{ name: string; source: string }>;
}

/**
 * Materializes the canonical prompt used by Agnes image-reference video.
 * Main-character appearance is never serialized into the text prompt: exact
 * names map 1:1 to durable public portrait URLs supplied to Agnes.
 */
export async function materializeScenePrompt(params: {
  seriesState: SeriesState;
  input: ScenePromptInput;
  customState?: CustomStateStore;
  promptHash?: string;
  requestedBy?: string;
  /** Deprecated compatibility flag. Prompt materialization never creates images. */
  allowCharacterSheetGeneration?: boolean;
}): Promise<MaterializedScenePrompt> {
  const { seriesState } = params;
  const characterNames: string[] = [];
  const characterDescriptions: string[] = [];
  const characterReferenceSources: Array<{ name: string; source: string }> = [];
  const roster = await seriesState.getSeriesCharacters(params.input.seriesId);
  const castCanonicalization = canonicalizeSceneCast(params.input, {
    mainCharacterNames: roster.map(({ name }) => name),
  });
  const ambiguousAlias = castCanonicalization.audit.unresolved.find(
    ({ kind }) => kind === "ambiguous_main_character_alias",
  );
  if (ambiguousAlias?.kind === "ambiguous_main_character_alias") {
    throw new Error(
      `Scene ${params.input.sceneNumber} contains ambiguous main-character alias ` +
      `${JSON.stringify(ambiguousAlias.alias)}; use one exact roster name.`,
    );
  }
  const input = castCanonicalization.scene as ScenePromptInput;
  const canonicalNames = new Set(roster.map((character) => character.name.trim()));

  if (canonicalNames.size < 1 || canonicalNames.size > MAX_AGNES_CHARACTER_REFERENCES) {
    throw new Error(
      `Series ${params.input.seriesId} must contain 1-${MAX_AGNES_CHARACTER_REFERENCES} unique main characters for Agnes references.`,
    );
  }

  for (const rawCharacterName of input.characterNames) {
    const characterName = rawCharacterName.replace(/\s+/gu, " ").trim();
    if (!characterName) continue;
    if (!canonicalNames.has(characterName)) {
      throw new Error(
        `Scene ${input.sceneNumber} contains "${characterName}" in characterNames, but that name is not in ` +
        "the fixed series roster. Put guests and secondary creatures in supportingEntities instead.",
      );
    }

    const sheet = await seriesState.getCharacterSheet(input.seriesId, characterName);
    const portrait = sheet?.referenceImagePaths?.portrait;
    const portraitSource = portrait?.publicUrl?.trim();
    if (!sheet?.approvedAt || !portraitSource) {
      throw new Error(
        `Approved public portrait for "${characterName}" is missing. Call ensure_series_character_portraits ` +
        "before authoring or Agnes submission; scene prompting never generates or analyzes portraits.",
      );
    }
    let publicUrl: URL;
    try {
      publicUrl = new URL(portraitSource);
    } catch {
      throw new Error(`Stored public portrait URL for "${characterName}" is invalid.`);
    }
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) {
      throw new Error(`Stored public portrait URL for "${characterName}" must be credential-free HTTPS.`);
    }
    characterNames.push(characterName);
    characterDescriptions.push(characterName);
    characterReferenceSources.push({ name: characterName, source: portraitSource });
  }

  if (characterNames.length > MAX_AGNES_CHARACTER_REFERENCES) {
    throw new Error(
      `Scene ${input.sceneNumber} uses ${characterNames.length} main characters; Agnes supports at most ` +
      `${MAX_AGNES_CHARACTER_REFERENCES} ordered character references.`,
    );
  }

  return {
    characterNames,
    characterDescriptions,
    characterReferenceSources,
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
