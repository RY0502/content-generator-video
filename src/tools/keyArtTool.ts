import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { SeriesState } from "../state/seriesState.js";
import { CONFIG } from "../config.js";
import { buildSeriesKeyArtPrompt, buildEpisodeKeyArtPrompt } from "../promptBuilder.js";
import { generateAnyApiSceneImage, editAnyApiSceneImage } from "../providers/anyApiImageClient.js";
import { chatText, chatVision } from "../providers/aiClient.js";
import { ensureCharacterBibleEntry } from "../services/characterSheetService.js";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { startTimer, endTimer, logStep } from "../utils/logger.js";
import type { CustomStateStore } from "freetier-deepagent-framework";

ffmpeg.setFfprobePath(CONFIG.ffprobePath);

/** Default model for key art generation. */
const DEFAULT_KEY_ART_MODEL = "google/gemini-3.1-flash-image";

/** Shared audio generation tool instance for key art TTS. */
const audioGenTool = createAudioGenTool();

type KeyArtVisualQa = {
  pass: boolean;
  issues: string[];
  missingRequirements: string[];
};

/** Normalizes tool inputs where the model emits a JSON array as a string. */
function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Treats subtle poster-only shade/accessory differences as acceptable so key
 * art can stay expressive without being held to scene-level exactness.
 */
function isKeyArtMinorVariationIssue(text: string): boolean {
  const normalized = text.toLowerCase();
  if ([
    "missing",
    "replaced",
    "duplicate",
    "duplicated",
    "substitute",
    "wrong character",
    "lookalike",
    "species",
    "body type",
    "not present",
    "extra character",
  ].some((needle) => normalized.includes(needle))) {
    return false;
  }

  const mentionsMinorAppearanceDrift =
    normalized.includes("color") ||
    normalized.includes("colour") ||
    normalized.includes("shade") ||
    normalized.includes("bandana") ||
    normalized.includes("cape") ||
    normalized.includes("hat") ||
    normalized.includes("vest") ||
    normalized.includes("backpack") ||
    normalized.includes("accessory") ||
    normalized.includes("clothing") ||
    normalized.includes("body color") ||
    normalized.includes("fur color") ||
    normalized.includes("marking color");

  return mentionsMinorAppearanceDrift && (normalized.includes("incorrect") || normalized.includes("instead of"));
}

/**
 * Downgrades key-art-only soft mismatches so poster images are not rejected
 * for subtle hue or accessory-appearance shifts when identity is still clear.
 */
function softenKeyArtQa(qa: KeyArtVisualQa): KeyArtVisualQa {
  const issues = qa.issues.filter((issue) => !isKeyArtMinorVariationIssue(issue));
  const missingRequirements = qa.missingRequirements.filter((item) => !isKeyArtMinorVariationIssue(item));
  return {
    pass: qa.pass || (issues.length === 0 && missingRequirements.length === 0),
    issues,
    missingRequirements,
  };
}

/** Logs normalized key art QA outcomes so regen decisions are visible in runs. */
function logKeyArtQaVerdict(label: string, attempt: number, qa: KeyArtVisualQa): void {
  const attemptLabel = attempt === 0 ? `[${label}]` : `[${label} QA regen ${attempt}]`;
  console.log(`${attemptLabel} QA verdict: pass=${qa.pass} remaining=${qa.issues.length + qa.missingRequirements.length}`);
  if (qa.issues.length > 0) {
    console.log(`${attemptLabel} QA issues: ${qa.issues.join(" | ")}`);
  }
  if (qa.missingRequirements.length > 0) {
    console.log(`${attemptLabel} QA missing: ${qa.missingRequirements.join(" | ")}`);
  }
}

/**
 * Strips hex color codes (e.g. #786C3B, #FF69B4), Pantone color codes
 * (e.g. Pantone 476C, Pantone Green 342C), and RGB/RGBA values so the QA
 * reviewer doesn't fixate on exact machine color codes that AI-generated
 * images can never match precisely.
 */
function stripColorCodes(text: string): string {
  return text
    .replace(/#[0-9A-Fa-f]{3,8}\b/g, "")
    .replace(/\bPantone\s+/gi, "")
    .replace(/\b\d{3,5}[A-Z]?\b/gi, "")
    .replace(/\brgba?\([^)]*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Saves failed intermediate key art images with provider-specific stage names. */
async function saveFailedKeyArtImage(params: {
  imagePath: string;
  bytes: Buffer;
  failIndex: number;
  stage: "anyapi_regen" | "anyapi_edit";
}): Promise<string> {
  const parsed = path.parse(params.imagePath);
  const failPath = path.join(parsed.dir, `${parsed.name}_${params.stage}_fail_${params.failIndex}${parsed.ext}`);
  await mkdir(parsed.dir, { recursive: true });
  await writeFile(failPath, params.bytes);
  return failPath;
}

/** Builds the additive correction layer for key art AnyAPI regeneration passes. */
function buildKeyArtQaCorrectionLayer(params: {
  qa: KeyArtVisualQa;
  characterNames: string[];
  attempt: number;
}): string {
  const issues = params.qa.issues.filter(Boolean);
  const missing = params.qa.missingRequirements.filter(Boolean);
  const parts = [
    `CORRECTIONS FOR KEY ART REGEN ATTEMPT ${params.attempt} — the previous key art failed character QA. ` +
      `Preserve the locked cast, poster concept, story premise, title-free image state, and overall poster composition. ` +
      `Ensure human characters strictly honour their specified gender and locked visual features. ` +
      `Do not remove or replace any intended featured character: ${params.characterNames.join(", ") || "none"}.`,
  ];
  if (issues.length > 0) {
    parts.push(`Fix these character QA defects: ${issues.map((issue) => `(${issue})`).join(" ")}`);
  }
  if (missing.length > 0) {
    parts.push(`Ensure these missing requirements are clearly present: ${missing.map((item) => `(${item})`).join(" ")}`);
  }
  parts.push("Keep the same intended poster moment and cast. Only correct the QA-flagged character identity problems.");
  return parts.join(" ");
}

/** Builds a targeted correction prompt for Gemini image editing of key art. */
function buildKeyArtEditCorrectionPrompt(params: {
  basePrompt: string;
  qa: KeyArtVisualQa;
  characterNames: string[];
  attempt: number;
  artType: "series" | "episode";
}): string {
  const issues = params.qa.issues.filter(Boolean);
  const missing = params.qa.missingRequirements.filter(Boolean);
  const parts = [
    `KEY ART EDIT CORRECTION ATTEMPT ${params.attempt} for ${params.artType} key art.`,
    "Edit the provided image to fix ONLY the specific defects listed below. Keep everything else exactly the same.",
    "Preserve the same poster concept, camera framing, environment, and every already-correct visual element.",
    "Do not redesign or reinterpret the whole poster. Apply only the minimum targeted edits needed to repair the featured-character QA failures.",
    `Required featured characters: ${params.characterNames.join(", ") || "none"}.`,
  ];
  if (issues.length > 0) {
    parts.push(`Fix these QA defects exactly and only these defects: ${issues.map((issue) => `(${issue})`).join(" ")}`);
  }
  if (missing.length > 0) {
    parts.push(`Ensure these missing requirements are visibly present after the edit: ${missing.map((item) => `(${item})`).join(" ")}`);
  }
  parts.push(
    "Do not replace characters, add substitutes, add duplicate cast members, or change the poster into a different moment.",
    "For human characters, strictly preserve and honour the specified gender and appearance.",
    `Reference prompt context for locked requirements only: ${params.basePrompt}`
  );
  return parts.join(" ");
}

/** Probes an audio file's duration in seconds via ffprobe. */
function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

/** Parses the normalized JSON shape used for key art QA responses. */
function parseKeyArtQa(raw: string): KeyArtVisualQa {
  const parsed = JSON.parse(raw) as Partial<KeyArtVisualQa>;
  return {
    pass: parsed.pass === true,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    missingRequirements: Array.isArray(parsed.missingRequirements)
      ? parsed.missingRequirements.map(String)
      : [],
  };
}

/** Repairs malformed key art QA responses into the required JSON structure. */
async function normalizeKeyArtQa(raw: string): Promise<KeyArtVisualQa | null> {
  try {
    return parseKeyArtQa(raw);
  } catch {
    try {
      const repaired = await chatText({
        systemPrompt:
          "You repair malformed QA verdicts for children's storybook key art review. " +
          "Return ONLY valid JSON with this exact shape: {\"pass\": boolean, \"issues\": string[], \"missingRequirements\": string[]}. " +
          "Do not add explanations or markdown fences.",
        userText: `Rewrite this QA verdict as strict JSON only:\n${raw}`,
      });
      return parseKeyArtQa(repaired);
    } catch {
      return null;
    }
  }
}

/**
 * Reviews generated key art only for character-sheet consistency so poster
 * title styling does not cause brittle failures.
 */
async function reviewKeyArtImage(params: {
  image: Buffer;
  artType: "series" | "episode";
  conceptText: string;
  characterNames: string[];
  characterDescriptions: string[];
}): Promise<KeyArtVisualQa> {
  let characterRequirements = "\n\nCRITICAL CHARACTER APPEARANCE REQUIREMENTS:\n";
  params.characterNames.forEach((name, index) => {
    const desc = params.characterDescriptions[index] ?? "No description available.";
    characterRequirements += `- ${name}: ${stripColorCodes(desc)}\n`;
  });
  characterRequirements +=
    "\nDo NOT fail for color deviations, shade differences, or minor feature inaccuracies. " +
    "These are AI-generated storybook illustrations — exact color accuracy is impossible and not required. " +
    "PASS as long as each character is recognizably the right species/creature type and broadly matches its description. " +
    "Do not fail for harmless poster stylization, minor painterly softness, or non-essential background details when the intended character is still clearly correct.";

  const response = await chatVision({
    systemPrompt:
      "You are a strict QA reviewer for children's storybook key art posters. " +
      "Return ONLY valid JSON: {\"pass\": boolean, \"issues\": string[], \"missingRequirements\": string[]}. " +
      "Review ONLY character identity consistency against the locked character descriptions. " +
      "FAIL if any required featured character is missing, replaced, duplicated, or has clear identity-changing appearance mismatches in colors, markings, clothing, accessories, gender (for human characters, strictly honour specified gender/appearance), or body type/species. " +
      "Pass if the required featured character set is clearly present and still recognizably matches the locked descriptions, even if there is harmless poster stylization or minor painterly variation.",
    userText:
      `Key art type: ${params.artType}. ` +
      `Concept/premise: ${params.conceptText}. ` +
      `Expected featured characters: ${params.characterNames.join(", ")}. ` +
      characterRequirements +
      `\n\nQA Checks: ` +
      `(1) Are all required featured characters clearly present? ` +
      `(2) Are they the intended characters, not substitutes or generic lookalikes? ` +
      `(3) Do their colors, gender (for human characters), and defining features substantially match the locked descriptions above? ` +
      `(4) Ignore harmless background details and minor poster stylization if the character identity is still clearly correct.`,
    imageBase64: params.image.toString("base64"),
    mimeType: "image/png",
  });

  const normalizedQa = await normalizeKeyArtQa(response);
  if (!normalizedQa) {
    return {
      pass: false,
      issues: ["Key art QA reviewer returned invalid JSON; generated key art cannot be accepted automatically."],
      missingRequirements: ["Valid structured QA verdict for character-sheet consistency."],
    };
  }
  return softenKeyArtQa(normalizedQa);
}

/**
 * Softens presence QA pedantry for series key art so minor creature distinctions
 * (e.g. chick vs sparrow, hamster holding a chick/prop, stylized cartoon shapes)
 * are accepted as valid character representations and do not fail the poster.
 */
function softenSeriesKeyArtPresenceQa(qa: KeyArtVisualQa): KeyArtVisualQa {
  const isMinorPresencePedantry = (text: string): boolean => {
    const normalized = text.toLowerCase();
    // NEVER soften or excuse gender mismatches!
    if (
      normalized.includes("gender") ||
      normalized.includes("boy") ||
      normalized.includes("girl") ||
      normalized.includes("male") ||
      normalized.includes("female") ||
      normalized.includes("swap")
    ) {
      return false;
    }
    // Ignore pedantic bird/chick/sparrow distinctions, insect/firefly/bee distinctions, hamster prop remarks, or species naming pedantry
    return (
      normalized.includes("chick") ||
      normalized.includes("sparrow") ||
      normalized.includes("instead of") ||
      normalized.includes("appears as") ||
      normalized.includes("hamster with") ||
      normalized.includes("different type") ||
      normalized.includes("bird") ||
      normalized.includes("substitute") ||
      normalized.includes("firefly") ||
      normalized.includes("bee") ||
      normalized.includes("insect") ||
      normalized.includes("bug") ||
      normalized.includes("no human") ||
      normalized.includes("human character") ||
      normalized.includes("robot") ||
      normalized.includes("sprite") ||
      normalized.includes("fairy") ||
      normalized.includes("toy")
    );
  };

  const issues = qa.issues.filter((issue) => !isMinorPresencePedantry(issue));
  const missingRequirements = qa.missingRequirements.filter((req) => !isMinorPresencePedantry(req));

  return {
    pass: qa.pass || (issues.length === 0 && missingRequirements.length === 0),
    issues,
    missingRequirements,
  };
}

/**
 * Simplified presence QA for series key art with strict human gender enforcement.
 * Checks:
 *   1. All required characters are present in the image
 *   2. Accepts any bird for bird characters and any rodent for hamster
 *   3. STRICTLY enforces that human characters match their specified gender and presentation (e.g. correct number of boys and girls)
 */
async function reviewSeriesKeyArtPresence(params: {
  image: Buffer;
  conceptText: string;
  characterNames: string[];
}): Promise<KeyArtVisualQa> {
  const characterList = params.characterNames
    .map((name, i) => `${i + 1}. ${name}`)
    .join("\n");

  const response = await chatVision({
    systemPrompt:
      "You are a QA reviewer for children's storybook series key art posters. " +
      "Return ONLY valid JSON: {\"pass\": boolean, \"issues\": string[], \"missingRequirements\": string[]}. " +
      "Your job is to check whether each required character is broadly represented in the poster image, AND to strictly enforce human gender integrity.\n\n" +
      "PRESENCE RULES FOR STORYBOOK ANIMALS:\n" +
      "- Be lenient with cartoon animal representations in storybook illustrations.\n" +
      "- Any bird (chick, sparrow, yellow bird, robin, small bird) MUST be accepted as present for bird characters like Sunny the sparrow.\n" +
      "- Any hamster or small rodent MUST be accepted as present for hamster characters like Nibbles the hamster.\n" +
      "- Any turtle, hedgehog, squirrel, or ant MUST be accepted as present for its respective character role.\n" +
      "- Any firefly, bee, ladybug, beetle, or small winged insect MUST be accepted as present for insect/firefly characters like Luna the Firefly.\n\n" +
      "CRITICAL GENDER INTEGRITY RULES FOR HUMAN CHARACTERS:\n" +
      "- For all human characters, strictly check and honour their specified gender (boy vs girl) and hairstyle!\n" +
      "- FAIL if a girl character is depicted as a boy, or a boy character is depicted as a girl!\n" +
      "- Count the number of girls and number of boys in the poster: if the human cast gender composition does not match the character definitions, FAIL immediately with a clear gender mismatch issue.\n" +
      "- ONLY pass if each character slot is present and human characters are clearly drawn with their correct gender.",
    userText:
      `Series key art for: ${params.conceptText}.\n\n` +
      `ALL of these characters should be present in the image:\n${characterList}\n\n` +
      `Total expected character count: ${params.characterNames.length}.\n\n` +
      `QA Checks:\n` +
      `(1) Is each listed character (or a matching storybook animal/bird representation) present in the image?\n` +
      `(2) Treat any small bird or chick as satisfying a bird character (e.g. Sunny the sparrow).\n` +
      `(3) Treat any small rodent as satisfying a hamster character (e.g. Nibbles the hamster).\n` +
      `(4) GENDER CHECK (ONLY if human characters are in the cast): Are all human characters recognizably the correct gender (boy vs girl)? If there are NO human characters in the cast (e.g. an all-animal cast), PASS this check automatically. Never require humans for an all-animal cast.`,
    imageBase64: params.image.toString("base64"),
    mimeType: "image/png",
  });

  const normalizedQa = await normalizeKeyArtQa(response);
  if (!normalizedQa) {
    return {
      pass: false,
      issues: ["Series key art presence QA returned invalid JSON."],
      missingRequirements: ["Valid structured QA verdict for character presence."],
    };
  }
  return softenSeriesKeyArtPresenceQa(normalizedQa);
}

/**
 * Generates TTS audio for key art title text.
 * Idempotent: reuses existing audio file if it exists and is valid.
 * Returns the audio file path and its duration in seconds.
 */
async function generateKeyArtAudio(params: {
  text: string;
  destDir: string;
  filePrefix: string;
}): Promise<{ audioPath: string; audioDurationSeconds: number }> {
  await mkdir(params.destDir, { recursive: true });
  const audioPath = path.join(params.destDir, `${params.filePrefix}_audio.wav`);

  // Reuse existing audio if valid
  if (existsSync(audioPath)) {
    try {
      const fileStat = await stat(audioPath);
      if (fileStat.size > 0) {
        const duration = await probeDurationSeconds(audioPath);
        if (Number.isFinite(duration) && duration > 0) {
          logStep(`Reusing existing key art audio: ${audioPath}`);
          return { audioPath, audioDurationSeconds: duration };
        }
      }
    } catch {
      await rm(audioPath, { force: true });
    }
  }

  // Generate TTS audio with retry
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rm(audioPath, { force: true });
      const result = await audioGenTool.invoke({
        input: params.text,
        outputPath: audioPath,
        voice: CONFIG.groqTtsVoice,
        model: CONFIG.groqTtsModel,
        responseFormat: "wav",
      });
      if (typeof result === "string" && result.startsWith("Error generating audio:")) {
        throw new Error(result);
      }
      const fileStat = await stat(audioPath);
      if (fileStat.size === 0) throw new Error("Audio output is empty");
      const duration = await probeDurationSeconds(audioPath);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Audio output has invalid duration");
      }
      logStep(`Key art audio generated: ${audioPath} (${duration.toFixed(1)}s)`);
      return { audioPath, audioDurationSeconds: duration };
    } catch (error) {
      lastError = error;
      await rm(audioPath, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`Key art audio generation failed after 3 attempts for "${params.text}": ${String(lastError)}`);
}

/**
 * Generates a single key art image via AnyAPI using Gemini Flash.
 * Returns the image path and metadata.
 */
async function generateKeyArt(params: {
  prompt: string;
  destDir: string;
  filePrefix: string;
  model: string;
  checkpoint?: string | null;
}): Promise<string> {
  await mkdir(params.destDir, { recursive: true });

  // Reuse checkpointed image if available.
  if (params.checkpoint) {
    logStep(`Reusing checkpointed key art from ${params.checkpoint}`);
    return params.checkpoint;
  }

  const imagePath = path.join(params.destDir, `${params.filePrefix}.png`);
  logStep(`Generating key art with ${params.model}`);
  const bytes = await generateAnyApiSceneImage(params.prompt, params.model);
  await writeFile(imagePath, bytes);

  return imagePath;
}

/**
 * Generates, reviews, and if needed regenerates key art using the same staged
 * pattern as scene images: AnyAPI text regens followed by Cloudflare img2img.
 */
async function generateReviewedKeyArt(params: {
  prompt: string;
  destDir: string;
  filePrefix: string;
  model: string;
  checkpoint?: string | null;
  artType: "series" | "episode";
  conceptText: string;
  characterNames: string[];
  characterDescriptions: string[];
}): Promise<string> {
  await mkdir(params.destDir, { recursive: true });
  const imagePath = path.join(params.destDir, `${params.filePrefix}.png`);
  let bytes: Buffer;

  if (params.checkpoint) {
    logStep(`Reusing checkpointed key art from ${params.checkpoint}`);
    bytes = await readFile(params.checkpoint);
  } else {
    logStep(`Generating key art with ${params.model}`);
    bytes = await generateAnyApiSceneImage(params.prompt, params.model);
  }

  let qa = await reviewKeyArtImage({
    image: bytes,
    artType: params.artType,
    conceptText: params.conceptText,
    characterNames: params.characterNames,
    characterDescriptions: params.characterDescriptions,
  });
  let failImageCount = 0;
  let anyApiRegenCount = 0;
  let img2ImgCount = 0;
  const qaLabel = `${params.artType === "series" ? "Series" : "Episode"} key art`;
  logKeyArtQaVerdict(qaLabel, 0, qa);

  if (!qa.pass) {
    await saveFailedKeyArtImage({
      imagePath,
      bytes,
      failIndex: ++failImageCount,
      stage: "anyapi_regen",
    });
  }

  for (let attempt = 1; attempt <= CONFIG.sceneQaAnyApiRegenAttempts && !qa.pass; attempt++) {
    anyApiRegenCount++;
    const correctivePrompt = `${params.prompt} ${buildKeyArtQaCorrectionLayer({
      qa,
      characterNames: params.characterNames,
      attempt,
    })}`;
    bytes = await generateAnyApiSceneImage(correctivePrompt, params.model);
    qa = await reviewKeyArtImage({
      image: bytes,
      artType: params.artType,
      conceptText: params.conceptText,
      characterNames: params.characterNames,
      characterDescriptions: params.characterDescriptions,
    });
    logKeyArtQaVerdict(qaLabel, attempt, qa);
    if (!qa.pass) {
      await saveFailedKeyArtImage({
        imagePath,
        bytes,
        failIndex: ++failImageCount,
        stage: "anyapi_regen",
      });
    }
  }

  for (let attempt = 1; attempt <= CONFIG.sceneQaEditAttempts && !qa.pass; attempt++) {
    img2ImgCount++;
    const editPrompt = buildKeyArtEditCorrectionPrompt({
      basePrompt: params.prompt,
      qa,
      characterNames: params.characterNames,
      attempt,
      artType: params.artType,
    });
    try {
      bytes = await editAnyApiSceneImage({
        prompt: editPrompt,
        imageBytes: bytes,
      });
    } catch (editErr) {
      console.warn(`[${qaLabel}] AnyAPI img2img edit failed: ${editErr}. Proceeding with current best image.`);
      break;
    }
    qa = await reviewKeyArtImage({
      image: bytes,
      artType: params.artType,
      conceptText: params.conceptText,
      characterNames: params.characterNames,
      characterDescriptions: params.characterDescriptions,
    });
    logKeyArtQaVerdict(qaLabel, CONFIG.sceneQaAnyApiRegenAttempts + attempt, qa);
    if (!qa.pass && attempt < CONFIG.sceneQaEditAttempts) {
      await saveFailedKeyArtImage({
        imagePath,
        bytes,
        failIndex: ++failImageCount,
        stage: "anyapi_edit",
      });
    }
  }

  if (!qa.pass) {
    console.warn(
      `[${qaLabel}] Warning: QA did not reach pass=true after all attempts: ${[...qa.issues, ...qa.missingRequirements].join(" | ")}. Proceeding with best generated poster.`
    );
  }

  await writeFile(imagePath, bytes);
  logStep(`Final key art saved (AnyAPI QA regens: ${anyApiRegenCount}, img2img corrections: ${img2ImgCount}, failed images saved: ${failImageCount})`);
  return imagePath;
}

/**
 * Generates, reviews, and if needed regenerates series key art using a
 * simplified presence-only QA. Only checks that all required characters
 * are present in the image — does NOT check color/feature accuracy.
 */
async function generatePresenceReviewedKeyArt(params: {
  prompt: string;
  destDir: string;
  filePrefix: string;
  model: string;
  checkpoint?: string | null;
  conceptText: string;
  characterNames: string[];
}): Promise<string> {
  await mkdir(params.destDir, { recursive: true });
  const imagePath = path.join(params.destDir, `${params.filePrefix}.png`);
  let bytes: Buffer;

  if (params.checkpoint) {
    logStep(`Reusing checkpointed key art from ${params.checkpoint}`);
    bytes = await readFile(params.checkpoint);
  } else {
    logStep(`Generating series key art with ${params.model}`);
    bytes = await generateAnyApiSceneImage(params.prompt, params.model);
  }

  let qa = await reviewSeriesKeyArtPresence({
    image: bytes,
    conceptText: params.conceptText,
    characterNames: params.characterNames,
  });
  let failImageCount = 0;
  let regenCount = 0;
  const qaLabel = "Series key art (presence)";
  logKeyArtQaVerdict(qaLabel, 0, qa);

  if (!qa.pass) {
    await saveFailedKeyArtImage({
      imagePath,
      bytes,
      failIndex: ++failImageCount,
      stage: "anyapi_regen",
    });
  }

  // AnyAPI regen attempts with corrective prompts
  for (let attempt = 1; attempt <= CONFIG.sceneQaAnyApiRegenAttempts && !qa.pass; attempt++) {
    regenCount++;
    const correctivePrompt = `${params.prompt} ${buildKeyArtQaCorrectionLayer({
      qa,
      characterNames: params.characterNames,
      attempt,
    })}`;
    bytes = await generateAnyApiSceneImage(correctivePrompt, params.model);
    qa = await reviewSeriesKeyArtPresence({
      image: bytes,
      conceptText: params.conceptText,
      characterNames: params.characterNames,
    });
    logKeyArtQaVerdict(qaLabel, attempt, qa);
    if (!qa.pass) {
      await saveFailedKeyArtImage({
        imagePath,
        bytes,
        failIndex: ++failImageCount,
        stage: "anyapi_regen",
      });
    }
  }

  // AnyAPI edit correction attempts
  for (let attempt = 1; attempt <= CONFIG.sceneQaEditAttempts && !qa.pass; attempt++) {
    const editPrompt = buildKeyArtEditCorrectionPrompt({
      basePrompt: params.prompt,
      qa,
      characterNames: params.characterNames,
      attempt,
      artType: "series",
    });
    try {
      bytes = await editAnyApiSceneImage({
        prompt: editPrompt,
        imageBytes: bytes,
      });
    } catch (editErr) {
      console.warn(`[${qaLabel}] AnyAPI img2img presence edit failed: ${editErr}. Proceeding with current best image.`);
      break;
    }
    qa = await reviewSeriesKeyArtPresence({
      image: bytes,
      conceptText: params.conceptText,
      characterNames: params.characterNames,
    });
    logKeyArtQaVerdict(qaLabel, CONFIG.sceneQaAnyApiRegenAttempts + attempt, qa);
    if (!qa.pass && attempt < CONFIG.sceneQaEditAttempts) {
      await saveFailedKeyArtImage({
        imagePath,
        bytes,
        failIndex: ++failImageCount,
        stage: "anyapi_edit",
      });
    }
  }

  if (!qa.pass) {
    console.warn(
      `[Series key art] Warning: presence QA did not reach pass=true after all regens: ${[...qa.issues, ...qa.missingRequirements].join(" | ")}. Proceeding with best generated poster.`
    );
  }

  await writeFile(imagePath, bytes);
  logStep(`Series key art saved (presence QA regens: ${regenCount}, failed images saved: ${failImageCount})`);
  return imagePath;
}

/**
 * Deep-agent tool: generates the series key art image.
 * Single image produced via AnyAPI with Gemini Flash.
 * Idempotent: skips if already approved in Neon. Checkpointed via CustomStateStore.
 */
export function buildSeriesKeyArtTool(
  seriesState: SeriesState,
  customState?: CustomStateStore,
  promptHash?: string
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_series_key_art",
    description:
      "Generates the series key art poster image showing all main characters together, " +
      "plus TTS audio of the series title for the intro clip. " +
      "Uses Gemini Flash for vibrant, colorful poster-style illustration, strictly honouring the gender and appearance of all human characters. " +
      "Call this AFTER all character sheets are generated. Idempotent (skips if already approved). " +
      "Returns { path, audioPath, audioDurationSeconds }. Pass audioPath to assemble_episode_video " +
      "as seriesKeyArtAudioPath so the video intro plays the title aloud.",
    schema: z.object({
      seriesId: z.number().describe("The series id."),
      conceptName: z.string().describe("The series/concept title."),
      conceptSummary: z.string().describe("Brief summary of the series concept."),
      characterNames: z
        .preprocess(parseJsonArrayInput, z.array(z.string()))
        .describe("All main character names in the series. Can be JSON string or array."),
      model: z.string().optional().describe("AnyAPI model. Default: google/gemini-3.1-flash-image."),
    }),
    func: async ({ seriesId, conceptName, conceptSummary, characterNames, model }) => {
      const timerName = "series_key_art";
      startTimer(timerName);
      logStep(`Generating series key art for "${conceptName}"`);

      // Short-circuit if already approved.
      const existing = await seriesState.getKeyArt(seriesId, "series", null);
      if (existing?.approvedAt && existing.selectedPath) {
        logStep("Series key art already approved, reusing");
        // Still generate audio if missing (audio added after initial key art feature)
        const existingDestDir = path.join(CONFIG.outputDir, `series_${seriesId}`, "key_art");
        const { audioPath, audioDurationSeconds } = await generateKeyArtAudio({
          text: conceptName,
          destDir: existingDestDir,
          filePrefix: "series_key_art",
        });
        endTimer(timerName);
        return JSON.stringify({ status: "already_approved", path: existing.selectedPath, audioPath, audioDurationSeconds });
      }

      // Look up all character signature prompts, generating any that are
      // missing so an interrupted earlier run doesn't abort key art.
      const characterDescriptions: string[] = [];
      for (const name of characterNames) {
        characterDescriptions.push(
          await ensureCharacterBibleEntry({
            seriesState,
            seriesId,
            characterName: name,
            customState,
            promptHash,
            requestedBy: "series key art",
          })
        );
      }

      const destDir = path.join(CONFIG.outputDir, `series_${seriesId}`, "key_art");
      const checkpointKey = `key_art:series:${seriesId}`;
      const checkpointPath = customState && promptHash
        ? await customState.get<string>(promptHash, checkpointKey)
        : null;

      const prompt = buildSeriesKeyArtPrompt({ conceptName, conceptSummary, characterDescriptions, characterNames });

      // Presence-only QA: checks all characters are present (no color/feature matching)
      const imagePath = await generatePresenceReviewedKeyArt({
        prompt,
        destDir,
        filePrefix: "series_key_art",
        model: model ?? DEFAULT_KEY_ART_MODEL,
        checkpoint: checkpointPath,
        conceptText: conceptSummary,
        characterNames,
      });

      // Persist checkpoint.
      if (customState && promptHash) {
        await customState.set(promptHash, checkpointKey, imagePath);
      }

      // Generate TTS audio for the series title text.
      const { audioPath, audioDurationSeconds } = await generateKeyArtAudio({
        text: conceptName,
        destDir: destDir,
        filePrefix: "series_key_art",
      });

      // Persist to DB.
      await seriesState.upsertKeyArt(seriesId, "series", null, {}, imagePath, "generated with gemini flash");

      endTimer(timerName);
      logStep(`Series key art generated: ${imagePath}`);
      return JSON.stringify({
        status: "generated",
        path: imagePath,
        audioPath,
        audioDurationSeconds,
      });
    },
  });
}

/**
 * Deep-agent tool: generates the episode key art image featuring a single
 * main character and the episode premise/setting.
 * Single image produced via AnyAPI with Gemini Flash.
 * Idempotent and checkpointed.
 */
export function buildEpisodeKeyArtTool(
  seriesState: SeriesState,
  customState?: CustomStateStore,
  promptHash?: string
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_episode_key_art",
    description:
      "Generates the episode key art poster image featuring the single main character of this episode, " +
      "plus TTS audio of the episode title for the intro clip. " +
      "Uses Gemini Flash for vibrant, colorful poster-style illustration, strictly honouring the gender and appearance of human characters. " +
      "Call this AFTER character sheets are generated and BEFORE generating scene images. " +
      "Idempotent (skips if already approved for this episode). " +
      "Returns { path, audioPath, audioDurationSeconds }. Pass audioPath to assemble_episode_video " +
      "as episodeKeyArtAudioPath so the video intro plays the episode title aloud.",
    schema: z.object({
      seriesId: z.number().describe("The series id."),
      episodeNumber: z.number().describe("The episode number."),
      conceptName: z.string().describe("The series/concept title."),
      episodeTitle: z.string().describe("The episode title."),
      episodePremise: z.string().describe("Brief premise of this episode."),
      mainCharacterName: z.string().describe("The single main character to feature prominently in this episode's key art."),
      model: z.string().optional().describe("AnyAPI model. Default: google/gemini-3.1-flash-image."),
    }),
    func: async ({ seriesId, episodeNumber, conceptName, episodeTitle, episodePremise, mainCharacterName, model }) => {
      const timerName = `episode_${episodeNumber}_key_art`;
      startTimer(timerName);
      logStep(`Generating episode ${episodeNumber} key art featuring ${mainCharacterName}`);

      // Short-circuit if already approved.
      const existing = await seriesState.getKeyArt(seriesId, "episode", episodeNumber);
      if (existing?.approvedAt && existing.selectedPath) {
        logStep(`Episode ${episodeNumber} key art already approved, reusing`);
        // Still generate audio if missing (audio added after initial key art feature)
        const existingDestDir = path.join(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`, "key_art");
        const { audioPath, audioDurationSeconds } = await generateKeyArtAudio({
          text: episodeTitle,
          destDir: existingDestDir,
          filePrefix: `episode_${episodeNumber}_key_art`,
        });
        endTimer(timerName);
        return JSON.stringify({ status: "already_approved", path: existing.selectedPath, audioPath, audioDurationSeconds });
      }

      // Look up the main character's signature prompt, generating the sheet
      // on demand if a previous run never completed it.
      const mainCharacterDescription = await ensureCharacterBibleEntry({
        seriesState,
        seriesId,
        characterName: mainCharacterName,
        customState,
        promptHash,
        requestedBy: `episode ${episodeNumber} key art`,
      });

      // Look up other characters in the series to lock their appearances in the poster background
      const otherCharacters: Array<{ name: string; description: string }> = [];
      if (typeof seriesState.getSeriesCharacters === "function") {
        const characters = await seriesState.getSeriesCharacters(seriesId);
        if (characters) {
          for (const char of characters) {
            if (char.name !== mainCharacterName) {
              const sheet = await seriesState.getCharacterSheet(seriesId, char.name);
              otherCharacters.push({
                name: char.name,
                description: sheet?.generationPrompt || char.description,
              });
            }
          }
        }
      }

      const destDir = path.join(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`, "key_art");
      const checkpointKey = `key_art:episode:${seriesId}:${episodeNumber}`;
      const checkpointPath = customState && promptHash
        ? await customState.get<string>(promptHash, checkpointKey)
        : null;

      const prompt = buildEpisodeKeyArtPrompt({
        conceptName,
        episodeTitle,
        episodePremise,
        mainCharacterDescription,
        mainCharacterName,
        otherCharacters,
      });

      const imagePath = await generateReviewedKeyArt({
        prompt,
        destDir,
        filePrefix: `episode_${episodeNumber}_key_art`,
        model: model ?? DEFAULT_KEY_ART_MODEL,
        checkpoint: checkpointPath,
        artType: "episode",
        conceptText: `${conceptName}: ${episodeTitle} - ${episodePremise}`,
        characterNames: [mainCharacterName],
        characterDescriptions: [mainCharacterDescription],
      });

      // Persist checkpoint.
      if (customState && promptHash) {
        await customState.set(promptHash, checkpointKey, imagePath);
      }

      // Generate TTS audio for the episode title text.
      const { audioPath, audioDurationSeconds } = await generateKeyArtAudio({
        text: episodeTitle,
        destDir: destDir,
        filePrefix: `episode_${episodeNumber}_key_art`,
      });

      // Persist to DB.
      await seriesState.upsertKeyArt(seriesId, "episode", episodeNumber, {}, imagePath, "generated with gemini flash");

      endTimer(timerName);
      logStep(`Episode ${episodeNumber} key art generated: ${imagePath}`);
      return JSON.stringify({
        status: "generated",
        path: imagePath,
        audioPath,
        audioDurationSeconds,
      });
    },
  });
}
