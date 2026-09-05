import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "../config.js";
import { SeriesState } from "../state/seriesState.js";
import { chatVision, chatText } from "../providers/aiClient.js";
import { editAnyApiSceneImage, editAnyApiSceneImageWithReference } from "../providers/anyApiImageClient.js";
import { startTimer, endTimer, logStep } from "../utils/logger.js";

export interface FinalQaIssue {
  sceneNumber: number;
  type: "character_appearance" | "anomaly";
  characterNames?: string[];
  description: string;
}

export interface FinalSceneQaVerdict {
  pass: boolean;
  issues: FinalQaIssue[];
}

export interface SceneFileInfo {
  sceneNumber: number;
  fileName: string;
  filePath: string;
}

export interface SceneCastInfo {
  sceneNumber: number;
  characterNames: string[];
}

/**
 * Finds all final scene images for an episode in ascending scene number order.
 * Excludes any failed intermediate images (containing '_fail_').
 */
export async function getFinalSceneImages(params: {
  seriesId: number;
  episodeNumber: number;
}): Promise<SceneFileInfo[]> {
  const scenesDir = path.join(
    CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
    "scenes"
  );

  if (!existsSync(scenesDir)) {
    return [];
  }

  const entries = await readdir(scenesDir);
  const sceneFiles: SceneFileInfo[] = [];

  for (const entry of entries) {
    // Only match canonical scene images like scene_001.png, scene_1.png
    // Exclude anything with _fail_, .wav, .tmp, etc.
    if (entry.includes("_fail_")) continue;
    const match = entry.match(/^scene_(\d+)\.png$/i);
    if (match) {
      const sceneNumber = parseInt(match[1], 10);
      const filePath = path.join(scenesDir, entry);
      const fileStat = await stat(filePath);
      if (fileStat.size >= 100) {
        sceneFiles.push({ sceneNumber, fileName: entry, filePath });
      }
    }
  }

  sceneFiles.sort((a, b) => a.sceneNumber - b.sceneNumber);
  return sceneFiles;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.ffmpegPath, ["-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg collage exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

/**
 * The bundled macOS FFmpeg binary was built without a default fontconfig
 * search path, so drawtext fails unless a concrete font file is supplied.
 * Prefer common system fonts when present while retaining fontconfig fallback
 * on platforms where it is configured normally.
 */
function collageFontOption(): string {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  const fontPath = candidates.find((candidate) => existsSync(candidate));
  if (!fontPath) return "";
  const escaped = fontPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  return `fontfile='${escaped}':`;
}

/**
 * Generates a labeled thumbnail collage of all final scene images using FFmpeg.
 * Thumbnails are scaled down, padded with a clear scene header label, separated
 * by borders, and tiled into a structured grid.
 */
export async function createSceneCollage(params: {
  seriesId: number;
  episodeNumber: number;
  sceneFiles?: SceneFileInfo[];
  outputPath?: string;
}): Promise<{ collagePath: string; sceneFiles: SceneFileInfo[] }> {
  const sceneFiles = params.sceneFiles ?? (await getFinalSceneImages(params));

  if (sceneFiles.length === 0) {
    throw new Error(`No valid final scene images found for series ${params.seriesId} episode ${params.episodeNumber}`);
  }

  const episodeDir = path.join(
    CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`
  );
  await mkdir(episodeDir, { recursive: true });

  const collagePath = params.outputPath ?? path.join(episodeDir, "qa_collage.png");
  const count = sceneFiles.length;

  // Compute grid columns and rows based on scene count
  const cols = count <= 4 ? 2 : count <= 9 ? 3 : count <= 16 ? 4 : count <= 25 ? 5 : 6;
  const rows = Math.ceil(count / cols);

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const fontOption = collageFontOption();

  for (let i = 0; i < count; i++) {
    inputArgs.push("-i", sceneFiles[i].filePath);
    const sceneNum = sceneFiles[i].sceneNumber;
    filterParts.push(
      `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `pad=640:390:0:30:color=black,drawtext=${fontOption}text='Scene ${sceneNum}':fontcolor=yellow:fontsize=22:x=(w-text_w)/2:y=6,` +
      `pad=648:398:4:4:color=gray[v${i}]`
    );
  }

  const concatInputs = Array.from({ length: count }, (_, i) => `[v${i}]`).join("");
  const tileFilter = `${concatInputs}concat=n=${count}:v=1:a=0,tile=${cols}x${rows}:margin=8:padding=8:color=black[out]`;
  const filterComplex = `${filterParts.join(";")};${tileFilter}`;

  await runFfmpeg([...inputArgs, "-filter_complex", filterComplex, "-map", "[out]", "-frames:v", "1", collagePath]);

  logStep(`Scene collage created: ${collagePath} (${count} scenes, ${cols}x${rows} grid)`);
  return { collagePath, sceneFiles };
}

/**
 * Normalizes and parses the LLM QA response into a structured FinalSceneQaVerdict.
 */
export async function normalizeFinalQaResponse(raw: string): Promise<FinalSceneQaVerdict> {
  let cleaned = raw.trim();
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned) as Partial<FinalSceneQaVerdict>;
    const issues: FinalQaIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((item) => {
          const type: "character_appearance" | "anomaly" =
            item.type === "character_appearance" ? "character_appearance" : "anomaly";
          return {
            sceneNumber: Number(item.sceneNumber) || 0,
            type,
            characterNames: Array.isArray(item.characterNames) ? item.characterNames.map(String) : [],
            description: String(item.description || ""),
          };
        }).filter((issue) => issue.sceneNumber > 0 && Boolean(issue.description))
      : [];

    return {
      pass: issues.length === 0,
      issues,
    };
  } catch {
    try {
      const repaired = await chatText({
        systemPrompt:
          "You repair malformed QA verdicts for storybook scene collages. " +
          "Return ONLY valid JSON with this exact shape: {\"pass\": boolean, \"issues\": [{\"sceneNumber\": number, \"type\": \"character_appearance\"|\"anomaly\", \"characterNames\": string[], \"description\": string}]}. " +
          "Do not add explanations or markdown fences.",
        userText: `Rewrite this QA verdict as strict JSON only:\n${raw}`,
      });
      const parsedRepaired = JSON.parse(repaired) as Partial<FinalSceneQaVerdict>;
      const issues: FinalQaIssue[] = Array.isArray(parsedRepaired.issues)
        ? parsedRepaired.issues.map((item) => {
            const type: "character_appearance" | "anomaly" =
              item.type === "character_appearance" ? "character_appearance" : "anomaly";
            return {
              sceneNumber: Number(item.sceneNumber) || 0,
              type,
              characterNames: Array.isArray(item.characterNames) ? item.characterNames.map(String) : [],
              description: String(item.description || ""),
            };
          }).filter((issue) => issue.sceneNumber > 0 && Boolean(issue.description))
        : [];
      return {
        pass: issues.length === 0,
        issues,
      };
    } catch {
      return {
        pass: false,
        issues: [
          {
            sceneNumber: 1,
            type: "anomaly",
            description: "QA reviewer returned unparseable response.",
          },
        ],
      };
    }
  }
}

/**
 * Reviews the scene collage using Gemini vision model for a high-level sanity check.
 */
export async function reviewSceneCollage(params: {
  collageBytes: Buffer;
  conceptName: string;
  conceptSummary: string;
  characterDescriptions: Array<{ name: string; description: string }>;
  episodeNumber: number;
  episodeTitle?: string;
  sceneCount: number;
  sceneCast?: SceneCastInfo[];
}): Promise<FinalSceneQaVerdict> {
  const charactersText = params.characterDescriptions.length > 0
    ? params.characterDescriptions.map((c) => `- ${c.name}: ${c.description}`).join("\n")
    : "(No main character descriptions available)";

  let sceneCastSection = "";
  if (params.sceneCast && params.sceneCast.length > 0) {
    sceneCastSection = "\n\nPER-SCENE EXPECTED CAST LIST:\n" +
      params.sceneCast.map((sc) => `- Scene ${sc.sceneNumber}: ${sc.characterNames.length > 0 ? sc.characterNames.join(", ") : "0 characters (landscape/scenery only)"}`).join("\n");
  }

  const systemPrompt =
    "You are a Senior Art Director & Quality Assurance Reviewer performing a final high-level sanity check on an entire children's storybook episode. " +
    "You will be given a labeled collage containing all scene images in the episode arranged in order ('Scene 1', 'Scene 2', ..., 'Scene N'). " +
    "Your job is to identify only GLARE-LEVEL issues before final video rendering:\n\n" +
    "1. MAIN CHARACTER APPEARANCE INCONSISTENCY (type: 'character_appearance'):\n" +
    "   - Check if any main series character in a scene is SIGNIFICANTLY DIFFERENT from other scenes or their canonical design.\n" +
    "   - ONLY flag when the character is drawn as the wrong animal/species entirely (e.g., monkey drawn as cat), has an altered body morphology, or is completely unrecognizable.\n" +
    "   - DO NOT flag slight variations in color hue, lighting, clothing nuances, camera angle, or facial expressions — storybook AI art naturally has subtle stylistic variations.\n\n" +
    "2. SEVERE UNNATURAL ANOMALIES & MUTATIONS (type: 'anomaly'):\n" +
    "   - Conjoined bodies, merged heads, multiple heads/faces on one character, fused figures.\n" +
    "   - Extra limbs (three arms, three hands, extra legs growing from torso).\n" +
    "   - Artificial floating text, subtitles, UI captions, numbered badge stickers, or watermarks stamped across the canvas (in-world prop signs/books are acceptable).\n\n" +
    "3. PER-SCENE CAST & DUPLICATION VERIFICATION (type: 'anomaly' or 'character_appearance'):\n" +
    "   - Cross-reference each numbered scene tile ('Scene 1', 'Scene 2', ...) against the PER-SCENE EXPECTED CAST list if provided.\n" +
    "   - Strictly flag any scene where a character appears DUPLICATED or CLONED (e.g. two boys with identical clothing/hair, two blue-skinned characters in cloaks/capes, two copies of any character in the same frame). Each character must appear at most ONCE per scene.\n" +
    "   - Flag if an expected cast member is completely missing and replaced by an unrequested extra character or duplicate clone.\n\n" +
    "HIGH-LEVEL SANITY CHECK GUIDELINES:\n" +
    "- Be generous with normal storybook cartoon styling, subtle lighting variations, and minor outfit nuances.\n" +
    "- However, DUPLICATE CLONES of a character (such as two blue-skinned characters in one scene, or two boys/girls with identical hair/clothes), EXTRA LIMBS, or SEVERE MUTATIONS are strictly unacceptable defects and MUST be reported under issues.\n" +
    "- If no scenes have glaring issues or duplicate characters, return {\"pass\": true, \"issues\": []}.\n" +
    "- Return strictly valid JSON with this format:\n" +
    "{\n" +
    "  \"pass\": boolean,\n" +
    "  \"issues\": [\n" +
    "    {\n" +
    "      \"sceneNumber\": number,\n" +
    "      \"type\": \"character_appearance\" | \"anomaly\",\n" +
    "      \"characterNames\": [\"Character Name\"],\n" +
    "      \"description\": \"Specific description of the glaring issue\"\n" +
    "    }\n" +
    "  ]\n" +
    "}";

  const userText =
    `Series Concept: ${params.conceptName}\n` +
    `Concept Summary: ${params.conceptSummary}\n` +
    `Main Characters:\n${charactersText}` +
    sceneCastSection + "\n\n" +
    `Episode: Episode ${params.episodeNumber}${params.episodeTitle ? ` - "${params.episodeTitle}"` : ""}\n` +
    `Total Scenes: ${params.sceneCount}\n\n` +
    `Look at the provided labeled collage where each tile is marked with its scene number ('Scene 1', 'Scene 2', ...). ` +
    `Inspect all scenes and determine if any scene fails this high-level sanity check.`;

  const response = await chatVision({
    systemPrompt,
    userText,
    imageBase64: params.collageBytes.toString("base64"),
    mimeType: "image/png",
  });

  return await normalizeFinalQaResponse(response);
}

/**
 * Finds next available fail file path for a scene, e.g. scene_001_final_qa_fail_1.png
 */
async function getNextFinalQaFailPath(sceneFilePath: string): Promise<string> {
  const parsed = path.parse(sceneFilePath);
  let index = 1;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}_final_qa_fail_${index}${parsed.ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    index++;
  }
}

/**
 * Locates the series key art image for reference-based character appearance repair.
 */
async function getSeriesKeyArtPath(seriesState: SeriesState, seriesId: number): Promise<string | null> {
  try {
    const existing = await seriesState.getKeyArt(seriesId, "series", null);
    if (existing?.selectedPath && existsSync(existing.selectedPath)) {
      return existing.selectedPath;
    }
  } catch {
    // Ignore DB error, check filesystem
  }

  const defaultPath = path.join(CONFIG.outputDir, `series_${seriesId}`, "key_art", "series_key_art.png");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

/**
 * Applies targeted fixes for scenes flagged in the final QA pass.
 * For character appearance issues, references the series key art image.
 * For anomalies, executes surgical prompt repair.
 * Moves previous final images to fail paths and regenerates the final collage.
 */
export async function applyTargetedFixes(params: {
  seriesId: number;
  episodeNumber: number;
  verdict: FinalSceneQaVerdict;
  seriesState: SeriesState;
}): Promise<{ fixedScenes: number[]; updatedCollagePath: string }> {
  const fixedScenes: number[] = [];
  const scenesDir = path.join(
    CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
    "scenes"
  );

  const seriesKeyArtPath = await getSeriesKeyArtPath(params.seriesState, params.seriesId);
  let seriesKeyArtBytes: Buffer | null = null;
  if (seriesKeyArtPath && existsSync(seriesKeyArtPath)) {
    try {
      seriesKeyArtBytes = await readFile(seriesKeyArtPath);
      logStep(`Series key art loaded for character alignment: ${seriesKeyArtPath}`);
    } catch (err) {
      console.warn(`Could not read series key art from ${seriesKeyArtPath}:`, err);
    }
  }

  for (const issue of params.verdict.issues) {
    const sceneNum = issue.sceneNumber;
    const sceneFileName = `scene_${String(sceneNum).padStart(3, "0")}.png`;
    let sceneFilePath = path.join(scenesDir, sceneFileName);

    if (!existsSync(sceneFilePath)) {
      // Try alternate scene_N.png format
      const altPath = path.join(scenesDir, `scene_${sceneNum}.png`);
      if (existsSync(altPath)) {
        sceneFilePath = altPath;
      } else {
        console.warn(`[Final QA Fix] Scene file not found for scene ${sceneNum}: ${sceneFilePath}`);
        continue;
      }
    }

    logStep(`[Final QA Fix] Repairing Scene ${sceneNum} (type: ${issue.type}): ${issue.description}`);

    const originalBytes = await readFile(sceneFilePath);
    const failPath = await getNextFinalQaFailPath(sceneFilePath);

    // Archive the original image to fail path
    await copyFile(sceneFilePath, failPath);
    logStep(`[Final QA Fix] Archived original Scene ${sceneNum} to: ${failPath}`);

    let repairedBytes: Buffer;

    if (issue.type === "character_appearance" && seriesKeyArtBytes) {
      const charNames = issue.characterNames && issue.characterNames.length > 0
        ? issue.characterNames.join(", ")
        : "the main characters";

      const prompt =
        `The first image is the canonical series key art showing the characters (${charNames}). ` +
        `The second image is Scene ${sceneNum}. Issue detected: ${issue.description}. ` +
        `Align the appearance, features, body shape, species, and visual traits of the character(s) (${charNames}) in the second image to match their canonical appearance in the reference series key art. ` +
        `Preserve the second image's background environment, composition, scene action, and lighting. Do not add extra characters or text. ` +
        `Preserve the exact storybook illustration style, background, colours, and lighting of the image. Do not introduce any new duplicate animals, clones, extra characters, or text.`;

      repairedBytes = await editAnyApiSceneImageWithReference({
        prompt,
        imageBytes: originalBytes,
        referenceImageBytes: seriesKeyArtBytes,
      });
    } else {
      const prompt =
        `Fix this defect in Scene ${sceneNum}: ${issue.description}. ` +
        `Surgically repair the unnatural defect (e.g. remove extra limbs, conjoined heads, fused bodies, or floating text) while preserving the exact storybook illustration style, background, colours, action, and lighting of the image. ` +
        `Do not introduce any new duplicate animals, clones, extra characters, or text. ` +
        `Preserve the exact storybook illustration style, background, colours, and lighting of the image.`;

      repairedBytes = await editAnyApiSceneImage({
        prompt,
        imageBytes: originalBytes,
      });
    }

    // Overwrite the canonical final image with the repaired bytes
    await writeFile(sceneFilePath, repairedBytes);
    fixedScenes.push(sceneNum);
    logStep(`[Final QA Fix] Successfully updated final image for Scene ${sceneNum}`);
  }

  // Regenerate the collage to reflect the updated images
  const { collagePath } = await createSceneCollage({
    seriesId: params.seriesId,
    episodeNumber: params.episodeNumber,
  });

  return { fixedScenes, updatedCollagePath: collagePath };
}

/**
 * Deep-agent tool: Performs a final QA pass over all generated scenes of an episode.
 * Collages all final scene images, executes an LLM vision sanity check for character
 * consistency and unnatural anomalies, and performs targeted fixes if needed before video generation.
 */
export function buildFinalSceneQaTool(seriesState: SeriesState): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "final_scene_qa_pass",
    description:
      "Performs a final QA pass across ALL generated scene images for an episode before video assembly. " +
      "Generates a labeled thumbnail collage of all scenes, sends it to the vision LLM for a high-level sanity check " +
      "(glaring character appearance inconsistencies or severe anatomical anomalies), and automatically applies targeted fixes " +
      "(referencing the series key art for character appearance, or surgical img2img prompt edits for anomalies). " +
      "Original failed images are archived and the final image is updated. Returns the status, collage path, and any fixes made.",
    schema: z.object({
      seriesId: z.number().describe("The series id."),
      episodeNumber: z.number().describe("The episode number."),
    }),
    func: async ({ seriesId, episodeNumber }) => {
      const timerName = `final_qa_episode_${episodeNumber}`;
      startTimer(timerName);
      logStep(`Starting final QA pass for Series ${seriesId} Episode ${episodeNumber}`);

      // 1. Gather all final scene images and build the collage
      const sceneFiles = await getFinalSceneImages({ seriesId, episodeNumber });
      if (sceneFiles.length === 0) {
        endTimer(timerName);
        return JSON.stringify({
          status: "error",
          message: `No final scene images found for Series ${seriesId} Episode ${episodeNumber}. Generate scene images first.`,
        });
      }

      const { collagePath } = await createSceneCollage({
        seriesId,
        episodeNumber,
        sceneFiles,
      });

      // 2. Fetch series & character context
      const series = await seriesState.getSeriesInfo(seriesId);
      const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
      const conceptName = series?.conceptName ?? `Series ${seriesId}`;
      const conceptSummary = series?.episodeFormula ?? "";
      const characters = series?.charactersJson ?? [];
      const characterDescriptions = characters.map((c: { name: string; description: string }) => ({
        name: c.name,
        description: c.description || c.name,
      }));

      // Extract per-scene cast from script_json
      let script = episode?.scriptJson;
      while (typeof script === "string") {
        try {
          script = JSON.parse(script);
        } catch {
          try {
            // Recover from common LLM JSON syntax typos in characterVisuals
            let repaired = (script as string)
              .replace(/"name":\s*"([^"]+)":\s*"visualForm":/g, '"name": "$1", "visualForm":')
              .replace(/"name":\s*"([^"]+)":\s*"(humanoid|real_creature|anthropomorphic_creature|object_character|fantasy_creature)"/g, '"name": "$1", "visualForm": "$2"')
              .replace(/"name":\s*"([^"]+)":\s*"visualForm"/g, '"name": "$1", "visualForm"')
              .replace(/"visualForm":\s*"([^"]+)":\s*"speciesOrType"/g, '"visualForm": "$1", "speciesOrType"')
              .replace(/"speciesOrType":\s*"([^"]+)":\s*"humanoidAllowed"/g, '"speciesOrType": "$1", "humanoidAllowed"');
            script = JSON.parse(repaired);
          } catch {
            break;
          }
        }
      }

      const sceneCast: SceneCastInfo[] = [];
      if (script && typeof script === "object" && Array.isArray((script as any).scenes)) {
        for (const scene of (script as any).scenes) {
          if (scene && typeof scene.sceneNumber === "number") {
            const charNames = Array.isArray(scene.characterNames)
              ? scene.characterNames.map(String)
              : [];
            sceneCast.push({
              sceneNumber: scene.sceneNumber,
              characterNames: charNames,
            });
          }
        }
      }

      // Fallback to local script_refined.json on disk if needed
      if (sceneCast.length === 0) {
        const localScriptPath = path.join(
          CONFIG.outputDir,
          `series_${seriesId}`,
          `episode_${episodeNumber}`,
          "script_refined.json"
        );
        if (existsSync(localScriptPath)) {
          try {
            const raw = JSON.parse(await readFile(localScriptPath, "utf-8"));
            if (raw && Array.isArray(raw.scenes)) {
              for (const scene of raw.scenes) {
                if (scene && typeof scene.sceneNumber === "number") {
                  sceneCast.push({
                    sceneNumber: scene.sceneNumber,
                    characterNames: Array.isArray(scene.characterNames) ? scene.characterNames.map(String) : [],
                  });
                }
              }
            }
          } catch {
            // Ignore fallback error
          }
        }
      }

      const collageBytes = await readFile(collagePath);

      // 3. Review the collage with the vision LLM
      const verdict = await reviewSceneCollage({
        collageBytes,
        conceptName,
        conceptSummary,
        characterDescriptions,
        episodeNumber,
        episodeTitle: episode?.title,
        sceneCount: sceneFiles.length,
        sceneCast,
      });

      logStep(`Final QA Verdict: pass=${verdict.pass}, issues count=${verdict.issues.length}`);

      // 4. If pass, return success
      if (verdict.pass || verdict.issues.length === 0) {
        endTimer(timerName);
        return JSON.stringify({
          status: "passed",
          collagePath,
          totalScenes: sceneFiles.length,
          issuesCount: 0,
          message: "All scenes passed the final QA sanity check. Ready for video assembly.",
        });
      }

      // 5. Apply targeted fixes for any reported issues
      logStep(`[Final QA] Applying targeted fixes to ${verdict.issues.length} scene(s)...`);
      const { fixedScenes, updatedCollagePath } = await applyTargetedFixes({
        seriesId,
        episodeNumber,
        verdict,
        seriesState,
      });

      endTimer(timerName);
      return JSON.stringify({
        status: "fixed",
        collagePath: updatedCollagePath,
        totalScenes: sceneFiles.length,
        fixedScenes,
        issuesCount: verdict.issues.length,
        message: `Fixed issues in ${fixedScenes.length} scene(s) and updated final scene images. Saved final collage.`,
      });
    },
  });
}
