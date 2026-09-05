/**
 * Prompt architecture for consistent children's storybook media.
 *
 * Every video-scene prompt is assembled in strict layer order. Character
 * portraits are the only generated images; scene prompts feed Agnes directly.
 *   1. GLOBAL STYLE BIBLE (never changes) — illustration style, rendering,
 *      lighting, composition, and negative prompts.
 *   2. CHARACTER BIBLE (never changes per character) — locked descriptions
 *      stored as generationPrompt in the database.
 *   3. SCENE PROMPT (changes every video scene) — camera preset, environment,
 *      story moment, action, poses, emotions, props.
 *
 * Character portraits still use their own builder but share the same
 * STYLE_BIBLE and CONSISTENCY_BLOCK so sheets and scenes look like they
 * belong to the same show.
 */
import type { CharacterDef } from "./state/seriesState.js";

export interface StylizedImageSpec {

  subjectDescription: string;
  personalityOrExpression?: string;
  backgroundType?: string;
  backgroundColor?: string;
  cameraAngle?: string;
  framing?: string;
  kidsFriendly?: boolean;
  ultraCuteMode?: boolean;
}

// ---------------------------------------------------------------------------
// PART 1 — GLOBAL STYLE BIBLE  (never changes)
// ---------------------------------------------------------------------------

/** Illustration style — the single most important consistency anchor. */
const STYLE_BIBLE =
  "A single continuous full-bleed cinematic children's storybook animation shot — one location and one story beat. " +
  "Premium children's storybook visual design. Modern 2D animated style. " +
  "Soft painterly digital art, hand-painted appearance, matte finish. " +
  "Rounded appealing character designs, large expressive eyes, child-friendly proportions, " +
  "readable silhouettes and warm friendly body language. " +
  "Vibrant cheerful colours with natural saturation, soft global illumination. " +
  "Rich detailed environment with clear foreground, middle ground and background depth. " +
  "16:9 landscape composition. Stable artistic style for the entire shot and across scenes. " +
  "CRITICAL: Every character must match their given description EXACTLY " +
  "in every scene — same fur/skin/body colors, same eye color, same clothing, same accessories, " +
  "same markings. Never change a character's color palette between scenes. " +
  "Characters must wear or carry ONLY what is explicitly specified in their locked description — " +
  "never add unrequested clothing, hats, caps, sunhats, dresses, shirts, shoes, bags, satchels, or glasses.";

/** Locked rendering — prevents Pixar / CGI drift. */
const RENDERING_BIBLE =
  "No 3D. No CGI. No photorealism. No anime.";

/**
 * Shared character-integrity exclusions for every scene and key-art video.
 * Keep the short "No ..." phrases explicit: video models tend to respond more
 * reliably to these concrete defects than to a generic "bad anatomy" clause.
 * The appendage wording remains species-safe for insects, birds, snakes, etc.
 */
export const CHARACTER_INTEGRITY_NEGATIVE_BIBLE =
  "No duplicate characters, cloned characters, duplicate living objects, or duplicate companion characters. " +
  "No extra limbs or duplicated appendages beyond each character's locked species and body form. " +
  "No double heads, extra heads, duplicated faces, fused heads, or conjoined heads.";

/** Negative prompt — critical constraints, stated once, at the end. */
const NEGATIVE_BIBLE =
  "Avoid: any floating text overlays, subtitles, captions, digital UI text, character name tags, stamped titles, or watermarks; " +
  "split panels, stacked images, collage, comic strip layout, before/after layout or duplicated frames; " +
  "wings or feathers on non-bird land mammals (such as winged monkeys or winged squirrels); chimera body parts; " +
  "the same character drawn more than once; duplicate or cloned characters; duplicate living objects or companion characters; characters wearing an item while a duplicate living version is nearby; multiple copies of the same named or described individual (distinct required characters of the same species are allowed); " +
  "gender swap, depicting girls as boys, depicting boys as girls, wrong character gender, opposite gender appearance; " +
  "floating characters, cropped bodies, missing body parts, extra or duplicated appendages beyond the character's locked species and body form, malformed limbs, deformed anatomy, bad anatomy, mutated body parts, headshots; " +
  "unrequested hats, sunhats, unrequested dresses, unrequested shirts, unrequested clothing or outfits on non-clothed characters, unrequested extra backpacks or bags; " +
  "extra or wrong characters beyond those explicitly required for the scene; logos; watermarks; " +
  "spark symbols, sparkle marks, glowing stars, or any decorative symbols/emblems on characters' faces or foreheads. " +
  CHARACTER_INTEGRITY_NEGATIVE_BIBLE;

// ---------------------------------------------------------------------------
// Camera presets — only 3 allowed, no freeform strings
// ---------------------------------------------------------------------------

/** Fixed camera presets that prevent jarring visual jumps between scenes. */
export type CameraPreset = "establishing" | "medium" | "close";

const CAMERA_PRESETS: Record<CameraPreset, string> = {
  establishing:
    "Wide storybook scene. Camera slightly above eye level. " +
    "Characters occupy 35-45% of frame. Large environment visible.",
  medium:
    "Medium storybook shot. Characters occupy 55% of frame. " +
    "Environment still visible. No portrait composition.",
  close:
    "Medium-close storybook shot. Character occupies 60%. " +
    "Background remains visible. No headshot. No portrait. No cropped body.",
};

/**
 * Maps a freeform camera string from the scene data to the closest fixed
 * preset. Falls back to "establishing" for unknown values.
 */
export function resolveCameraPreset(raw: string): CameraPreset {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("close")) return "close";
  if (lower.includes("medium") || lower.includes("two-shot")) return "medium";
  return "establishing";
}

// Legacy constants kept for the portrait and generic builders that still
// reference them. Scene prompts use the new bibles above.
const CORE_STYLE =
  "Premium children's storybook illustration. " +
  "Modern 2D animated storybook style inspired by high-end family animated films. " +
  "Soft painterly digital illustration. Hand-painted appearance. Matte finish. " +
  "Rounded appealing character design. Large expressive eyes. Cute child-friendly proportions. " +
  "Soft fluffy fur. Simple clean shapes. Friendly facial expressions. " +
  "Bright cheerful colour palette. Warm morning sunlight. Soft global illumination. " +
  "Warm and friendly demeanor, absolutely NOT scary or menacing. " +
  "Wholesome cheerful playful mood suitable for a children's show. " +
  "No realistic rendering. No CGI. No photorealism. No Pixar. No 3D. No cel shading. No anime. No oil painting.";

const CONSISTENCY_BLOCK =
  "identical illustration style, lighting, color grading, and rendering technique as the rest of this series, " +
  "no logos, no watermarks, no clutter, no extra objects unless specified, no text, no labels, " +
  "no spark symbols, no sparkle marks, no glowing stars, no decorative symbols or emblems on the character's face or forehead, " +
  "no watercolor, no gouache, no pencil outlines, no paper texture";

/**
 * Builds one flattened prompt string from a StylizedImageSpec for legacy
 * generic-image callers. Character portraits use the dedicated portrait
 * builder below.
 */
export function buildStylizedImagePrompt(spec: StylizedImageSpec): string {
  const parts = [spec.subjectDescription];
  if (spec.personalityOrExpression) parts.push(`${spec.personalityOrExpression} expression, pose and demeanor reflecting this personality`);
  parts.push(CORE_STYLE);
  if (spec.backgroundType) {
    parts.push(
      `${spec.backgroundType} background${spec.backgroundColor ? `, ${spec.backgroundColor} tone` : ""}, minimal, no scenery, no patterns`
    );
  }
  parts.push(spec.cameraAngle ?? "straight-on to slight 3/4 angle camera");
  parts.push(spec.framing ?? "medium close-up");
  if (spec.kidsFriendly) parts.push("gentle, non-threatening presence, bright inviting colors, appealing and safe-looking for a 2-5 year old audience");
  if (spec.ultraCuteMode) parts.push("warm expressive eyes with a friendly glint, endearing and approachable overall look");
  parts.push(CONSISTENCY_BLOCK);
  return parts.join(", ");
}

/**
 * Builds a prompt requesting a single full-body character portrait (no poses,
 * no collage/grid). Includes the character's complete persona and personality
 * from the story so the render reflects both appearance and character traits,
 * with a warm, colorful, storybook-illustration art direction that matches
 * CORE_STYLE exactly. The portrait is distilled into the locked visual
 * description reused by Agnes scene prompts, so it must not introduce style
 * language that those prompts do not share.
 */
export function buildCharacterPortraitPrompt(params: { characterDescription: string }): string {
  return [
    `professional full-body character portrait of ${params.characterDescription}`,
    "the portrait must reflect the character's complete persona and personality from the story through pose, expression, and body language",
    "big expressive warm eyes, joyful and friendly emotion, energetic but calm body language",
    "bright cheerful saturated color palette, high color contrast for readability",
    "soft high-key lighting, clean plain white or soft pastel gradient background, no harsh shadows",
    CORE_STYLE,
    "single full-body character portrait, one character only, centered, no text labels, no annotations, no extra objects, no collage, no grid, no multiple poses",
    CONSISTENCY_BLOCK,
  ].join(", ");
}

/**
 * System prompt for the vision call that extracts an exhaustive,
 * regeneration-ready text description of a chosen character portrait.
 * Now also captures the illustration style itself (linework/shading/
 * saturation), since that description gets reused inside scene prompts and
 * should carry style-matching info along with appearance details.
 */
export function buildCharacterDetailExtractionSystemPrompt(): string {
  return (
    "You are a meticulous character-design analyst for a children's animated series. " +
    "You are shown a single full-body character portrait image (ignore any background). " +
    "Describe ONLY the character in extreme, minute detail so it can be regenerated as closely as possible " +
    "from your text alone: exact character type and gender (for humans: explicitly specify 'young girl / female child' or 'young boy / male child'), " +
    "exact hairstyle, hair length, and hair cut (e.g. 'short chin-length brown hair, cute girl bob cut' or 'long jet-black hair tied in a high ponytail'), " +
    "exact colors (name specific shades), eye shape and color, face shape, nose, " +
    "mouth/lips, hair/fur/feather style and color and texture, any clothing and its exact colors and patterns, " +
    "any accessories, body shape and proportions, and overall silhouette. Also add one short line noting the " +
    "illustration style itself (linework, shading style, color saturation) so it can be matched consistently " +
    "in generated scene videos. Do not mention the background. Reply with ONLY the descriptive text (no JSON, no preamble)."
  );
}

/** User text for the character detail-extraction vision call. */
export function buildCharacterDetailExtractionUserText(characterDescription: string): string {
  return (
    `This character's original story description/persona: ${characterDescription}\n` +
    "Analyze the attached portrait and produce the exhaustive visual description described in your instructions."
  );
}

/**
 * Maximum length of the distilled character "signature prompt". This entry is
 * repeated in every scene prompt, so it must stay compact — but it has to carry
 * enough shape/personality information for the character to stay on-model and
 * appealing, not just a list of colors.
 */
export const CHARACTER_SIGNATURE_MAX_CHARS = 250;

export type CharacterVisualForm = "real_creature" | "humanoid" | "anthropomorphic_creature" | "object_character" | "fantasy_creature";

export type SceneCharacterVisual = {
  name: string;
  visualForm: CharacterVisualForm;
  speciesOrType?: string;
  humanoidAllowed?: boolean;
};

/**
 * System prompt for the LLM call that distills an exhaustive character
 * description into a compact "signature prompt" capturing the most visually
 * significant traits needed to regenerate the character faithfully in a
 * generative visual model. This compact entry replaces the full detailed
 * description in every Agnes scene-video prompt, keeping prompts within API
 * limits while preserving silhouette, proportions and personality.
 */
export function buildCharacterSignatureDistillSystemPrompt(): string {
  return (
    "You are a character-design prompt engineer. Distill the detailed character description into a " +
    `compact Character Bible entry (MAXIMUM ${CHARACTER_SIGNATURE_MAX_CHARS} characters). ` +
    "Include these traits in strict priority order: " +
    "1. Exact Gender & Species/Type: For humans, MUST explicitly begin with 'Young girl (female child)' or 'Young boy (male child)' — NEVER write just 'Human' " +
    "2. Exact Hairstyle, Hair Cut & Hair Length (e.g. 'short chin-length chestnut-brown bob hair' or 'long jet-black hair in high ponytail with purple band' or 'short messy black hair') " +
    "3. EXACT primary body/fur/skin color — use specific shade names (e.g. 'golden-amber', 'light-beige skin') " +
    "4. Eye color and eye shape " +
    "5. Key clothing items with their exact colors " +
    "6. Key accessories with their exact colors " +
    "7. Body shape, proportions and overall silhouette " +
    "8. One short phrase for the character's default expression and demeanor (e.g. 'cheerful girl smile', 'energetic boy grin'). " +
    "Use short comma-separated phrases. Every color MUST use a specific shade name, never generic 'brown' or 'white'. " +
    "Omit: background, art-style words, story/plot details. " +
    "End with 'Always same colors.' " +
    "Reply with ONLY the compact text, no quotes, no preamble. " +
    `CRITICAL: Output MUST be ${CHARACTER_SIGNATURE_MAX_CHARS} characters or fewer.`
  );
}

/** User text for the character signature distillation LLM call. */
export function buildCharacterSignatureDistillUserText(detailedDescription: string): string {
  return (
    "Detailed character description to distill:\n" +
    detailedDescription +
    `\n\nProduce a compact visual-identity prompt (≤${CHARACTER_SIGNATURE_MAX_CHARS} characters) covering the character's ` +
    "colors, markings, body shape/proportions, clothing, accessories, and default expression. " +
    "Use SPECIFIC color shade names (not generic). Colors are the #1 cause of inconsistency between scenes, " +
    "and body shape is the #1 cause of the character looking like a different character."
  );
}

/**
 * Returns the subset of scene characters that need an explicit non-human form
 * guard. Only characters authored as `humanoid` are exempt. `humanoidAllowed`
 * is intentionally ignored: body-form behavior is derived from `visualForm`,
 * so real creatures remain natural while anthropomorphic creatures may use
 * the upright body form authored for them.
 */
export function selectCreatureIdentityCharacters(
  characterVisuals: SceneCharacterVisual[] | undefined
): Array<{ name: string; visualForm: CharacterVisualForm; speciesOrType?: string }> {
  return (characterVisuals ?? [])
    .map((item) => ({
      name: item.name.replace(/\s+/g, " ").trim(),
      visualForm: item.visualForm,
      speciesOrType: item.speciesOrType?.replace(/\s+/g, " ").trim(),
    }))
    .filter((item) => {
      if (!item.name) return false;
      // Only genuine `humanoid` characters are exempt from the creature guard.
      // Everything else (real_creature, anthropomorphic_creature, fantasy_creature,
      // object_character) must stay non-human in shape.
      return item.visualForm !== "humanoid";
    });
}

function buildCreatureIdentityGuard(characterVisuals: SceneCharacterVisual[] | undefined): string {
  const guarded = selectCreatureIdentityCharacters(characterVisuals);

  if (guarded.length === 0) return "";

  const label = (item: (typeof guarded)[number]) =>
    `${item.name}${item.speciesOrType ? ` (${item.speciesOrType})` : ""}`;
  const realCreatures = guarded.filter((item) => item.visualForm === "real_creature");
  const anthropomorphicCreatures = guarded.filter(
    (item) => item.visualForm === "anthropomorphic_creature"
  );
  const otherNonHumans = guarded.filter(
    (item) => item.visualForm !== "real_creature" && item.visualForm !== "anthropomorphic_creature"
  );

  return [
    `CREATURE IDENTITY GUIDE — ${guarded.map(label).join(", ")} must remain recognizable as their specified types and retain species-correct anatomy.`,
    realCreatures.length > 0
      ? `REAL CREATURE BODY RULE — ${realCreatures.map(label).join(", ")} must keep natural species anatomy, body plan, stance, and locomotion; never give a real creature an upright anthropomorphic or human-shaped body, human arms, or human hands.`
      : "",
    anthropomorphicCreatures.length > 0
      ? `ANTHROPOMORPHIC CREATURE BODY RULE — ${anthropomorphicCreatures.map(label).join(", ")} may stand or walk upright and use expressive human-like poses, while keeping the correct species head, features, colors, and authored body proportions.`
      : "",
    otherNonHumans.length > 0
      ? `AUTHORED NON-HUMAN FORM RULE — ${otherNonHumans.map(label).join(", ")} must keep the exact body form stated in their locked descriptions; do not humanize or animalize them.`
      : "",
    "All guarded characters must wear or carry ONLY accessories or clothing specified in their locked descriptions; do not add unrequested hats, shirts, dresses, shoes, or backpacks.",
  ].filter(Boolean).join(" ");
}

/**
 * Builds a scene prompt using the layered architecture:
 *   Layer 1 — STYLE BIBLE (locked)
 *   Layer 2 — CAMERA (preset)
 *   Layer 3 — ENVIRONMENT (locked location bible + scene-specific desc)
 *   Layer 4 — CHARACTERS (locked bible descriptions)
 *   Layer 5 — SUPPORTING ENTITIES (episode-local continuity anchors)
 *   Layer 6 — CONTINUITY ANCHORS (episode-local recurring props/setup continuity)
 *   Layer 7 — STORY ACTION (scene-specific)
 *   Layer 8 — NEGATIVE (locked)
 *
 * Character descriptions passed here should be the locked "character bible"
 * entries stored as `generationPrompt` in the database. Supporting entities
 * are optional recurring secondary figures for this episode only, repeated
 * verbatim across relevant scenes so video generation keeps them
 * visually stable without changing the main-character pipeline. Continuity
 * anchors are optional recurring visual-state constraints such as props,
 * layout, or setup details that should persist across adjacent scenes until
 * the narration clearly changes or removes them.
 */
export function buildStylizedScenePrompt(params: {
  characterNames?: string[];
  characterVisuals?: SceneCharacterVisual[];
  characterDescriptions: string[];
  environmentDescription: string;
  action: string;
  narrationText: string;
  cameraAngle: string;
  lighting: string;
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
  characterEmotions?: string[];
  characterPoses?: string[];
  characterMovements?: string[];
  objectInteractions?: string;
}): string {
  const camera = resolveCameraPreset(params.cameraAngle);

  // Layer 1 — STYLE
  const styleLayer = `${STYLE_BIBLE} ${RENDERING_BIBLE}`;

  // Layer 2 — CAMERA
  const cameraLayer = `${CAMERA_PRESETS[camera]}`;

  // Layer 3 — ENVIRONMENT (locked location description + this scene's lighting/mood)
  const lighting = params.lighting?.trim();
  const envLayer = `SETTING: ${params.environmentDescription.replace(/\s+/g, " ").trim()}` +
    (lighting ? ` LIGHTING AND MOOD: ${lighting}, consistent across the entire shot.` : "");

  const normalizedSupportingEntities = (params.supportingEntities ?? [])
    .map((entity) => entity.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Layer 4 — CHARACTERS (with strict identity anchoring and locked gender)
  const characters = params.characterDescriptions
    .map((description, index) => {
      const compactDescription = description.replace(/\s+/g, " ").trim();
      const characterName = params.characterNames?.[index]?.replace(/\s+/g, " ").trim();
      return characterName
        ? `[${characterName} appearance]: ${compactDescription}`
        : `[Character ${index + 1} appearance]: ${compactDescription}`;
    })
    .join(" | ");
  const charCount = params.characterDescriptions.length;
  const supportingCount = normalizedSupportingEntities.length;
  const totalFigureCount = charCount + supportingCount;
  const charLayer = charCount > 0
    ? `MAIN CHARACTERS — show exactly ${charCount}, each drawn once (never draw duplicate copies, clones, or multiple instances of any character, animal, or living object character; never draw both a worn version and a standing clone of a living companion; never add extra anonymous figures or helper children during teamwork actions like pulling, pushing, or lifting), using these locked descriptions ` +
      `without deviating from any color, gender, hairstyle, or feature and without adding unrequested clothing, hats, or accessories: ${characters}. ` +
      `All ${charCount} main characters must have their complete bodies visible in frame with species-correct anatomy and the natural or authored number and type of legs, arms, wings, fins, antennae, tentacles, or other appendages. Do not force a two-arm/two-leg humanoid plan onto non-humanoid species: for example, insects may have six legs, snakes may have no legs, and birds have wings plus legs. ` +
      `STRICT GENDER INTEGRITY: human girls must strictly look like young girls with their specified hairstyles and girl facial features; human boys must strictly look like young boys with their specified boy hairstyles. NEVER depict a girl character as a boy or a boy character as a girl. ` +
      `All characters interacting naturally with each other and the setting.`
    : supportingCount > 0
      ? `MAIN CHARACTERS — exactly 0 main-series character figures. Do not add any member of the main cast. This is NOT a scenery-only scene: the ${supportingCount} supporting ${supportingCount === 1 ? "entity" : "entities"} below are required.`
      : `CHARACTERS — SCENERY / ENVIRONMENT ONLY. Exactly 0 characters. No people, no children, no kids, no humans, no animals, no figures, no characters of any kind. The scene is completely empty of people and characters, showing only the pure landscape and environment.`;

  // Layer 5 — SUPPORTING ENTITIES (episode-local recurring continuity anchors)
  const supportingEntities = normalizedSupportingEntities
    .map((entity, index) => `[Supporting entity ${index + 1}]: ${entity}`)
    .join(" | ");
  const supportingLayer = supportingEntities
    ? `SUPPORTING ENTITIES — treat each of these as a required, on-model figure in this scene with the same ` +
    `strict identity lock as the main characters. Their species, colors, markings, proportions, clothing, ` +
    `and accessories must appear EXACTLY as described, never as humanoid or fairy-like hybrids unless the ` +
    `description explicitly says so, and must remain identical across every scene where they appear: ` +
    `${supportingEntities}. Draw each required supporting entity exactly once, fully visible with a complete, species-correct body.`
    : "";

  const figureCountLayer = totalFigureCount > 0
    ? `EXACT TOTAL FIGURE COUNT RULE — show exactly ${totalFigureCount} individual character ${totalFigureCount === 1 ? "figure" : "figures"} total: ` +
      `${charCount} main-character ${charCount === 1 ? "figure" : "figures"} plus ${supportingCount} supporting-entity ${supportingCount === 1 ? "figure" : "figures"}. ` +
      `Every required main or supporting individual appears exactly once. Do not add anonymous figures, helper children, background animals, clones, or a second copy of any individual, including during teamwork actions.`
    : "";

  // Layer 6 — CONTINUITY ANCHORS (episode-local recurring props/setup continuity)
  const continuityAnchors = params.continuityAnchors
    ?.map((anchor, index) => anchor.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((anchor, index) => `[Anchor ${index + 1}]: ${anchor}`)
    .join(" | ");
  const continuityLayer = continuityAnchors
    ? `SCENE CONTINUITY ANCHORS — keep these elements visually consistent with adjacent scenes: ${continuityAnchors}.`
    : "";

  const creatureIdentityLayer = buildCreatureIdentityGuard(params.characterVisuals);

  // Layer 7 — STORY ACTION (with scene context)
  const actionParts = [
    params.narrationText ? `SCENE CONTEXT: ${params.narrationText}` : "",
    `VISIBLE ACTION: ${params.action}`,
    params.sceneDetails
      ? `DETAILS: ${params.sceneDetails}`
      : "",
    !params.sceneDetails && params.characterEmotions && params.characterEmotions.length > 0
      ? `EMOTIONS: ${params.characterEmotions.join(", ")}`
      : "",
    !params.sceneDetails && params.characterPoses && params.characterPoses.length > 0
      ? `POSES: ${params.characterPoses.join(", ")}`
      : "",
    !params.sceneDetails && params.characterMovements && params.characterMovements.length > 0
      ? `MOVEMENTS: ${params.characterMovements.join(", ")}`
      : "",
    !params.sceneDetails && params.objectInteractions
      ? `PROPS/INTERACTIONS: ${params.objectInteractions}`
      : "",
  ].filter(Boolean);
  const actionLayer = actionParts.join(". ") +
    ". Animate this single visible beat as one coherent shot with gentle readable movement, stable identities, clear expressions, and natural body language; do not introduce a second action, cut, montage, or time jump.";

  // Layer 8 — NEGATIVE
  const negativeLayer = totalFigureCount === 0
    ? `${NEGATIVE_BIBLE} Avoid: any people, humans, persons, children, kids, toddlers, boys, girls, babies, animals, creatures, characters, figures, silhouettes of people.`
    : NEGATIVE_BIBLE;

  return [
    styleLayer,
    cameraLayer,
    envLayer,
    charLayer,
    supportingLayer,
    figureCountLayer,
    continuityLayer,
    creatureIdentityLayer,
    actionLayer,
    negativeLayer,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds a prompt for a series key art image: a single, polished title-card
 * illustration featuring all main characters together with the series title.
 */
export function buildSeriesKeyArtPrompt(params: {
  conceptName: string;
  conceptSummary: string;
  characters?: CharacterDef[];
  characterDescriptions?: string[];
  characterNames?: string[];
}): string {
  let characters = "";
  if (params.characters && params.characters.length > 0) {
    characters = params.characters
      .map((c) => `${c.name}: ${c.description.replace(/\s+/g, " ").trim()}`)
      .join(". ");
  } else if (params.characterDescriptions) {
    characters = params.characterDescriptions
      .map((desc, i) => {
        const name = params.characterNames?.[i]?.replace(/\s+/g, " ").trim();
        const cleanDesc = desc.replace(/\s+/g, " ").trim();
        return name ? `${name}: ${cleanDesc}` : `Character ${i + 1}: ${cleanDesc}`;
      })
      .join(". ");
  }

  return [
    "Polished professional children's show key art poster illustration.",
    "Vibrant cheerful colour palette with natural saturation. Colorful, warm, and inviting.",
    "Bright energetic color scheme that feels friendly and appealing.",
    "Title art composition suitable for a YouTube thumbnail or series cover.",
    `CRITICAL: The series title "${params.conceptName}" MUST be prominently displayed as stylized text at the top or center of the image.`,
    `Use large, colorful, playful typography that is clearly readable and child-friendly.`,
    `Concept: ${params.conceptSummary}.`,
    `CHARACTERS (all must appear): ${characters}.`,
    "CRITICAL FOR HUMAN CHARACTERS: Strictly honour and maintain the specified gender (e.g. boy, girl, man, woman, male, female), gender presentation, hair style, clothing, and features for all human characters as described in their locked character descriptions. Never switch or alter a human character's gender.",
    "CRITICAL GENDER AND IDENTITY ENFORCEMENT: For human characters, strictly honour and maintain their specified gender (e.g. boy, girl, male, female), gender presentation, feminine vs masculine facial features, and exact hair style/length as described in their locked character descriptions. Never switch or alter a human character's gender (girls must look distinctly like young girls; boys must look distinctly like young boys). Never depict a girl character as a boy or a boy character as a girl.",
    "All characters arranged together in a dynamic, engaging group pose.",
    "Characters occupy the centre-bottom of the composition, with title text above or overlaid.",
    "Rich detailed background suggesting the show's world.",
    "Vibrant saturated colors with natural tone, clean composition, professional polish.",
    "Warm friendly atmosphere, appealing to ages 2-5.",
    "16:9 landscape aspect ratio.",
    "No logos. No watermarks. No UI elements beyond the series title.",
    "No scary elements. No dark shadows. No photorealism.",
    "No 3D CGI. No anime. No comic style.",
    "Avoid: gender swap, depicting girls as boys, depicting boys as girls, wrong character gender, opposite gender appearance.",
    CHARACTER_INTEGRITY_NEGATIVE_BIBLE,
  ].join(" ");
}

/**
 * Builds a prompt for an episode key art image: a polished poster-style
 * illustration featuring the single main character of the episode with
 * the episode's premise/setting, and optional other series characters in canonical design.
 */
export function buildEpisodeKeyArtPrompt(params: {
  conceptName: string;
  episodeTitle: string;
  episodePremise: string;
  mainCharacterDescription: string;
  mainCharacterName?: string;
  otherCharacters?: Array<{ name: string; description: string }>;
  supportingEntities?: string[];
}): string {
  const charHeader = params.mainCharacterName
    ? `${params.mainCharacterName.trim()} — ${params.mainCharacterDescription.replace(/\s+/g, " ").trim()}`
    : params.mainCharacterDescription.replace(/\s+/g, " ").trim();

  const otherCharsBlock = params.otherCharacters && params.otherCharacters.length > 0
    ? `OTHER SERIES CHARACTERS (if any other characters or companions appear in the poster background, they MUST strictly follow their locked canonical descriptions and gender, never random generic lookalikes): ${params.otherCharacters.map((c) => `[${c.name}]: ${c.description.replace(/\s+/g, " ").trim()}`).join(" | ")}. `
    : "";

  const supportingBlock = params.supportingEntities && params.supportingEntities.length > 0
    ? `EPISODE CHARACTERS / ENTITIES: ${params.supportingEntities.map((e) => e.replace(/\s+/g, " ").trim()).join(" | ")}. `
    : "";

  return [
    "Polished professional children's show episode key art poster illustration.",
    "Vibrant cheerful colour palette with natural saturation. Colorful, warm, and inviting.",
    "Bright energetic color scheme that feels friendly and appealing.",
    "Title art composition suitable for a YouTube thumbnail or episode cover.",
    `CRITICAL: The episode title "${params.episodeTitle}" MUST be prominently displayed as stylized text at the top of the image.`,
    `Use large, colorful, playful typography that is clearly readable and child-friendly.`,
    `Series: "${params.conceptName}".`,
    `Episode premise: ${params.episodePremise}.`,
    `MAIN CHARACTER (must be prominently featured in foreground): ${charHeader}.`,
    otherCharsBlock,
    supportingBlock,
    "DO NOT INVENT RANDOM UNREQUESTED CHILDREN OR GENERIC CHARACTERS: Any character or figure appearing in this poster must strictly be from the specified cast with their canonical clothing, hair, gender, and props.",
    "CRITICAL FOR HUMAN CHARACTERS: Strictly honour and maintain the specified gender (e.g. boy, girl, man, woman, male, female), gender presentation, hair style, clothing, and features for human characters as described in their locked character descriptions. Never switch or alter a human character's gender.",
    "CRITICAL GENDER AND IDENTITY ENFORCEMENT: For human characters, strictly honour and maintain their specified gender (e.g. boy, girl, male, female), gender presentation, feminine vs masculine facial features, and exact hair style/length as described in their locked character description. Never switch or alter a human character's gender (girls must look distinctly like young girls; boys must look distinctly like young boys). Never depict a girl character as a boy or a boy character as a girl.",
    "Main character occupies the centre-bottom of the composition, large and clearly visible, with episode title above.",
    "Background suggests the episode's setting and story.",
    "Vibrant saturated colors with natural tone, clean composition, professional polish.",
    "Warm friendly atmosphere, appealing to ages 2-5.",
    "16:9 landscape aspect ratio.",
    "No logos. No watermarks. No UI elements beyond the episode title.",
    "No scary elements. No dark shadows. No photorealism.",
    "No 3D CGI. No anime. No comic style.",
    "Avoid: gender swap, depicting girls as boys, depicting boys as girls, wrong character gender, opposite gender appearance, random unrequested children, duplicate characters.",
    CHARACTER_INTEGRITY_NEGATIVE_BIBLE,
  ].filter(Boolean).join(" ");
}
