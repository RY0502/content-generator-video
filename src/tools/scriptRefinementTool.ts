import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { chatText } from "../providers/aiClient.js";
import {
  DEFAULT_PRODUCTION_MAX_SCENES,
  DEFAULT_PRODUCTION_MIN_SCENES,
  NARRATION_AUTHORING_TARGET_MAX_RAW_CHARACTERS,
  NARRATION_AUTHORING_TARGET_MIN_SPOKEN_WORDS,
  NARRATION_MAX_AUDIO_SECONDS,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
  NARRATION_TARGET_MAX_AUDIO_SECONDS,
  NARRATION_WORDS_PER_MINUTE,
  countNarrationSpokenWords,
  inspectNarrationText,
  minimumNarrationWords,
} from "../services/narrationContract.js";

type CharacterVisualForm = "real_creature" | "humanoid" | "anthropomorphic_creature" | "object_character" | "fantasy_creature";

type SceneCharacterVisual = {
  name: string;
  visualForm: CharacterVisualForm;
  speciesOrType?: string;
  humanoidAllowed?: boolean;
};

export type EpisodeScene = {
  sceneNumber: number;
  narrationText: string;
  environmentDescription: string;
  action: string;
  characterNames: string[];
  characterVisuals?: SceneCharacterVisual[];
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
};

export type EpisodeScript = {
  title: string;
  premise?: string;
  scenes: EpisodeScene[];
};

export type ScriptValidationResult = {
  pass: boolean;
  issues: string[];
};

type RefinementAttemptResult = {
  script: EpisodeScript;
  recoveredFromParseFailure: boolean;
};

type SceneRepairResult = {
  continuityAnchors?: string[];
  supportingEntities?: string[];
  sceneDetails?: string;
};

function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeSupportingEntitiesInput(value: unknown): unknown {
  const parsed = parseJsonArrayInput(value);
  if (!Array.isArray(parsed)) {
    return parsed;
  }

  return parsed
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }

      const candidate = entry as { description?: unknown; name?: unknown; type?: unknown };
      if (typeof candidate.description === "string" && candidate.description.trim()) {
        return candidate.description.trim();
      }
      if (typeof candidate.name === "string" && candidate.name.trim()) {
        const suffix = typeof candidate.type === "string" && candidate.type.trim()
          ? `: ${candidate.type.trim()}`
          : "";
        return `${candidate.name.trim()}${suffix}`;
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

const sceneCharacterVisualSchema = z.object({
  name: z.string(),
  visualForm: z.enum(["real_creature", "humanoid", "anthropomorphic_creature", "object_character", "fantasy_creature"]),
  speciesOrType: z.string().optional(),
  humanoidAllowed: z.boolean().optional(),
  });

const draftSceneSchema = z.object({
  sceneNumber: z.number().optional(),
  narrationText: z.string().optional(),
  environmentDescription: z.string().optional(),
  action: z.string().optional(),
  characterNames: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  characterVisuals: z.preprocess(parseJsonArrayInput, z.array(sceneCharacterVisualSchema)).optional(),
  supportingEntities: z.preprocess(normalizeSupportingEntitiesInput, z.array(z.string())).optional(),
  continuityAnchors: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  sceneDetails: z.string().optional(),
  cameraAngle: z.string().optional(),
  lighting: z.string().optional(),
});

const sceneSchema = z.object({
  sceneNumber: z.number(),
  narrationText: z.string(),
  environmentDescription: z.string(),
  action: z.string(),
  characterNames: z.preprocess(parseJsonArrayInput, z.array(z.string())),
  characterVisuals: z.preprocess(parseJsonArrayInput, z.array(sceneCharacterVisualSchema)).optional(),
  supportingEntities: z.preprocess(normalizeSupportingEntitiesInput, z.array(z.string())).optional(),
  continuityAnchors: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  sceneDetails: z.string().optional(),
  cameraAngle: z.string().optional(),
  lighting: z.string().optional(),
});

const scriptSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.preprocess(parseJsonArrayInput, z.array(sceneSchema)),
});

const draftScriptSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.preprocess(parseJsonArrayInput, z.array(draftSceneSchema)),
});

/**
 * Normalizes draft or refined scripts into the stable scene shape used by validation and repair.
 */
function normalizeSceneNumbers(script: EpisodeScript): EpisodeScript {
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  return {
    ...script,
    scenes: scenes.map((scene, index) => ({
      ...scene,
      sceneNumber: index + 1,
      narrationText: typeof scene.narrationText === "string" ? scene.narrationText.trim() : "",
      environmentDescription: typeof scene.environmentDescription === "string" ? scene.environmentDescription.trim() : "",
      action: typeof scene.action === "string" ? scene.action.trim() : "",
      // Preserve explicitly authored characterNames (including an intentional
      // empty list). Inferring from characterVisuals only when the field is
      // genuinely absent keeps validation able to catch name/visual mismatch.
      characterNames: Array.isArray(scene.characterNames)
        ? scene.characterNames.map((name) => name.trim()).filter(Boolean)
        : Array.isArray(scene.characterVisuals)
          ? scene.characterVisuals.map((item) => item.name.trim()).filter(Boolean)
          : [],
      characterVisuals: Array.isArray(scene.characterVisuals)
        ? scene.characterVisuals.map((item) => ({
            name: item.name.trim(),
            visualForm: item.visualForm,
            speciesOrType: item.speciesOrType?.trim() || undefined,
            humanoidAllowed: item.humanoidAllowed,
          })).filter((item) => item.name)
        : undefined,
      supportingEntities: Array.isArray(scene.supportingEntities) ? scene.supportingEntities : undefined,
      continuityAnchors: Array.isArray(scene.continuityAnchors) ? scene.continuityAnchors : undefined,
    })),
  };
}

function countNarrativeBeats(text: string): number {
  return (text.match(/\b(?:then|next|after|suddenly|but|meanwhile|finally|when)\b/gi) ?? []).length;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasMeaningfulContinuityAnchors(scene: EpisodeScene): boolean {
  return Array.isArray(scene.continuityAnchors) && scene.continuityAnchors.some((anchor) => anchor.trim().length > 0);
}

function hasMeaningfulSupportingEntities(scene: EpisodeScene): boolean {
  return Array.isArray(scene.supportingEntities) && scene.supportingEntities.some((entity) => entity.trim().length > 0);
}

function hasWeakSceneDetails(scene: EpisodeScene): boolean {
  const details = scene.sceneDetails?.trim() ?? "";
  if (!details) return true;
  if (details.length < 60) return true;
  const sentenceLikeParts = details.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (sentenceLikeParts.length >= 2) return false;
  const clauseCount = (details.match(/[,:;]/g) ?? []).length;
  return clauseCount < 3;
}

function hasConsistentCharacterVisuals(scene: EpisodeScene): boolean {
  if (!scene.characterVisuals || scene.characterVisuals.length === 0) return false;
  if (scene.characterVisuals.length !== scene.characterNames.length) return false;
  return scene.characterVisuals.every((item, index) => {
    const expectedName = scene.characterNames[index]?.trim();
    return item.name.trim() === expectedName;
  });
}

function sceneMentionsVisualSetup(scene: EpisodeScene): boolean {
  const combined = `${scene.narrationText} ${scene.action} ${scene.sceneDetails ?? ""}`.toLowerCase();
  return /(lantern|blanket|table|window|door|wagon|basket|prototype|wind-?mill|tool|rope|cup|cookies|apple|leaf|rain|storm|light|glow)/.test(combined);
}

function extractSceneNumbersForTargetedRepair(issues: string[]): number[] {
  const sceneNumbers = new Set<number>();
  for (const issue of issues) {
    if (!issue.includes("continuityAnchors") && !issue.includes("sceneDetails") && !issue.includes("supportingEntities")) continue;
    const match = issue.match(/^Scene\s+(\d+)/i);
    if (match) sceneNumbers.add(Number(match[1]));
  }
  return [...sceneNumbers].sort((a, b) => a - b);
}

function parseSceneRepairResponse(raw: string): SceneRepairResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as SceneRepairResult;
  return {
    continuityAnchors: Array.isArray(parsed.continuityAnchors)
      ? parsed.continuityAnchors.map(String).map((item) => item.trim()).filter(Boolean)
      : undefined,
    supportingEntities: Array.isArray(parsed.supportingEntities)
      ? parsed.supportingEntities.map(String).map((item) => item.trim()).filter(Boolean)
      : undefined,
    sceneDetails: typeof parsed.sceneDetails === "string" ? parsed.sceneDetails.trim() : undefined,
  };
}

async function repairSceneFields(params: {
  scene: EpisodeScene;
  previousScene?: EpisodeScene;
  sameEnvironmentAsPrevious: boolean;
  issues: string[];
}): Promise<SceneRepairResult> {
  const systemPrompt =
    "You repair a single children's storybook scene JSON entry for direct video-generation reliability. " +
    "Return ONLY valid JSON with this exact shape: {\"continuityAnchors\": string[]?, \"supportingEntities\": string[]?, \"sceneDetails\": string?}. " +
    "Do not rewrite narrationText, environmentDescription, action, characterNames, cameraAngle, or lighting. " +
    "Your job is ONLY to repair continuityAnchors, supportingEntities, and/or sceneDetails. " +
    "If supportingEntities are needed (e.g. secondary guest characters, guides, scribes, or baby animals mentioned in the action/narration or continuing from previous scenes), include them with locked exact visual descriptions. " +
    "If continuityAnchors are needed, make them explicit, drawable, and reusable across adjacent scenes using concrete details like color, pattern, material, shape, size, placement, and current state. " +
    "If sceneDetails are weak, rewrite them into a vivid single-moment visual description that clearly places the required characters and props in the frame. " +
    "Ensure sceneDetails and props strictly respect each character's canonical wardrobe — do not invent unapproved hats, bags, clothing, or accessories for characters who do not have them. " +
    "Preserve continuity of recurring supportingEntities and continuityAnchors from the previous scene when they continue in the story. " +
    "If the environment changed, do NOT carry forward previous continuityAnchors unless the current scene explicitly preserves a moved/shared object or setup. " +
    "Return one JSON object only, no markdown and no commentary.";

  const userText =
    `Target scene JSON:\n${JSON.stringify(params.scene)}\n\n` +
    `Previous scene JSON:\n${JSON.stringify(params.previousScene ?? null)}\n\n` +
    `Same environment as previous scene: ${params.sameEnvironmentAsPrevious ? "yes" : "no"}\n\n` +
    `Issues to fix:\n- ${params.issues.join("\n- ")}\n\n` +
    `Repair only continuityAnchors, supportingEntities, and sceneDetails for the target scene. ` +
    (params.sameEnvironmentAsPrevious
      ? `If the previous scene contains reusable continuityAnchors or supportingEntities for continuing figures/setups, carry them forward and adapt only if the current narration/action clearly changes their state.`
      : `Because the environment changed, generate continuityAnchors from the current scene itself unless the current narration/action explicitly preserves a moved/shared object, guide, or setup from the previous scene.`);

  const raw = await chatText({
    systemPrompt,
    userText,
  });

  try {
    return parseSceneRepairResponse(raw);
  } catch {
    const retryRaw = await chatText({
      systemPrompt:
        systemPrompt +
        " Your previous response was not valid JSON. Output a single valid JSON object only.",
      userText:
        `${userText}\n\n` +
        `Your previous invalid response was:\n${raw}\n\n` +
        `Now return only the corrected JSON object.`,
    });
    return parseSceneRepairResponse(retryRaw);
  }
}

async function repairTargetedScenes(script: EpisodeScript, issues: string[]): Promise<EpisodeScript> {
  const sceneNumbers = extractSceneNumbersForTargetedRepair(issues);
  if (sceneNumbers.length === 0) return script;

  const repairedScenes = [...script.scenes];
  for (const sceneNumber of sceneNumbers) {
    const sceneIndex = sceneNumber - 1;
    const scene = repairedScenes[sceneIndex];
    if (!scene) continue;

    const sceneIssues = issues.filter((issue) => issue.startsWith(`Scene ${sceneNumber} `));
    const previousScene = sceneIndex > 0 ? repairedScenes[sceneIndex - 1] : undefined;
    const sameEnvironmentAsPrevious = previousScene
      ? normalizeText(previousScene.environmentDescription) === normalizeText(scene.environmentDescription)
      : false;
    const repairedFields = await repairSceneFields({
      scene,
      previousScene,
      sameEnvironmentAsPrevious,
      issues: sceneIssues,
    });

    repairedScenes[sceneIndex] = {
      ...scene,
      continuityAnchors: repairedFields.continuityAnchors ?? scene.continuityAnchors,
      supportingEntities: repairedFields.supportingEntities ?? scene.supportingEntities,
      sceneDetails: repairedFields.sceneDetails ?? scene.sceneDetails,
    };
  }

  return {
    ...script,
    scenes: repairedScenes,
  };
}

export function validateEpisodeScript(
  script: EpisodeScript,
  minScenes: number,
  maxScenes: number,
  targetRuntimeMinutes = 5,
  mainCharacterNames?: readonly string[],
): ScriptValidationResult {
  const issues: string[] = [];
  if (script.scenes.length < minScenes) {
    issues.push(`Scene count too low: ${script.scenes.length}. Minimum required is ${minScenes}.`);
  }
  if (script.scenes.length > maxScenes) {
    issues.push(`Scene count too high: ${script.scenes.length}. Maximum allowed is ${maxScenes}.`);
  }

  // Runtime and word count checks apply only to full production episodes so
  // small fixtures/manual previews can still validate a deliberately tiny set.
  const isFullProduction = minScenes >= 15;
  const canonicalCast = mainCharacterNames
    ? new Set(mainCharacterNames.map((name) => name.trim()).filter(Boolean))
    : null;
  if (isFullProduction && (!canonicalCast || canonicalCast.size === 0)) {
    issues.push(
      "Production refinement requires mainCharacterNames from the fixed Turso roster so guests cannot leak into characterNames."
    );
  }
  const minRequiredWords = isFullProduction ? minimumNarrationWords(targetRuntimeMinutes) : 0;
  const totalWords = script.scenes.reduce((sum, sc) => {
    return sum + countNarrationSpokenWords(sc.narrationText ?? "");
  }, 0);

  if (isFullProduction && maxScenes * NARRATION_MAX_SPOKEN_WORDS < minRequiredWords) {
    issues.push(
      `Configured scene range cannot satisfy the narration runtime contract: at most ${maxScenes} scenes ` +
      `with ${NARRATION_MAX_SPOKEN_WORDS} spoken words each cannot reach the required ${minRequiredWords} words.`
    );
  }
  if (isFullProduction && totalWords < minRequiredWords) {
    const estRuntime = (totalWords / NARRATION_WORDS_PER_MINUTE).toFixed(1);
    issues.push(
      `Total episode narration word count too low: ${totalWords} spoken words (~${estRuntime} minutes). ` +
      `Minimum required for a ${targetRuntimeMinutes}-minute episode is ${minRequiredWords} words. ` +
      `Add meaningful visual beats instead of making any scene exceed ${NARRATION_MAX_SPOKEN_WORDS} spoken words.`
    );
  }

  const sceneBeatBySignature = new Map<string, number>();
  script.scenes.forEach((scene, index) => {
    const label = `Scene ${index + 1}`;
    if (!scene.environmentDescription.trim()) {
      issues.push(`${label} is missing environmentDescription.`);
    }
    if (!scene.action.trim()) {
      issues.push(`${label} is missing action.`);
    }
    const beatSignature = JSON.stringify([
      normalizeText(scene.environmentDescription),
      normalizeText(scene.action),
      normalizeText(scene.sceneDetails),
      normalizeText(scene.narrationText),
    ]);
    if (
      scene.environmentDescription.trim()
      && scene.action.trim()
      && scene.sceneDetails?.trim()
      && scene.narrationText.trim()
    ) {
      const duplicateOf = sceneBeatBySignature.get(beatSignature);
      if (duplicateOf !== undefined) {
        issues.push(
          `${label} duplicates the complete narration/action beat from Scene ${duplicateOf}; ` +
          "write a genuinely distinct visible beat instead of renumbering repeated content."
        );
      } else {
        sceneBeatBySignature.set(beatSignature, index + 1);
      }
    }
    if (isFullProduction && !scene.sceneDetails?.trim()) {
      issues.push(`${label} is missing sceneDetails required for direct video generation.`);
    }
    if (isFullProduction && !scene.cameraAngle?.trim()) {
      issues.push(`${label} is missing cameraAngle required for direct video generation.`);
    }
    if (isFullProduction && !scene.lighting?.trim()) {
      issues.push(`${label} is missing lighting required for direct video generation.`);
    }
    const narrationInspection = inspectNarrationText(scene.narrationText, { production: isFullProduction });
    if (!scene.narrationText.trim()) {
      issues.push(`${label} is missing narrationText.`);
    } else {
      if (narrationInspection.issues.some((issue) => issue.code === "too_many_raw_characters")) {
        issues.push(
          `${label} narrationText has ${narrationInspection.rawCharacterCount} raw characters and exceeds ` +
          `the ${NARRATION_MAX_RAW_CHARACTERS}-character one-request Groq limit; split it into consecutive scenes.`
        );
      }
      if (narrationInspection.issues.some((issue) => issue.code === "too_many_spoken_words")) {
        issues.push(
          `${label} narrationText has ${narrationInspection.spokenWordCount} spoken words; the production ` +
          `maximum is ${NARRATION_MAX_SPOKEN_WORDS} so one Groq narration can fit one ` +
          `${NARRATION_MAX_AUDIO_SECONDS}-second Agnes scene. Split it into consecutive scenes.`
        );
      }
    }
    if (!Array.isArray(scene.characterNames)) {
      issues.push(`${label} is missing characterNames.`);
    } else if (isFullProduction && !Array.isArray(scene.characterVisuals)) {
      issues.push(`${label} must include characterVisuals aligned 1:1 with characterNames (use [] when empty).`);
    } else if (scene.characterNames.length > 0 && !hasConsistentCharacterVisuals(scene)) {
      issues.push(`${label} must include characterVisuals entries matching characterNames in order, with explicit visualForm metadata for each character.`);
    } else if (Array.isArray(scene.characterVisuals) && scene.characterVisuals.length !== scene.characterNames.length) {
      issues.push(`${label} characterVisuals must align 1:1 with characterNames.`);
    }
    if (canonicalCast) {
      const unknownNames = scene.characterNames.filter((name) => !canonicalCast.has(name.trim()));
      if (unknownNames.length > 0) {
        issues.push(
          `${label} characterNames contains non-roster names: ${unknownNames.join(", ")}. ` +
          "Put guests and secondary creatures in supportingEntities."
        );
      }
    }
    if (countNarrativeBeats(scene.narrationText) >= 2) {
      issues.push(`${label} narration appears overloaded with multiple beats and should be split.`);
    }
    const previousScene = index > 0 ? script.scenes[index - 1] : null;
    const sameEnvironmentAsPrevious = previousScene
      ? normalizeText(previousScene.environmentDescription) === normalizeText(scene.environmentDescription)
      : false;
    if (sameEnvironmentAsPrevious && !hasMeaningfulContinuityAnchors(scene)) {
      issues.push(`${label} continues the same setup/location as the previous scene but is missing continuityAnchors.`);
    }
    if (previousScene && hasMeaningfulSupportingEntities(previousScene) && !hasMeaningfulSupportingEntities(scene)) {
      const combined = `${scene.narrationText} ${scene.action} ${scene.sceneDetails ?? ""}`.toLowerCase();
      if (previousScene.supportingEntities!.some((e) => {
        const namePart = e.split(":")[0]?.toLowerCase().trim();
        return namePart && namePart.length > 2 && combined.includes(namePart);
      })) {
        issues.push(`${label} continues interacting with supporting entities from the previous scene but is missing supportingEntities.`);
      }
    }

    const requiresRicherSceneDetails = scene.characterNames.length >= 4 || (scene.characterNames.length > 0 && sceneMentionsVisualSetup(scene));
    if (requiresRicherSceneDetails && hasWeakSceneDetails(scene)) {
      issues.push(`${label} needs richer sceneDetails for reliable video generation because it has a complex cast or important visual setup.`);
    }
  });

  return { pass: issues.length === 0, issues };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1).trim();
  }

  return trimmed;
}

function parseScriptResponse(raw: string): EpisodeScript {
  const parsed = scriptSchema.parse(JSON.parse(extractJsonObject(raw)));
  return normalizeSceneNumbers(parsed);
}

async function rewriteScript(params: {
  script: EpisodeScript;
  minScenes: number;
  maxScenes: number;
  targetRuntimeMinutes: number;
  mainCharacterNames?: readonly string[];
  issues?: string[];
  mode: "review" | "repair";
}): Promise<RefinementAttemptResult> {
  const requiredWords = minimumNarrationWords(params.targetRuntimeMinutes);
  const baseSystemPrompt =
    "You refine children's episodic scene scripts for one-scene/one-video generation. " +
    "Return ONLY valid JSON matching this shape: {\"title\": string, \"premise\": string?, \"scenes\": [{\"sceneNumber\": number, \"narrationText\": string, \"environmentDescription\": string, \"action\": string, \"characterNames\": string[], \"characterVisuals\": [{\"name\": string, \"visualForm\": \"real_creature\"|\"humanoid\"|\"anthropomorphic_creature\"|\"object_character\"|\"fantasy_creature\", \"speciesOrType\": string?, \"humanoidAllowed\": boolean?}], \"supportingEntities\": string[]?, \"continuityAnchors\": string[]?, \"sceneDetails\": string, \"cameraAngle\": string, \"lighting\": string}]}. " +
    `ONE SCENE = ONE AUDIO = ONE VIDEO (CRITICAL): Keep exactly one visible beat per scene. Each narrationText must be one or two concise sentences, no more than ${NARRATION_MAX_RAW_CHARACTERS} raw characters including vocal directions, and no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words. Aim for ${NARRATION_AUTHORING_TARGET_MIN_SPOKEN_WORDS}-${NARRATION_MAX_SPOKEN_WORDS} spoken words and no more than ${NARRATION_AUTHORING_TARGET_MAX_RAW_CHARACTERS} raw characters so the measured Groq narration normally lands around 7-${NARRATION_TARGET_MAX_AUDIO_SECONDS} seconds and never requires two Agnes clips. ` +
    "Split scenes when a narration paragraph contains multiple visible moments, action changes, emotional turns, time jumps, or too much speech for one clip. Never duplicate or lightly renumber the same narration/action beat to reach the scene or runtime target. " +
    `TOTAL RUNTIME & WORD COUNT DISCIPLINE (CRITICAL): The episode must reach at least ${params.targetRuntimeMinutes} minutes and ${requiredWords} total spoken words across ${params.minScenes}-${params.maxScenes} concise scenes. Add meaningful consecutive visual beats; never lengthen an individual narration beyond the per-scene limits. ` +
    "SPLIT-METADATA PRESERVATION (CRITICAL): When splitting one source scene into consecutive child scenes, preserve its environmentDescription verbatim while the location is unchanged. Preserve each character's exact characterVisuals entry and keep it aligned with characterNames. Copy every supportingEntities descriptor verbatim into each child where that entity remains present or interacting. Copy continuityAnchors verbatim through all children until the narration explicitly changes that visual state; after a state change, create one concrete replacement anchor and carry that exact replacement forward. Divide action and sceneDetails into one clear visible sub-action and emotion per child. Preserve cameraAngle and lighting unless the new visible beat deliberately requires a change. " +
    "Preserve the story, characters, tone, and continuity. Expand by splitting overloaded scenes rather than inventing filler. " +
    "Use full character names. Keep narration warm, vivid, and suitable for ages 2-5. " +
    "CRITICAL CAST DISCIPLINE: characterNames must ONLY contain the main series characters present in that scene. Do NOT invent new character names in characterNames. Any secondary/extra creature or background animal (e.g. baby duck, butterfly, bird) must be placed in supportingEntities (e.g. ['Baby duck: tiny yellow duckling with orange bill']) or described in narrationText/action, never in characterNames. " +
    "WARDROBE & ACCESSORY CONTINUITY (CRITICAL): Characters must strictly maintain their canonical appearance and wardrobe across all scenes. Never describe characters acquiring, wearing, or carrying unapproved clothing, hats, sunhats, dresses, shirts, shoes, bags, satchels, or glasses in narrationText, action, or sceneDetails unless explicitly defined in their canonical character description or introduced as an explicit episodic plot prop. " +
    "SUPPORTING ENTITY CONTINUITY (CRITICAL): When an episode features guest characters, guides, scribes, baby animals, or secondary recurring figures, define them in supportingEntities with locked visual descriptions (e.g. ['Cleo the Scribe: young Egyptian girl with straight black hair, white linen tunic, blue beaded collar, holding a tablet']). Carry that EXACT supportingEntities descriptor forward across EVERY scene where that guest figure appears or interacts with the group. Never drop supportingEntities from intermediate scenes. " +
    "OBJECT CHARACTERS & COMPANIONS (CRITICAL): When an object character (e.g. a living backpack, talking clock, animated toy, companion item) is in the scene, always refer to it consistently by its character name. Avoid ambiguous phrasing that implies both a generic personal possession and a separate character in the same sentence (e.g., write 'Tara zipped up Bobo and gave him a pat' instead of 'Tara zipped up her backpack and gave Bobo a pat') to prevent the video model from creating two separate items in the scene. " +
    "For every scene, include characterVisuals for every character in the same order as characterNames. characterVisuals is mandatory; output [] when characterNames is empty. sceneDetails, cameraAngle, and lighting are also mandatory and non-empty. " +
    "Use visualForm to explicitly define body ontology so the video model does not guess: real_creature, humanoid, anthropomorphic_creature, object_character, or fantasy_creature. " +
    "Use speciesOrType when helpful, such as 'butterfly', 'sparrow', 'little girl', 'talking teapot', or 'dragon'. " +
    "Set humanoidAllowed to false for real animals/insects/birds that must not become humanoid, and true only when a humanoid body plan is intentionally allowed by the story. " +
    "When a prop, layout, setup, or visual state continues across adjacent scenes, use continuityAnchors to carry that continuity explicitly. " +
    "Each continuityAnchors entry must be a short exact visual descriptor that includes concrete appearance details whenever applicable: color, pattern, material, shape, size, placement, and current state/change. " +
    "Good example: 'Picnic setup: red-and-white checkered blanket spread flat on green grass with three round yellow apple slices, two brown cookies, and pale green leaf cups near the top edge.' " +
    "Reuse the exact same continuityAnchors strings across continuing scenes. Only remove or replace an anchor when the narration clearly changes or removes that setup.";

  const baseUserText =
    `Mode: ${params.mode}\n` +
    `Target scene count: ${params.minScenes}-${params.maxScenes}\n` +
    `Target runtime: at least ${params.targetRuntimeMinutes} minutes (minimum ${requiredWords} total spoken words)\n` +
    `Per-scene narration contract: 1-2 sentences, <=${NARRATION_MAX_RAW_CHARACTERS} raw characters, <=${NARRATION_MAX_SPOKEN_WORDS} spoken words, authored for <=${NARRATION_MAX_AUDIO_SECONDS} seconds of measured Groq audio.\n` +
    `Fixed main-character roster (characterNames may contain ONLY these exact names): ${JSON.stringify(params.mainCharacterNames ?? [])}\n` +
    (params.issues && params.issues.length > 0 ? `Deterministic issues to fix:\n- ${params.issues.join("\n- ")}\n\n` : "") +
    `Current script JSON:\n${JSON.stringify(params.script)}\n\n` +
    `Task: Review this episode and refine it so the final result lands in the target scene range, uses one visual beat and one bounded narration per scene, and preserves the complete story by splitting overloaded scenes into smaller consecutive scenes. ` +
    `Also ensure every scene contains characterVisuals entries aligned 1:1 with characterNames so each character's visual ontology is explicit instead of inferred. ` +
    `For every split, preserve the source environmentDescription, exact characterVisuals entries, supportingEntities descriptors, continuityAnchors, cameraAngle, and lighting according to the split-metadata rules above; rewrite only what must change to express each child's visible sub-action. ` +
    `Also add or preserve continuityAnchors whenever a visual setup should continue across adjacent scenes. Make every continuity anchor concretely drawable by explicitly naming visual attributes like color, pattern, material, shape, placement, and current state when relevant, and ensure recurring guest figures or secondary characters have their supportingEntities descriptor preserved across all scenes where they appear. Return the full updated JSON only.`;

  const raw = await chatText({
    systemPrompt: baseSystemPrompt,
    userText: baseUserText,
  });

  try {
    return {
      script: parseScriptResponse(raw),
      recoveredFromParseFailure: false,
    };
  } catch {
    const repairRaw = await chatText({
      systemPrompt:
        baseSystemPrompt +
        " Your previous response was not valid JSON. Do not explain anything. Do not include markdown fences. Output a single valid JSON object only.",
      userText:
        `${baseUserText}\n\n` +
        `Your previous invalid response was:\n${raw}\n\n` +
        `Now rewrite it as one valid JSON object only.`,
    });

    return {
      script: parseScriptResponse(repairRaw),
      recoveredFromParseFailure: true,
    };
  }
}

export function buildScriptRefinementTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "refine_episode_script",
    description:
      "Refines an initially drafted episode into one-scene/one-audio/one-video units. It splits overloaded " +
      `narration into <=${NARRATION_MAX_RAW_CHARACTERS} raw characters and <=${NARRATION_MAX_SPOKEN_WORDS} spoken words per production scene, ` +
      "locks characterNames to the supplied fixed roster, preserves scene continuity metadata, validates total runtime, and returns scriptJson only when the " +
      "production contract passes. Call this before saving script_json.",
    schema: z.object({
      scriptJson: z.preprocess(
        (value) => {
          if (typeof value !== "string") return value;
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        },
        draftScriptSchema
      ),
      minScenes: z.number().int().positive().default(DEFAULT_PRODUCTION_MIN_SCENES),
      maxScenes: z.number().int().positive().default(DEFAULT_PRODUCTION_MAX_SCENES),
      targetRuntimeMinutes: z.number().positive().default(5),
      mainCharacterNames: z.preprocess(
        parseJsonArrayInput,
        z.array(z.string().trim().min(1)).min(1),
      ).optional().describe(
        "The exact fixed main-character names returned by get_or_create_series. Required for production refinement.",
      ),
    }),
    func: async ({ scriptJson, minScenes, maxScenes, targetRuntimeMinutes, mainCharacterNames }) => {
      const normalizedInput = typeof scriptJson === "string"
        ? (JSON.parse(scriptJson) as EpisodeScript)
        : (scriptJson as EpisodeScript);
      const sourceScript = normalizeSceneNumbers(normalizedInput);
      let refined = sourceScript;
      const warnings: string[] = [];

      try {
        const reviewResult = await rewriteScript({
          script: sourceScript,
          minScenes,
          maxScenes,
          targetRuntimeMinutes,
          mainCharacterNames,
          mode: "review",
        });
        refined = reviewResult.script;
        if (reviewResult.recoveredFromParseFailure) {
          warnings.push("Initial refinement response was invalid JSON and required one strict repair retry.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Script refinement failed; using original drafted script. Cause: ${message}`);
      }

      const validation = validateEpisodeScript(
        refined,
        minScenes,
        maxScenes,
        targetRuntimeMinutes,
        mainCharacterNames,
      );
      if (!validation.pass) {
        try {
          refined = await repairTargetedScenes(refined, validation.issues);
          const targetedValidation = validateEpisodeScript(
            refined,
            minScenes,
            maxScenes,
            targetRuntimeMinutes,
            mainCharacterNames,
          );
          if (targetedValidation.pass) {
            return JSON.stringify({
              status: "ready",
              scriptJson: refined,
              validation: targetedValidation,
              warnings,
            });
          }

          const repairResult = await rewriteScript({
            script: refined,
            minScenes,
            maxScenes,
            targetRuntimeMinutes,
            mainCharacterNames,
            issues: targetedValidation.issues,
            mode: "repair",
          });
          refined = repairResult.script;
          if (repairResult.recoveredFromParseFailure) {
            warnings.push("Repair refinement response was invalid JSON and required one strict repair retry.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Repair pass failed; keeping last valid script. Cause: ${message}`);
        }
      }

      const finalValidation = validateEpisodeScript(
        refined,
        minScenes,
        maxScenes,
        targetRuntimeMinutes,
        mainCharacterNames,
      );
      if (minScenes >= 15 && !finalValidation.pass) {
        return JSON.stringify({
          status: "needs_repair",
          validation: finalValidation,
          warnings: [
            ...warnings,
            "No scriptJson was returned because the final production narration contract did not pass.",
          ],
        });
      }
      return JSON.stringify({
        status: finalValidation.pass ? "ready" : "invalid_fixture",
        scriptJson: refined,
        validation: finalValidation,
        warnings,
      });
    },
  });
}
