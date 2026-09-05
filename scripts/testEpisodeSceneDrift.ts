import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import { chatText } from "../src/providers/aiClient.js";
import { SeriesState, type CharacterDef } from "../src/state/seriesState.js";
import { buildSceneImageTool } from "../src/tools/sceneImageTool.js";
import { ensureCharacterSheet } from "../src/services/characterSheetService.js";
import { assertLegacyImageFlowOptIn } from "./legacyImageFlowGuard.js";

type CharacterVisualForm = "real_creature" | "humanoid" | "anthropomorphic_creature" | "object_character" | "fantasy_creature";

type SceneCharacterVisual = {
  name: string;
  visualForm: CharacterVisualForm;
  speciesOrType?: string;
  humanoidAllowed?: boolean;
};

type EpisodeScene = {
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

type EpisodeScript = {
  title: string;
  premise?: string;
  scenes: EpisodeScene[];
};

type ManifestEpisode = {
  episodeNumber: number;
  title: string;
  processedScenes: number[];
  completed: boolean;
};

type Manifest = {
  seriesId: number;
  startEpisode: number;
  endEpisode: number;
  sceneLimit: number;
  episodes: ManifestEpisode[];
};

const SERIES_ID = 13;
const START_EPISODE = 3;
const EPISODE_COUNT = 4;
const SCENE_LIMIT = 10;
const MANIFEST_PATH = path.resolve("output/series_13/episode_scene_drift_manifest.json");

function normalizeSupportingEntity(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { description?: unknown; name?: unknown; type?: unknown };
  if (typeof candidate.description === "string" && candidate.description.trim()) {
    return candidate.description.trim();
  }
  if (typeof candidate.name === "string" && candidate.name.trim()) {
    const suffix = typeof candidate.type === "string" && candidate.type.trim() ? `: ${candidate.type.trim()}` : "";
    return `${candidate.name.trim()}${suffix}`;
  }
  return null;
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

function parseJsonObject<T>(raw: string): T {
  return JSON.parse(extractJsonObject(raw)) as T;
}

async function parseDraftSceneResponse(raw: string): Promise<EpisodeScene> {
  try {
    const parsed = parseJsonObject<Partial<EpisodeScene>>(raw);
    const normalizedScene = normalizeScript({
      title: "Draft Scene",
      scenes: [parsed],
    }).scenes[0]!;
    return {
      ...normalizedScene,
      sceneDetails: normalizedScene.sceneDetails,
      cameraAngle: normalizedScene.cameraAngle,
      lighting: normalizedScene.lighting,
    };
  } catch {
    const repaired = await chatText({
      systemPrompt:
        "You repair malformed children's story scene JSON. " +
        "Return ONLY one valid JSON object matching this shape: {\"sceneNumber\": number, \"narrationText\": string, \"environmentDescription\": string, \"action\": string, \"characterNames\": string[], \"characterVisuals\": [{\"name\": string, \"visualForm\": \"real_creature\"|\"humanoid\"|\"anthropomorphic_creature\"|\"object_character\"|\"fantasy_creature\", \"speciesOrType\": string?, \"humanoidAllowed\": boolean?}]?, \"supportingEntities\": string[]?, \"continuityAnchors\": string[]?}. " +
        "Do not include markdown fences or explanations. Fix syntax only and ensure the final output is strict valid JSON.",
      userText:
        `Rewrite this malformed scene response as one valid JSON object only:\n${raw}`,
    });
    try {
      const parsed = parseJsonObject<Partial<EpisodeScene>>(repaired);
      const normalizedScene = normalizeScript({
        title: "Draft Scene",
        scenes: [parsed],
      }).scenes[0]!;
      return {
        ...normalizedScene,
        sceneDetails: normalizedScene.sceneDetails,
        cameraAngle: normalizedScene.cameraAngle,
        lighting: normalizedScene.lighting,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse drafted scene even after repair: ${message}\nRepaired payload:\n${repaired}`);
    }
  }
}

function normalizeScript(raw: unknown): EpisodeScript {
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw;
  const candidate = parsed as Partial<EpisodeScript>;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.scenes)) {
    throw new Error("Episode script_json is missing or malformed.");
  }

  return {
    title: typeof candidate.title === "string" ? candidate.title : "Untitled",
    premise: typeof candidate.premise === "string" ? candidate.premise : undefined,
    scenes: candidate.scenes.map((scene, index) => {
      const item = scene as Partial<EpisodeScene>;
      const characterVisuals = Array.isArray(item.characterVisuals)
        ? item.characterVisuals.map((visual) => ({
            name: String((visual as SceneCharacterVisual).name ?? "").trim(),
            visualForm: (visual as SceneCharacterVisual).visualForm,
            speciesOrType: (visual as SceneCharacterVisual).speciesOrType?.trim() || undefined,
            humanoidAllowed: (visual as SceneCharacterVisual).humanoidAllowed,
          })).filter((visual) => visual.name)
        : undefined;
      const characterNames = characterVisuals && characterVisuals.length > 0
        ? characterVisuals.map((visual) => visual.name)
        : Array.isArray(item.characterNames)
          ? item.characterNames.map((name) => String(name).trim()).filter(Boolean)
          : [];
      return {
        sceneNumber: typeof item.sceneNumber === "number" ? item.sceneNumber : index + 1,
        narrationText: String(item.narrationText ?? "").trim(),
        environmentDescription: String(item.environmentDescription ?? "").trim(),
        action: String(item.action ?? "").trim(),
        characterNames,
        characterVisuals,
        supportingEntities: Array.isArray(item.supportingEntities)
          ? item.supportingEntities
            .map((entry) => normalizeSupportingEntity(entry))
            .filter((entry): entry is string => Boolean(entry))
          : undefined,
        continuityAnchors: Array.isArray(item.continuityAnchors) ? item.continuityAnchors.map(String) : undefined,
        sceneDetails: typeof item.sceneDetails === "string" ? item.sceneDetails : undefined,
        cameraAngle: typeof item.cameraAngle === "string" ? item.cameraAngle : undefined,
        lighting: typeof item.lighting === "string" ? item.lighting : undefined,
      };
    }),
  };
}

function findRosterCharacter(roster: CharacterDef[], characterName: string): CharacterDef | undefined {
  const normalized = characterName.toLowerCase().trim();
  return roster.find((character) => character.name.toLowerCase().trim() === normalized);
}

async function draftEpisodeScene(params: {
  title: string;
  premise: string;
  roster: CharacterDef[];
  sceneNumber: number;
  previousScenes: EpisodeScene[];
}): Promise<EpisodeScene> {
  const rosterText = params.roster
    .map((character) => `- ${character.name}: ${character.description}`)
    .join("\n");

  const raw = await chatText({
    systemPrompt:
      "You draft one children's story episode scene as JSON for an image-generation pipeline. " +
      "Return ONLY valid JSON matching this shape: {\"sceneNumber\": number, \"narrationText\": string, \"environmentDescription\": string, \"action\": string, \"characterNames\": string[], \"characterVisuals\": [{\"name\": string, \"visualForm\": \"real_creature\"|\"humanoid\"|\"anthropomorphic_creature\"|\"object_character\"|\"fantasy_creature\", \"speciesOrType\": string?, \"humanoidAllowed\": boolean?}]?, \"supportingEntities\": string[]?, \"continuityAnchors\": string[]?}. " +
      "Return exactly one scene object only, not an array and not a wrapper object. Keep one clear visual beat, full character names, and explicit characterVisuals in the same order as characterNames. Omit sceneDetails, cameraAngle, and lighting unless absolutely necessary.",
    userText:
      `Series roster:\n${rosterText}\n\n` +
      `Episode title: ${params.title}\n` +
      `Episode premise: ${params.premise}\n\n` +
      `Target scene number: ${params.sceneNumber} of ${SCENE_LIMIT}.\n` +
      `Previously drafted scenes JSON:\n${JSON.stringify(params.previousScenes)}\n\n` +
      `Draft only scene ${params.sceneNumber} for a drift test, suitable for ages 2-5. Keep one clear image moment. Include vivid narration, concrete environment, action, continuity anchors when relevant, and explicit characterVisuals. Preserve continuity with the previous scenes. Keep the response minimal. Return exactly one scene object only.`,
  });

  return parseDraftSceneResponse(raw);
}

async function draftEpisodeScript(params: {
  title: string;
  premise: string;
  roster: CharacterDef[];
}): Promise<EpisodeScript> {
  const scenes: EpisodeScene[] = [];
  for (let sceneNumber = 1; sceneNumber <= SCENE_LIMIT; sceneNumber++) {
    const scene = await draftEpisodeScene({
      title: params.title,
      premise: params.premise,
      roster: params.roster,
      sceneNumber,
      previousScenes: scenes,
    });
    scenes.push({
      ...scene,
      sceneNumber,
    });
  }

  return {
    title: params.title,
    premise: params.premise,
    scenes,
  };
}

async function loadManifest(): Promise<Manifest> {
  if (!existsSync(MANIFEST_PATH)) {
    return {
      seriesId: SERIES_ID,
      startEpisode: START_EPISODE,
      endEpisode: START_EPISODE + EPISODE_COUNT - 1,
      sceneLimit: SCENE_LIMIT,
      episodes: [],
    };
  }

  const raw = await readFile(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

async function saveManifest(manifest: Manifest): Promise<void> {
  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
}

async function main(): Promise<void> {
  assertLegacyImageFlowOptIn(
    "testEpisodeSceneDrift.ts",
    "historical multi-episode script drafting and scene-image drift diagnostics",
  );
  const seriesState = new SeriesState();

  try {
    const roster = await seriesState.getSeriesCharacters(SERIES_ID);
    const sceneTool = buildSceneImageTool(seriesState);
    const sceneToolFunc = (sceneTool as { func: (input: unknown) => Promise<string> }).func;
    const manifest = await loadManifest();

    for (let episodeNumber = START_EPISODE; episodeNumber < START_EPISODE + EPISODE_COUNT; episodeNumber++) {
      const clientAny = (seriesState as unknown as { client: { execute: (input: { sql: string; args: unknown[] }) => Promise<{ rows: Array<Record<string, unknown>> }> } }).client;
      const episodeRes = await clientAny.execute({
        sql: "SELECT id, title, premise, script_json FROM episodes WHERE series_id = ? AND episode_number = ? LIMIT 1",
        args: [SERIES_ID, episodeNumber],
      });
      const episodeRow = episodeRes.rows[0];
      if (!episodeRow) {
        throw new Error(`Episode ${episodeNumber} not found for series ${SERIES_ID}.`);
      }
      if (!episodeRow.script_json) {
        const title = String(episodeRow.title ?? `Episode ${episodeNumber}`);
        const premise = String(episodeRow.premise ?? "").trim();
        if (!premise) {
          throw new Error(`Episode ${episodeNumber} is missing a premise, so a script cannot be drafted.`);
        }

        console.log(`[scene-drift-test] Drafting missing script for episode ${episodeNumber}: ${title}`);
        const draftedScript = await draftEpisodeScript({ title, premise, roster });
        await seriesState.updateEpisodeStatus(Number(episodeRow.id), "script", { scriptJson: draftedScript });
        episodeRow.script_json = draftedScript;
        console.log(`[scene-drift-test] Saved test-sized script for episode ${episodeNumber}`);
      }

      const script = normalizeScript(episodeRow.script_json);
      const targetScenes = script.scenes.slice(0, SCENE_LIMIT);
      console.log(`[scene-drift-test] Episode ${episodeNumber}: ${script.title} -> target ${targetScenes.length} scenes`);

      for (const scene of targetScenes) {
        for (const characterName of scene.characterNames) {
          const rosterCharacter = findRosterCharacter(roster, characterName);
          if (!rosterCharacter) continue;
          const characterVisual = scene.characterVisuals?.find((item) => item.name.trim() === characterName.trim());
          await ensureCharacterSheet({
            seriesState,
            seriesId: SERIES_ID,
            characterName: rosterCharacter.name,
            characterDescription: rosterCharacter.description,
            characterVisual,
          });
        }

        const scenePath = path.join(
          CONFIG.outputDir,
          `series_${SERIES_ID}`,
          `episode_${episodeNumber}`,
          "scenes",
          `scene_${String(scene.sceneNumber).padStart(3, "0")}.png`,
        );
        if (existsSync(scenePath)) {
          console.log(`[scene-drift-test] Reusing existing scene ${episodeNumber}:${scene.sceneNumber}`);
        } else {
          await sceneToolFunc({
            seriesId: SERIES_ID,
            episodeNumber,
            sceneNumber: scene.sceneNumber,
            characterNames: scene.characterNames,
            characterVisuals: scene.characterVisuals,
            environmentDescription: scene.environmentDescription,
            narrationText: scene.narrationText,
            action: scene.action,
            cameraAngle: scene.cameraAngle ?? "medium",
            lighting: scene.lighting ?? "soft warm daylight",
            supportingEntities: scene.supportingEntities,
            continuityAnchors: scene.continuityAnchors,
            sceneDetails: scene.sceneDetails,
          });
          console.log(`[scene-drift-test] Generated scene ${episodeNumber}:${scene.sceneNumber}`);
        }

        const episodeManifest = manifest.episodes.find((item) => item.episodeNumber === episodeNumber);
        if (episodeManifest) {
          if (!episodeManifest.processedScenes.includes(scene.sceneNumber)) {
            episodeManifest.processedScenes.push(scene.sceneNumber);
            episodeManifest.processedScenes.sort((a, b) => a - b);
          }
          episodeManifest.completed = episodeManifest.processedScenes.length >= targetScenes.length;
        } else {
          manifest.episodes.push({
            episodeNumber,
            title: script.title,
            processedScenes: [scene.sceneNumber],
            completed: targetScenes.length === 1,
          });
        }
        await saveManifest(manifest);
      }

      const episodeManifest = manifest.episodes.find((item) => item.episodeNumber === episodeNumber);
      if (episodeManifest) {
        episodeManifest.title = script.title;
        episodeManifest.completed = episodeManifest.processedScenes.length >= targetScenes.length;
      }
      await saveManifest(manifest);
    }

    console.log(`[scene-drift-test] Complete. Manifest: ${MANIFEST_PATH}`);
  } finally {
    await seriesState.close();
  }
}

main().catch((error) => {
  console.error("[scene-drift-test] Failed:", error);
  process.exitCode = 1;
});
