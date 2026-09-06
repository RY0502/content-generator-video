import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, writeFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SeriesState } from "../state/seriesState.js";
import { CONFIG } from "../config.js";
import {
  selectCreatureIdentityCharacters,
  type SceneCharacterVisual,
} from "../promptBuilder.js";
import {
  generateCloudflareSceneImage,
} from "../providers/cloudflareImageClient.js";
import { generateAnyApiSceneImage, editAnyApiSceneImage } from "../providers/anyApiImageClient.js";
import { chatText, chatVision } from "../providers/aiClient.js";
import { materializeScenePrompt } from "../services/scenePromptService.js";
import { startTimer, endTimer, logSceneGenerated } from "../utils/logger.js";
import type { CustomStateStore } from "freetier-deepagent-framework";

const MAX_SCENE_QA_REGENERATIONS = 2;
const MAX_ANY_API_QA_REGENERATIONS = 2;
const MAX_CLOUDFLARE_IMG2IMG_ATTEMPTS = 3;

/** Smallest plausible PNG for a rendered scene; anything less is a truncated write. */
const MIN_VALID_IMAGE_BYTES = 1024;

/**
 * Returns true when a previously generated scene image on disk is complete
 * enough to reuse. A run killed mid-write can leave a zero-byte or truncated
 * file behind, which would otherwise be silently reused as a "finished" scene.
 */
async function isReusableImage(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const fileStat = await stat(filePath);
    return fileStat.size >= MIN_VALID_IMAGE_BYTES;
  } catch {
    return false;
  }
}

type SceneVisualQa = {
  pass: boolean;
  issues: string[];
  missingRequirements: string[];
};

function isCriticalQaIssue(text: string): boolean {
  const normalized = text.toLowerCase();

  // If the sentence is explicitly explaining that something is acceptable, correct, or has NO defects,
  // it is an affirmative pass explanation and must NOT trigger a defect.
  const isPassExplanation =
    normalized.includes("acceptable in this context") ||
    normalized.includes("is acceptable") ||
    normalized.includes("no visible body part mutations") ||
    normalized.includes("no visible body-part mutations") ||
    normalized.includes("no anatomical defects") ||
    normalized.includes("has no visible") ||
    normalized.includes("no extra limbs") ||
    normalized.includes("no duplicate") ||
    normalized.includes("present and correct") ||
    normalized.includes("are present and correct") ||
    normalized.includes("is present and correct") ||
    normalized.includes("matches the description") ||
    normalized.includes("correct (") ||
    normalized.includes("not an anatomical defect") ||
    normalized.includes("interacting together") ||
    normalized.includes("group scene") ||
    normalized.includes("worn as a backpack") ||
    normalized.includes("worn as an accessory") ||
    normalized.includes("worn by") ||
    normalized.includes("carried by");

  if (isPassExplanation) {
    return false;
  }

  // Exclude diegetic in-world text on physical props, signs, papers, etc. from triggering failures
  const isDiegeticInWorldText =
    (normalized.includes("sign") ||
     normalized.includes("paper") ||
     normalized.includes("newspaper") ||
     normalized.includes("board") ||
     normalized.includes("chalkboard") ||
     normalized.includes("blackboard") ||
     normalized.includes("book") ||
     normalized.includes("scroll") ||
     normalized.includes("map") ||
     normalized.includes("banner") ||
     normalized.includes("poster") ||
     normalized.includes("prop") ||
     normalized.includes("jar") ||
     normalized.includes("bottle") ||
     normalized.includes("box") ||
     normalized.includes("door") ||
     normalized.includes("wall") ||
     normalized.includes("in-world") ||
     normalized.includes("diegetic")) &&
    !normalized.includes("floating text") &&
    !normalized.includes("watermark") &&
    !normalized.includes("subtitle") &&
    !normalized.includes("ui overlay") &&
    !normalized.includes("text overlay");

  if (isDiegeticInWorldText) {
    return false;
  }

  const isGenderIssue =
    normalized.includes("gender") ||
    normalized.includes("boy instead of girl") ||
    normalized.includes("girl instead of boy") ||
    normalized.includes("male instead of female") ||
    normalized.includes("female instead of male") ||
    normalized.includes("depicted as a boy") ||
    normalized.includes("depicted as a girl") ||
    normalized.includes("drawn as a boy") ||
    normalized.includes("drawn as a girl") ||
    normalized.includes("wrong gender") ||
    normalized.includes("gender mismatch") ||
    normalized.includes("gender swap") ||
    normalized.includes("opposite gender");

  // Exclude all color, hair, clothing, outfit, skin tone, accessory, or shade notes
  // from triggering failures UNLESS it is a gender mismatch issue.
  const isMinorDetailNote =
    !isGenderIssue &&
    (normalized.includes("hair color") ||
     normalized.includes("hair") ||
     normalized.includes("clothing color") ||
     normalized.includes("clothing") ||
     normalized.includes("outfit") ||
     normalized.includes("shirt") ||
     normalized.includes("t-shirt") ||
     normalized.includes("dress") ||
     normalized.includes("hoodie") ||
     normalized.includes("jeans") ||
     normalized.includes("sweater") ||
     normalized.includes("skin tone") ||
     normalized.includes("skin color") ||
     normalized.includes("eye color") ||
     normalized.includes("eyes and") ||
     normalized.includes("lips") ||
     normalized.includes("shoes") ||
     normalized.includes("sneakers") ||
     normalized.includes("color mismatch") ||
     normalized.includes("wrong color") ||
     normalized.includes("character color") ||
     normalized.includes("bandana") ||
     normalized.includes("hat") ||
     normalized.includes("vest") ||
     normalized.includes("backpack straps") ||
     normalized.includes("glasses") ||
     normalized.includes("shade") ||
     normalized.includes("white collar") ||
     normalized.includes("gray hair") ||
     normalized.includes("cheeks") ||
     normalized.includes("correct appearance") ||
     normalized.includes("not matched"));

  const hasTrueDefect =
    isGenderIssue ||
    normalized.includes("extra limb") ||
    normalized.includes("extra hand") ||
    normalized.includes("extra arm") ||
    normalized.includes("three hand") ||
    normalized.includes("three arm") ||
    normalized.includes("third arm") ||
    normalized.includes("third hand") ||
    normalized.includes("extra leg") ||
    normalized.includes("three leg") ||
    normalized.includes("chimera") ||
    normalized.includes("cloned") ||
    normalized.includes("duplicate character") ||
    normalized.includes("duplicate object") ||
    normalized.includes("duplicate living object") ||
    normalized.includes("duplicate companion") ||
    normalized.includes("same character drawn twice") ||
    normalized.includes("same object drawn twice") ||
    normalized.includes("floating text") ||
    normalized.includes("text overlay") ||
    normalized.includes("caption overlay") ||
    normalized.includes("subtitle") ||
    normalized.includes("watermark") ||
    normalized.includes("ui overlay") ||
    normalized.includes("0 characters are expected") ||
    normalized.includes("0 character") ||
    normalized.includes("character is missing") ||
    normalized.includes("required character missing") ||
    normalized.includes("missing required character") ||
    normalized.includes("extra foreground character") ||
    normalized.includes("unrequested hat") ||
    normalized.includes("unrequested sunhat") ||
    normalized.includes("unrequested dress") ||
    normalized.includes("unrequested shirt") ||
    normalized.includes("unrequested clothing") ||
    normalized.includes("unrequested backpack") ||
    normalized.includes("unrequested glasses") ||
    normalized.includes("unwanted hat") ||
    normalized.includes("unwanted dress") ||
    normalized.includes("unwanted clothing") ||
    normalized.includes("unwanted backpack") ||
    normalized.includes("unwanted glasses") ||
    normalized.includes("invalid json");

  if (isMinorDetailNote && !hasTrueDefect) {
    return false;
  }

  return [
    // Text/UI overlays (only canvas-level overlays, watermarks, and UI elements)
    "floating text",
    "text overlay",
    "caption overlay",
    "subtitle overlay",
    "subtitles",
    "watermark",
    "digital watermark",
    "logo watermark",
    "gemini logo",
    "ai logo",
    "ui overlay",
    "invalid json",

    // Layout
    "stacked panels",
    "split/collage",
    "split panel",
    "collage layout",

    // Duplicates & clones (characters, creatures, and living object companions)
    "duplicate character",
    "duplicate characters",
    "duplicate person",
    "duplicate child",
    "duplicate creature",
    "duplicated character",
    "cloned character",
    "same character drawn more than once",
    "same character drawn twice",
    "same object drawn twice",
    "two living",
    "duplicate living object",
    "duplicate companion",
    "cloned object",

    // Missing required cast
    "character is missing",
    "characters are missing",
    "required character missing",
    "required characters missing",
    "missing required character",
    "missing required characters",
    "wrong number of characters",
    "multiple characters instead of",

    // Zero-character scenes & unexpected characters
    "0 character",
    "0 characters",
    "zero character",
    "zero characters",
    "no characters",
    "0 expected",
    "characters are expected",
    "characters were expected",
    "extra foreground character",
    "extra foreground characters",
    "unrequested character",
    "unrequested characters",
    "unexpected character",
    "unexpected characters",
    "unwanted character",
    "unwanted characters",

    // Unrequested wardrobe & accessory hallucinations
    "unrequested hat",
    "unrequested sunhat",
    "unrequested dress",
    "unrequested shirt",
    "unrequested clothing",
    "unrequested backpack",
    "unrequested glasses",
    "unwanted hat",
    "unwanted dress",
    "unwanted clothing",
    "unwanted backpack",
    "unwanted glasses",

    // Anatomical defects & extra limbs
    "chimera",
    "winged monkey",
    "winged squirrel",
    "wings on monkey",
    "wings on mammal",
    "wings on land",
    "hybrid mutation",
    "mutated body parts",
    "mutated body part",
    "extra limb",
    "extra limbs",
    "extra arm",
    "extra arms",
    "extra hand",
    "extra hands",
    "extra leg",
    "extra legs",
    "extra foot",
    "extra feet",
    "extra digit",
    "extra digits",
    "three arms",
    "three hands",
    "three legs",
    "more than two arms",
    "more than two hands",
    "more than two legs",
    "third arm",
    "third hand",
    "third leg",
    "mutated limb",
    "mutated limbs",
    "deformed limb",
    "deformed limbs",
    "malformed limb",
    "malformed limbs",
    "bad anatomy",
    "deformed anatomy",
    "anatomical defect",
    "anatomical anomaly",
    "anatomical mutation",

    // Emblems / spark artifacts (ignore in-world glitter, star glue, star dust, starlight, or props)
    ...(!normalized.includes("star glue") &&
      !normalized.includes("glitter") &&
      !normalized.includes("star dust") &&
      !normalized.includes("starlight") &&
      !normalized.includes("in-world") &&
      !normalized.includes("story prop")
        ? ["spark symbol", "spark mark", "sparkle symbol", "sparkle mark", "symbol on"]
        : []),

    // Gender mismatch & swaps
    "gender mismatch",
    "wrong gender",
    "boy instead of girl",
    "girl instead of boy",
    "male instead of female",
    "female instead of male",
    "depicted as a boy",
    "depicted as a girl",
    "drawn as a boy",
    "drawn as a girl",
    "gender swap",
    "opposite gender",
  ].some((needle) => normalized.includes(needle));
}

function shouldRegenerateFromQa(qa: SceneVisualQa): boolean {
  if (qa.pass) return false;
  return [...qa.issues, ...qa.missingRequirements].some(isCriticalQaIssue);
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

function logQaVerdict(sceneNumber: number, attempt: number, qa: SceneVisualQa): void {
  const label = attempt === 0 ? `[Scene ${sceneNumber}]` : `[Scene ${sceneNumber} QA regen ${attempt}]`;
  const critical = [...qa.issues, ...qa.missingRequirements].filter(isCriticalQaIssue);
  if (!qa.pass && critical.length === 0) {
    console.log(`${label} QA verdict: pass=${qa.pass} critical=0 → accepting (no critical issues)`);
  } else {
    console.log(`${label} QA verdict: pass=${qa.pass} critical=${critical.length}`);
  }
  if (qa.issues.length > 0) {
    console.log(`${label} QA issues: ${qa.issues.join(" | ")}`);
  }
  if (qa.missingRequirements.length > 0) {
    console.log(`${label} QA missing: ${qa.missingRequirements.join(" | ")}`);
  }
}

function parseSceneVisualQa(raw: string): SceneVisualQa {
  const parsed = JSON.parse(raw) as Partial<SceneVisualQa>;
  return {
    pass: parsed.pass === true,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    missingRequirements: Array.isArray(parsed.missingRequirements)
      ? parsed.missingRequirements.map(String)
      : [],
  };
}

async function normalizeQaResponse(raw: string): Promise<SceneVisualQa | null> {
  try {
    return parseSceneVisualQa(raw);
  } catch {
    try {
      const repaired = await chatText({
        systemPrompt:
          "You repair malformed QA verdicts for children's storybook scene review. " +
          "Return ONLY valid JSON with this exact shape: {\"pass\": boolean, \"issues\": string[], \"missingRequirements\": string[]}. " +
          "Do not add explanations or markdown fences.",
        userText:
          `Rewrite this QA verdict as strict JSON only:\n${raw}`,
      });
      return parseSceneVisualQa(repaired);
    } catch {
      return null;
    }
  }
}

/**
 * Saves a failed intermediate scene render using a provider-specific suffix
 * so AnyAPI QA regens and AnyAPI edit attempts can be inspected
 * independently after a run.
 */
async function saveFailedSceneImage(params: {
  destPath: string;
  bytes: Buffer;
  failIndex: number;
  stage: "anyapi_regen" | "anyapi_edit";
}): Promise<string> {
  const parsed = path.parse(params.destPath);
  const failPath = path.join(parsed.dir, `${parsed.name}_${params.stage}_fail_${params.failIndex}${parsed.ext}`);
  await mkdir(parsed.dir, { recursive: true });
  await writeFile(failPath, params.bytes);
  return failPath;
}

async function generateValidSceneImage(prompt: string, sceneLabel: string = "unknown"): Promise<{ bytes: Buffer; provider: string }> {
  let anyApiError: unknown;

  if (CONFIG.anyApiKeys.length > 0) {
    // Try AnyAPI with 2 top-level retries before falling back to Cloudflare.
    // Each call to generateAnyApiSceneImage already retries 3 times per key and rotates keys.
    for (let attempt = 1; attempt <= MAX_ANY_API_QA_REGENERATIONS; attempt++) {
      try {
        const bytes = await generateAnyApiSceneImage(prompt);
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new Error("AnyAPI returned an empty image buffer.");
        }
        console.log(`[${sceneLabel}] ✅ IMAGE GENERATED via AnyAPI${attempt > 1 ? ` (top-level attempt ${attempt})` : ""}`);
        return { bytes, provider: "AnyAPI" };
      } catch (error) {
        anyApiError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ANY_API_QA_REGENERATIONS) {
          console.warn(`[${sceneLabel}] AnyAPI top-level attempt ${attempt} failed: ${errorMessage}, retrying in 2s...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          console.warn(`[${sceneLabel}] AnyAPI failed after ${attempt} top-level attempts, falling back to Cloudflare: ${errorMessage}`);
        }
      }
    }
  } else {
    console.log(`[${sceneLabel}] No AnyAPI keys configured, using Cloudflare directly`);
  }

  let cloudflareError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bytes = await generateCloudflareSceneImage(prompt);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error("Cloudflare returned an empty image buffer.");
      }
      console.log(`[${sceneLabel}] ✅ IMAGE GENERATED via Cloudflare (fallback)${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return { bytes, provider: "Cloudflare" };
    } catch (error) {
      cloudflareError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[${sceneLabel}] Cloudflare attempt ${attempt}/3 failed: ${errorMessage}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }

  const anyApiMsg = anyApiError ? `AnyAPI: ${String(anyApiError)}` : "AnyAPI: not configured";
  const cloudflareMsg = `Cloudflare: ${String(cloudflareError)}`;
  throw new Error(`[${sceneLabel}] Scene image generation failed on all providers. ${anyApiMsg}; ${cloudflareMsg}`);
}

/** Reviews one generated scene image against its explicit visual requirements. */
async function reviewSceneImage(params: {
  image: Buffer;
  narrationText: string;
  action: string;
  characterNames: string[];
  characterVisuals?: SceneCharacterVisual[];
  characterDescriptions?: string[];
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
}): Promise<SceneVisualQa> {
  let characterAppearanceChecks = "";
  if (params.characterDescriptions && params.characterDescriptions.length > 0) {
    characterAppearanceChecks = "\n\nCRITICAL CHARACTER APPEARANCE REQUIREMENTS:\n";
    params.characterNames.forEach((name, idx) => {
      if (params.characterDescriptions && params.characterDescriptions[idx]) {
        characterAppearanceChecks += `- ${name}: ${stripColorCodes(params.characterDescriptions[idx])}\n`;
      }
    });
    characterAppearanceChecks +=
      "\nDo NOT fail for hair color, clothing color, outfit details, skin tones, eye colors, or shoe colors. " +
      "These are AI-generated storybook illustrations — exact color/outfit matching is impossible and not required. " +
      "PASS as long as each character is recognizably the right character/creature type and broadly matches its description. " +
      "Only note color or outfit differences as non-critical observations, never as failures.";
  }

  const guardedCreatureCharacters = selectCreatureIdentityCharacters(params.characterVisuals);
  const creatureIdentityChecks = guardedCreatureCharacters.length > 0
    ? "\n\nCREATURE IDENTITY NOTES (informational, NOT grounds for failure):\n" +
    guardedCreatureCharacters.map((item) => `- ${item.name}${item.speciesOrType ? ` (${item.speciesOrType})` : ""}: should be recognizable as this animal/creature type.`).join("\n") +
    "\nDo NOT fail if cartoon animals have anthropomorphic features like expressive human-like faces, walking upright, " +
    "wearing clothes, or having stylized body proportions. This is the EXPECTED art style for children's storybook illustrations. " +
    "Only note if a character is drawn as a completely different species (e.g. cat instead of monkey)."
    : "";

  let supportingEntityChecks = "";
  if (params.supportingEntities && params.supportingEntities.length > 0) {
    supportingEntityChecks = "\n\nCRITICAL SUPPORTING ENTITY REQUIREMENTS:\n";
    params.supportingEntities.forEach((entity, index) => {
      supportingEntityChecks += `- Supporting entity ${index + 1}: ${entity}\n`;
    });
    supportingEntityChecks +=
      "\nNote: Required supporting entities/creatures described above are EXPECTED in the scene and MUST NOT be flagged as unrequested characters.";
  }

  const charCount = params.characterNames.length;
  const hasSupportingEntities = Boolean(params.supportingEntities && params.supportingEntities.length > 0);
  const castDescription = charCount === 0
    ? (hasSupportingEntities
        ? `0 main characters, but supporting entities/creatures ARE expected: ${params.supportingEntities!.join(", ")}.`
        : "EXACTLY 0 characters (scenery/landscape ONLY — no characters, people, children, or animals of any kind).")
    : `exactly ${charCount} character(s): ${params.characterNames.join(", ")}. Each character must be drawn exactly ONCE without duplicate copies or clones.`;

  const sceneContextBlock = [
    params.narrationText ? `Scene Narration: ${params.narrationText}` : "",
    `Action: ${params.action}`,
    params.sceneDetails ? `Scene Details: ${params.sceneDetails}` : "",
  ].filter(Boolean).join("\n");

  const response = await chatVision({
    systemPrompt:
      "You are a QA reviewer for children's storybook scene images. " +
      "Return ONLY valid JSON: {\"pass\": boolean, \"issues\": string[], \"missingRequirements\": string[]}. " +
      "FAIL the image ONLY if one of these serious structural defects is clearly present:\n" +
      "- Artificial text overlays, subtitles, UI captions, watermarks, AI logos/signatures, or floating character name tags stamped on top of the image canvas (NOTE: in-world physical text/lettering drawn on props like signs, boards, newspapers, papers, scrolls, books, maps, banners, chalkboards, or object labels is completely ACCEPTABLE and EXPECTED as part of story narration and scene environment; do NOT fail for in-world prop text)\n" +
      "- Duplicated or stacked panels (same scene repeated in the image)\n" +
      "- Split/collage layout instead of a single continuous scene\n" +
      "- Anatomical defects or physical body-part mutations on an individual character (e.g. extra limbs, extra arms, extra hands, three arms/hands, extra legs growing from one torso, mutated appendages, wings/feathers on a land mammal; mixed-species chimeras). NOTE: in group scenes where figures interact, touch shoulders, or stand close together, overlapping hands/arms are normal and must NOT be misclassified as anatomical defects\n" +
      "- When 0 characters are expected (pure scenery/landscape-only scene with NO supporting entities): ANY person, child, human, or extra character figure present in the image\n" +
      "- A required character is completely missing or replaced by a totally different species\n" +
      "- Duplicate copies or clones of a character drawn multiple times in the same scene (NOTE: living object companions or mascot items like backpacks, books, or toys worn/carried by characters count as present and are NOT duplicate characters). During group or teamwork actions (like pulling, pushing, carrying, building), carefully inspect each figure's clothing: if two or more figures wear identical outfits (e.g. two boys in identical striped shirts), FAIL for duplicate characters\n" +
      "- Unrequested extra foreground characters that clearly compete with or replace the required cast (NOTE: distinct background friends or supporting figures that react in accordance with the scene narration/details are NOT unrequested extra characters and are acceptable)\n" +
      "- Major unrequested clothing, hats, sunhats, dresses, or extra backpacks on characters whose locked descriptions do not specify them (e.g. non-clothed animal characters suddenly wearing full dresses, sunhats, or extra backpacks)\n" +
      "- Character gender mismatch: For human characters, FAIL if a girl character is depicted as a boy, or a boy character is depicted as a girl, or if opposite-gender presentation is shown\n" +
      "- Any artificial spark symbol, sparkle mark, glowing spark, geometric emblem, or decorative symbol/watermark stamped on a character's face, forehead, or body (NOTE: In-world storybook environmental effects, glitter, star glue, star dust, starlight, water sparkles, or glowing magic described in the scene narration, action, details, or props are INTENDED story elements and NEVER defects or spark symbol violations. Only fail for artificial corporate logos, AI watermarks, or geometric emblem stamps on a character's face or forehead)\n" +
      "\nDo NOT fail for any of the following — these are expected in children's storybook art and are ALWAYS acceptable:\n" +
      "- In-world physical text/letters on props, signs, newspapers, papers, boards, books, chalkboards, scrolls, maps, or packaging — these are part of the storybook environment/narration and are ALWAYS acceptable\n" +
      "- In-world storybook environmental effects, glitter, star glue, star dust, glowing constellations, starlight, sparkles, or illuminated magical particles described in the narration, action, details, or props — these are INTENDED magical story elements and NEVER defects or spark symbol violations\n" +
      "- Living object characters, inanimate companions, or mascot items with stylized cartoon limbs, eyes, smiles, or playful features — this IS their intended design and is NEVER an anatomical defect. Living companions worn, carried, held, or positioned near characters are considered present and NOT unrequested accessories or duplicates\n" +
      "- Multi-character group scenes: In group scenes with multiple characters (such as groups of children, friends, or companions), if the figures are visibly present and interacting in the scene, minor styling, pose, expression, or accessory differences MUST NOT cause individual characters to be marked as missing or replaced. If all members or children representing the group are visible, all characters are considered present. Overlapping or interacting figures (hands on shoulders, standing close) are fully acceptable\n" +
      "- Differences in hair color, clothing color, outfit details, skin tones, eye colors, or shoes — these are expected in AI art and must NEVER fail an image (UNLESS it causes a girl to look like a boy or a boy to look like a girl)\n" +
      "- Supporting creatures, dinosaurs, guest characters, guides, scribes, or animals that are mentioned in the action, narration, scene details, or supporting entities — these are EXPECTED story elements and must NEVER be flagged as unrequested extra characters\n" +
      "- Anthropomorphic/humanoid cartoon animals (animals walking upright, with expressive faces) — this IS the expected storybook style\n" +
      "- Distinct background friends, guides, scribes, or supporting animals reacting naturally to the scene context or mentioned in the narration/details/supporting entities\n" +
      "- Minor accessory positioning or styling differences (e.g. bandana around neck vs on head, backpack strap side, belt color) — subtle variations in AI art are acceptable as long as characters don't gain entirely new unrequested wardrobe items like hats, dresses, or extra bags\n" +
      "- Color shade deviations or inexact color matching (e.g. slightly different fur/skin/glow color)\n" +
      "- Minor feature inaccuracies (e.g. slightly different eye color, tail pattern)\n" +
      "- Painterly style variations, soft edges, or artistic interpretation\n" +
      "\nPASS if: single continuous scene, no floating text overlays or watermarks across the canvas, no duplicated panels, no anatomical defects (no extra limbs or three hands on a single figure), no duplicate/cloned characters, correct human character genders (no gender swaps), and matching the expected cast count, setting, and canonical appearance. " +
      "Be generous with normal storybook cartoon styling, in-world props/signs, outfit/color nuances, and accessory placement, but strictly fail anatomical mutations, 0-character scene violations, duplicate/cloned characters, floating text overlays, gender mismatches, and major unrequested wardrobe hallucinations.",
    userText:
      `Expected cast: ${castDescription}\n` +
      `${sceneContextBlock}\n` +
      characterAppearanceChecks +
      creatureIdentityChecks +
      supportingEntityChecks +
      `\n\nQA Checks:\n` +
      `(1) Is there ANY artificial floating text overlay, watermark, subtitle, UI caption, or AI logo stamped across the image canvas? FAIL if yes. (Note: in-world physical text/lettering on signs, boards, newspapers, papers, scrolls, maps, chalkboards, or props is completely fine and EXPECTED — do NOT fail for in-world text).\n` +
      `(2) Is the image split into multiple panels or the same scene stacked/repeated? FAIL if yes.\n` +
      `(3) Are there any anatomical defects or mutations — specifically check for mutated anatomy on an individual figure (e.g. a single character clearly having three arms, three hands, or extra limbs growing from their torso)? Interacting friends touching or overlapping in a group scene are normal and NOT defects. FAIL only if an individual figure has mutated anatomy. (Note: stylized cartoon eyes/arms on living objects or companion characters are intentional design and NOT anatomical defects).\n` +
      `(4) Are there any DUPLICATE copies, clones, or multiple instances of ANY character? Check every figure's outfit and hair. If two or more figures wear identical clothes (e.g. two boys in identical striped shirts), they are clones! FAIL and specify clearly which identical figures are duplicates. Living object companions (e.g. a living backpack, talking toy, companion item) worn/carried by a character are valid and not duplicates.\n` +
      `(5) Cast presence: If 0 characters were expected, is the image completely empty of characters/figures? (Note: supporting creatures or animals mentioned in supporting entities are expected and MUST NOT be failed). If characters were expected, are the required characters present? (Note: In group scenes with multiple characters such as children or friends, if the group is visible and interacting, all characters are considered present. Do NOT mark individual characters as missing or replaced due to minor differences in pose, hairstyle, clothing, or accessories. Companion characters or living objects may be held, carried, worn, or standing near other characters, and figures standing close together or partially overlapping must NOT be marked as missing).\n` +
      `(6) Are the required named characters recognizably the correct animal/creature types? Only FAIL if a character is a completely wrong species or has chimera body parts. Do NOT fail for hair color, clothing color, outfit styling, skin tones, anthropomorphic styling, humanoid posing, or expressive faces — these are the EXPECTED children's book art style.\n` +
      `(7) Are the characters broadly recognizable as the right species/types? Do NOT fail for color shade deviations, hair colors, clothing colors, outfit styling, accessory positioning (e.g. bandana around neck vs head), or minor feature differences — these are expected in AI art.\n` +
      `(8) Does the scene match the action and details without unrequested foreground figures clearly replacing the cast? Ignore harmless background foliage, distant silhouettes, or non-character texture details. Distinct background friends, guest characters, guides, scribes, or supporting figures reacting in accordance with the scene context, narration, action, details, or supporting entities are acceptable and expected.\n` +
      `(9) Does any character have an artificial spark symbol, sparkle mark, geometric emblem, AI watermark, or logo stamped on their face, forehead, or body? FAIL if yes. (Note: in-world story props, glitter, star glue, star dust, starlight, or glowing particles described in the story action/narration are completely fine and EXPECTED — do NOT fail for in-world glitter or magic sparkles).\n` +
      `(10) Unrequested wardrobe/accessories: Did any character gain major unrequested clothing or accessories not listed in their locked description (such as large unrequested hats/sunhats, dresses, jackets, or extra backpacks on characters whose descriptions do not specify them)? FAIL if a character has gained major unrequested clothing/accessories.\n` +
      `(11) GENDER & CHARACTER INTEGRITY: For all human characters, does each character strictly match their specified gender (boy vs girl) and hairstyle? FAIL if any girl character is depicted as a boy, or any boy character is depicted as a girl, or if the number of boys and girls does not match the character definitions.`,
    imageBase64: params.image.toString("base64"),
    mimeType: "image/png",
  });

  const normalizedQa = await normalizeQaResponse(response);
  if (!normalizedQa) {
    return {
      pass: false,
      issues: ["QA reviewer returned invalid JSON; image must be regenerated instead of accepted."],
      missingRequirements: ["Valid structured QA verdict for required characters, text visibility, and scene composition."],
    };
  }

  return normalizedQa;
}

/**
 * Calls an LLM with the failed image + QA issues to generate a surgically
 * targeted fix prompt. The LLM sees the actual image so it can produce
 * minimal, concrete edit instructions (e.g. "remove the extra third hand"
 * rather than "draw a monkey with two hands").
 */
async function buildLlmTargetedFixPrompt(params: {
  image: Buffer;
  qa: SceneVisualQa;
  characterNames: string[];
  characterDescriptions?: string[];
  narrationText: string;
  action: string;
  sceneDetails?: string;
  attempt: number;
}): Promise<string> {
  const issues = params.qa.issues.filter(Boolean);
  const missing = params.qa.missingRequirements.filter(Boolean);
  const charCount = params.characterNames.length;
  const castDescription = charCount === 0
    ? "0 characters (scenery/landscape ONLY)"
    : `${charCount} character(s): ${params.characterNames.join(", ")}`;

  let characterContext = "";
  if (params.characterDescriptions && params.characterDescriptions.length > 0) {
    characterContext = "\n\nCharacter appearance references:\n";
    params.characterNames.forEach((name, idx) => {
      if (params.characterDescriptions && params.characterDescriptions[idx]) {
        characterContext += `- ${name}: ${stripColorCodes(params.characterDescriptions[idx])}\n`;
      }
    });
  }

  const sceneContextBlock = [
    params.narrationText ? `Scene Narration: ${params.narrationText}` : "",
    `Action: ${params.action}`,
    params.sceneDetails ? `Scene Details: ${params.sceneDetails}` : "",
  ].filter(Boolean).join("\n");

  const response = await chatVision({
    systemPrompt:
      "You are an expert image-editing prompt engineer for children's storybook illustrations. " +
      "You will be shown a scene image that failed QA along with the complete list of QA issues and missing requirements. " +
      "Your goal is to write a MINIMAL, TARGETED fix prompt that comprehensively resolves ALL reported issues in ONE single edit step. " +
      "Do NOT describe the entire scene from scratch or ask for a full redraw. Focus strictly on repairing all reported defects simultaneously.\n\n" +
      "CRITICAL: FIX ALL ISSUES IN ONE GO:\n" +
      "- You MUST systematically address EVERY SINGLE issue and missing requirement listed in the QA report. Never fix only one issue and ignore others.\n" +
      "- If multiple characters or elements have issues (e.g. extra limb on one figure, duplicate copy of another, unrequested hat/clothing on a third, and text overlay), include explicit instructions for ALL of them in this single prompt so that the image is fully corrected in one step.\n\n" +
      "SURGICAL FIX GUIDELINES:\n" +
      "1. REMOVALS (Unwanted elements & defects):\n" +
      "   - Extra limbs/hands/appendages: 'Remove the extra [limb/hand/third arm] from [character]'.\n" +
      "   - Duplicate characters/clones/objects: IDENTIFY WHICH FIGURES ARE CLONES. When two or more figures wear the identical outfit, hair, or colors (such as two boys wearing the exact same blue-striped shirt, or two girls in the exact same dress), those identical figures ARE the duplicates! Explicitly specify which identical clone to remove by exact visual position (e.g. 'Remove the middle boy wearing the blue-striped shirt, leaving only ONE instance of Milo'). NEVER misidentify a unique character wearing different clothes as a duplicate!\n" +
      "   - Unrequested clothing/hats/bags: 'Remove the unrequested [hat/dress/shirt/backpack] from [character] so their appearance strictly matches their locked description'.\n" +
      "   - Floating text/watermarks/spark symbols: 'Remove any floating text overlays, subtitles, captions, watermarks, or spark symbols from the image canvas (preserve in-world signs, papers, and story props)'.\n" +
      "   - 0-character scenes: 'Remove all characters/people/animals/figures from the scene, leaving only the background landscape/environment'.\n" +
      "2. ADDITIONS / RESTORATIONS:\n" +
      "   - Missing characters: 'Add [character] with [locked features/colors] at [logical position] in the scene'.\n" +
      "   - Required props/supporting entities: 'Add [required supporting entity/prop] to the scene as described'.\n" +
      "3. CORRECTIONS (Anatomy & Features):\n" +
      "   - Wrong species/colors/features: 'Correct [character]'s [feature/color] to [specified appearance]'.\n" +
      "- NEVER remove valid, required characters when characters are expected.\n\n" +
      "ALWAYS end your prompt with this exact preservation footer:\n" +
      "'Preserve the exact storybook illustration style, background, colours, and lighting of the image. " +
      "Do not introduce any new duplicate animals, clones, extra characters, or text.'\n\n" +
      "Return ONLY the fix prompt text. No explanations, no markdown, no JSON wrapping.",
    userText:
      `This children's storybook illustration failed QA review (attempt ${params.attempt}).\n\n` +
      `Expected cast: ${castDescription}\n` +
      `${sceneContextBlock}\n` +
      characterContext +
      `\nQA ISSUES THAT MUST BE FIXED:\n` +
      (issues.length > 0 ? issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n") : "(none)") +
      (missing.length > 0 ? `\n\nMISSING REQUIREMENTS:\n` + missing.map((m, i) => `${i + 1}. ${m}`).join("\n") : "") +
      `\n\nLook at the image carefully and write a minimal, comprehensive fix prompt that addresses ALL the issues and missing requirements above in one go.`,
    imageBase64: params.image.toString("base64"),
    mimeType: "image/png",
  });

  // Clean up the response — strip any markdown fences or quotes the LLM might add
  let fixPrompt = response.trim();
  fixPrompt = fixPrompt.replace(/^```[\s\S]*?\n/, "").replace(/\n```$/, "");
  fixPrompt = fixPrompt.replace(/^"|"$/g, "");

  // Ensure the preservation footer is present
  if (!fixPrompt.toLowerCase().includes("preserve the exact storybook illustration style")) {
    fixPrompt += " Preserve the exact storybook illustration style, background, colours, and lighting of the image. " +
      "Do not introduce any new duplicate animals, clones, extra characters, or text.";
  }

  console.log(`[Fix Prompt Attempt ${params.attempt}] ${fixPrompt.slice(0, 200)}...`);
  return fixPrompt;
}

/**
 * Deep-agent tool: generates a single cinematic story scene purely from a
 * text prompt via Pollinations (no img2img, no reference image of any kind).
 * The prompt is built by first looking up each named character's saved,
 * highly detailed `generationPrompt` (from generate_character_sheet) --
 * only for characters applicable to this scene -- then appending the scene's
 * location, action, camera, lighting, and any episode-local recurring
 * supporting-entity continuity anchors.
 * Idempotent: if this scene's image file already exists on disk (e.g. a
 * previous run generated it before crashing/stopping), it is reused
 * instead of regenerated.
 */
export function buildSceneImageTool(
  seriesState: SeriesState,
  customState?: CustomStateStore,
  promptHash?: string
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_scene_image",
    description:
      "Generates one scene image for an episode (skipped/reused if already generated for this scene number) " +
      "using pure text-to-image generation (no reference image). The prompt follows a locked three-part " +
      "architecture: (1) a global style bible for consistent watercolor picture-book rendering, (2) locked " +
      "character bible descriptions looked up from the database, (3) optional episode-local supporting-entity continuity anchors, " +
      "(4) scene-specific action/pose/emotion. " +
      "Camera angles are mapped to 3 fixed presets (establishing/medium/close). Lighting is locked. " +
      "Pass only the character names actually present in THIS scene. Never re-describe a location differently between scenes.",
    schema: z.object({
      seriesId: z.number(),
      episodeNumber: z.number(),
      sceneNumber: z.number(),
      characterNames: z.preprocess(
        (val) => {
          if (typeof val === "string") {
            try {
              return JSON.parse(val);
            } catch {
              return val;
            }
          }
          return val;
        },
        z.array(z.string())
      ).describe(
        "Exact names of ONLY the characters present in this scene, in the order they should be described. " +
        "If a character has no approved sheet yet, this tool generates it automatically."
      ),
      characterVisuals: z.preprocess(
        (val) => {
          if (typeof val === "string") {
            try {
              return JSON.parse(val);
            } catch {
              return val;
            }
          }
          return val;
        },
        z.array(z.object({
          name: z.string(),
          visualForm: z.enum(["real_creature", "humanoid", "anthropomorphic_creature", "object_character", "fantasy_creature"]),
          speciesOrType: z.string().optional(),
          humanoidAllowed: z.boolean().optional(),
        }))
      ).optional().describe(
        "Optional structured ontology metadata for scene characters. Should align 1:1 with characterNames in order and specify each character's body form explicitly."
      ),
      environmentDescription: z.string().describe("Verbatim fixed description of this scene's location."),
      narrationText: z.string().describe("The complete story narration for this scene."),
      action: z.string().describe("What is happening in this scene."),
      supportingEntities: z.preprocess(
        (val) => {
          if (typeof val === "string") {
            try {
              return JSON.parse(val);
            } catch {
              return val;
            }
          }
          return val;
        },
        z.array(z.string())
      ).optional().describe(
        "Optional recurring non-main characters or secondary figures that must stay visually consistent across this episode. " +
        "Provide verbatim descriptors as a JSON array, e.g. [\"Ant leader: tiny black ant with a shiny chestnut head\"]."
      ),
      continuityAnchors: z.preprocess(
        (val) => {
          if (typeof val === "string") {
            try {
              return JSON.parse(val);
            } catch {
              return val;
            }
          }
          return val;
        },
        z.array(z.string())
      ).optional().describe(
        "Optional recurring visual continuity constraints for props, layout, or setup that should persist across adjacent scenes until the narration clearly changes them. " +
        "Provide verbatim descriptors as a JSON array, e.g. [\"Picnic setup: red-and-white checkered blanket spread on grass with apple slices, cookies, and leaf cups.\"]"
      ),
      sceneDetails: z.string().optional().describe(
        "All scene details in ONE string: character emotions, poses, movements, and prop interactions. " +
        "Example: 'Pip: happy, standing tall, waving. Nibbles: curious, sitting, holding a nut. Props: picnic basket on grass.'"
      ),
      cameraAngle: z.string().default("establishing").describe("Camera preset: establishing/medium/close."),
      lighting: z.string().default("warm morning sunlight").describe("Lighting."),
    }),
    func: async ({
      seriesId,
      episodeNumber,
      sceneNumber,
      characterNames,
      characterVisuals,
      environmentDescription,
      narrationText,
      action,
      supportingEntities,
      continuityAnchors,
      sceneDetails,
      cameraAngle,
      lighting,
    }) => {
      const timerName = `scene_${sceneNumber}`;
      startTimer(timerName);

      const destPath = path.join(
        CONFIG.outputDir,
        `series_${seriesId}`,
        `episode_${episodeNumber}`,
        "scenes",
        `scene_${String(sceneNumber).padStart(3, "0")}.png`
      );
      // Reuse a previously generated image only when it is actually complete;
      // a truncated file from an interrupted run is discarded and regenerated.
      if (existsSync(destPath)) {
        if (await isReusableImage(destPath)) {
          return JSON.stringify({ path: destPath, status: "already_generated" });
        }
        console.warn(`[Scene ${sceneNumber}] Existing image is incomplete, regenerating.`);
        await rm(destPath, { force: true });
      }

      const materializedPrompt = await materializeScenePrompt({
        seriesState,
        customState,
        promptHash,
        requestedBy: `scene ${sceneNumber}`,
        allowCharacterSheetGeneration: true,
        input: {
          seriesId,
          sceneNumber,
          characterNames,
          characterVisuals,
          environmentDescription,
          narrationText,
          action,
          supportingEntities,
          continuityAnchors,
          sceneDetails,
          cameraAngle,
          lighting,
        },
      });
      const canonicalCharacterNames = materializedPrompt.characterNames;
      const characterDescriptions = materializedPrompt.characterDescriptions;
      const basePrompt = materializedPrompt.prompt;

      const sceneLabel = `Scene ${sceneNumber}`;
      let prompt = basePrompt;
      let { bytes, provider } = await generateValidSceneImage(prompt, sceneLabel);
      let qa: SceneVisualQa = { pass: false, issues: ["QA not run"], missingRequirements: [] };
      let failImageCount = 0;
      let img2ImgCount = 0;
      qa = await reviewSceneImage({
        image: bytes,
        narrationText,
        action,
        characterNames: canonicalCharacterNames,
        characterVisuals,
        characterDescriptions,
        supportingEntities,
        continuityAnchors,
        sceneDetails,
      });
      logQaVerdict(sceneNumber, 0, qa);

      const maxRegenAttempts = CONFIG.sceneQaEditAttempts > 0 ? CONFIG.sceneQaEditAttempts : 2;
      for (let attempt = 1; attempt <= maxRegenAttempts && shouldRegenerateFromQa(qa); attempt++) {
        await saveFailedSceneImage({
          destPath,
          bytes,
          failIndex: ++failImageCount,
          stage: "anyapi_edit",
        });

        img2ImgCount++;
        const editPrompt = await buildLlmTargetedFixPrompt({
          image: bytes,
          qa,
          characterNames: canonicalCharacterNames,
          characterDescriptions,
          narrationText,
          action,
          sceneDetails,
          attempt,
        });

        try {
          bytes = await editAnyApiSceneImage({
            prompt: editPrompt,
            imageBytes: bytes,
          });
          provider = "AnyAPI-edit";
        } catch (editError) {
          const editMsg = editError instanceof Error ? editError.message : String(editError);
          console.warn(`[${sceneLabel}] ⚠️ img2img edit failed (attempt ${attempt}): ${editMsg}`);
          console.warn(`[${sceneLabel}] Using last available image as final`);
          break;
        }

        qa = await reviewSceneImage({
          image: bytes,
          narrationText,
          action,
          characterNames: canonicalCharacterNames,
          characterVisuals,
          characterDescriptions,
          supportingEntities,
          continuityAnchors,
          sceneDetails,
        });
        logQaVerdict(sceneNumber, attempt, qa);
      }

      if (shouldRegenerateFromQa(qa) && qa.issues.some((i) => i.toLowerCase().includes("duplicate"))) {
        console.warn(`[${sceneLabel}] ⚠️ Duplicate character issue persists. Attempting fresh text-to-image regeneration with anti-duplicate enforcement...`);
        try {
          const freshPrompt = `${basePrompt} STRICT ANTI-DUPLICATE RULE: Exactly ${canonicalCharacterNames.length} characters in total. Each character appears exactly once. Never draw two figures in identical clothes.`;
          const fresh = await generateValidSceneImage(freshPrompt, sceneLabel);
          const freshQa = await reviewSceneImage({
            image: fresh.bytes,
            narrationText,
            action,
            characterNames: canonicalCharacterNames,
            characterVisuals,
            characterDescriptions,
            supportingEntities,
            continuityAnchors,
            sceneDetails,
          });
          logQaVerdict(sceneNumber, 99, freshQa);
          if (freshQa.pass || freshQa.issues.length < qa.issues.length) {
            bytes = fresh.bytes;
            provider = fresh.provider;
            qa = freshQa;
          }
        } catch (freshErr) {
          console.warn(`[${sceneLabel}] Fresh text-to-image fallback failed: ${freshErr}`);
        }
      }

      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, bytes);
      console.log(`[${sceneLabel}] 📦 Final image saved (provider: ${provider}, img2img corrections: ${img2ImgCount}, failed images saved: ${failImageCount})`);

      endTimer(timerName);
      logSceneGenerated({
        sceneNumber,
        characterNames: canonicalCharacterNames,
        characters: characterDescriptions,
        environment: environmentDescription,
        action,
        emotions: sceneDetails ? [sceneDetails] : undefined,
        poses: undefined,
        movements: undefined,
        objectInteractions: sceneDetails,
        path: destPath,
      });

      return JSON.stringify({ path: destPath, status: "generated" });
    },
  });
}
