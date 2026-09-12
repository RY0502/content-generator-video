/**
 * Prompt architecture for consistent children's storybook media.
 *
 * Every video-scene prompt is assembled in Agnes Video 2.5's recommended
 * semantic order. Character
 * portraits are the only generated images; scene prompts feed Agnes directly.
 *   1. SUBJECT AND SETTING — locked character descriptions and environment.
 *   2. ACTION AND CHANGE — one visible story beat and physical movement.
 *   3. CAMERA — authored motion/viewpoint plus cast-compatible framing.
 *   4. VISUAL STYLE — rendering, lighting, color, material, and atmosphere.
 *   5. SOUND AND RHYTHM — visual-only pacing; provider audio is discarded.
 *   6. CONSISTENCY — identity, continuity, anatomy, and temporal negatives.
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

/** Visual style — the single most important series-level appearance anchor. */
const STYLE_BIBLE =
  "SERIES LOOK LOCK: modern 2D hand-painted children's storybook animation; matte painted surfaces, " +
  "soft brush texture, clean rounded shapes, simple facial planes, large expressive eyes, readable silhouettes, " +
  "child-friendly proportions, and vibrant naturally saturated colors. Use the same linework, two-tone painterly " +
  "shading, texture density, color grade, and character proportions in every scene. 16:9 landscape.";

/** Character/color lock belongs in Agnes's final consistency section. */
const CHARACTER_APPEARANCE_BIBLE =
  "IDENTITY LOCK: each named figure must match its appearance entry exactly from first frame to last: same exact " +
  "age, gender presentation, face, hair, eyes, body form, proportions, colors, markings, clothing, and accessories. " +
  "Do not add, remove, exchange, recolor, or redesign identity traits or wardrobe.";

/** Locked rendering — prevents Pixar / CGI drift. */
const RENDERING_BIBLE =
  "2D PAINTERLY RENDERING ONLY. Never switch to 3D, CGI, plastic volumetric rendering, photorealism, anime, " +
  "cel-shaded vector art, or another illustration medium.";

/** Video-only defects which static-image negative prompts cannot cover. */
export const TEMPORAL_STABILITY_NEGATIVE_BIBLE =
  "No flicker, jitter, strobing, melting, warping, morphing, identity/color/wardrobe drift, popping, teleporting, " +
  "disappearing figures, discontinuous props or backgrounds, jump cuts, repeated action, or unintended camera shake.";

/**
 * Shared character-integrity exclusions for every scene and key-art video.
 * Keep the short "No ..." phrases explicit: video models tend to respond more
 * reliably to these concrete defects than to a generic "bad anatomy" clause.
 * The appendage wording remains species-safe for insects, birds, snakes, etc.
 */
export const CHARACTER_INTEGRITY_NEGATIVE_BIBLE =
  "No duplicate characters, clones, duplicate living objects, or duplicate companions. " +
  "No extra limbs or duplicated appendages beyond the locked species/body form. " +
  "No double heads or extra heads, duplicated faces, fused heads, or conjoined bodies.";

/** Negative prompt — critical constraints, stated once, at the end. */
const NEGATIVE_BIBLE =
  "NEGATIVE: no text, captions, logos, watermarks, panels, split-screen, collage, mirrors, character-shaped " +
  "reflections, portraits, statues, screens, silhouettes, crowds, bystanders, unlisted figures, gender or age changes, " +
  "wrong anatomy, fused bodies, missing body parts, unlisted wardrobe/accessories/markings, chimera traits, or cropped " +
  `identity-defining features. ${CHARACTER_INTEGRITY_NEGATIVE_BIBLE}`;

// ---------------------------------------------------------------------------
// Camera presets — only 3 allowed, no freeform strings
// ---------------------------------------------------------------------------

/** Fixed camera presets that prevent jarring visual jumps between scenes. */
export type CameraPreset = "establishing" | "medium" | "close";

const CAMERA_PRESETS: Record<CameraPreset, string> = {
  establishing:
    "wide 16:9 establishing composition with the environment readable and every declared figure spatially separated",
  medium:
    "medium-wide 16:9 group composition with every declared figure spatially separated and the environment readable",
  close:
    "medium-close 16:9 single-figure composition with the face, silhouette, and setting context readable",
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

export type SceneLightingProfile = "daylight" | "dusk" | "night" | "interior" | "underwater";

const LIGHTING_PROFILES: Record<SceneLightingProfile, string> = {
  daylight: "soft warm diffused daylight, gentle neutral shadows, bright friendly exposure",
  dusk: "soft warm amber dusk light, gentle muted-violet shadows, bright friendly exposure",
  night: "soft cool blue moonlight with a gentle warm fill, readable faces, no harsh darkness",
  interior: "soft warm practical key light with neutral fill, readable faces, gentle shadows",
  underwater: "soft aqua filtered light with gentle blue-green shadows, readable faces, bright exposure",
};

/**
 * Reduces free-form lighting prose to a small episode-wide palette. Equivalent
 * wording therefore produces identical grading instead of making adjacent
 * shots drift between unrelated cinematic looks.
 */
export function resolveSceneLightingProfile(
  rawLighting: string,
  environmentDescription = "",
): SceneLightingProfile {
  const text = `${rawLighting} ${environmentDescription}`.toLocaleLowerCase();
  if (/\b(?:underwater|submerged|ocean floor|sea floor)\b/u.test(text)) return "underwater";
  if (/\b(?:indoor|interior|inside|lamp|lantern|candle|torch|firelight|cave|tomb|temple chamber)\b/u.test(text)) {
    return "interior";
  }
  if (/\b(?:night|midnight|moonlight|moonlit|starlight|starlit)\b/u.test(text)) return "night";
  if (/\b(?:dusk|sunset|twilight|late[- ]afternoon|golden[- ]hour|evening)\b/u.test(text)) return "dusk";
  return "daylight";
}

type CameraMovement = "fixed camera" | "slow straight push-in" | "slow straight pull-back" | "slow pan left" |
  "slow pan right" | "slow tilt up" | "slow tilt down" | "slow track left" | "slow track right";

function resolveCameraMovement(raw: string): CameraMovement {
  const text = raw.toLocaleLowerCase();
  // An explicit static/fixed request wins over any incidental motion word.
  if (/\b(?:fixed|static|locked[- ]?off|tripod)\b/u.test(text)) return "fixed camera";
  if (/\b(?:pull(?:s|ing)? back|pull[- ]?out|dolly out|zoom out)\b/u.test(text)) return "slow straight pull-back";
  if (/\b(?:push(?:es|ing)? in|push[- ]?in|dolly in|zoom in)\b/u.test(text)) return "slow straight push-in";
  if (/\bpan(?:s|ning)?\s+(?:to\s+the\s+)?left\b/u.test(text)) return "slow pan left";
  if (/\bpan(?:s|ning)?\s+(?:to\s+the\s+)?right\b/u.test(text)) return "slow pan right";
  if (/\btilt(?:s|ing)?\s+(?:up|upward)\b/u.test(text)) return "slow tilt up";
  if (/\btilt(?:s|ing)?\s+(?:down|downward)\b/u.test(text)) return "slow tilt down";
  if (/\b(?:track|tracking|dolly)(?:s|ing)?\b[^.!;]{0,40}\b(?:left|leftward)\b/u.test(text)) return "slow track left";
  if (/\b(?:track|tracking|dolly)(?:s|ing)?\b[^.!;]{0,40}\b(?:right|rightward)\b/u.test(text)) return "slow track right";
  return "fixed camera";
}

function resolveCameraViewpoint(raw: string): string {
  const text = raw.toLocaleLowerCase();
  if (/\b(?:bird'?s[- ]?eye|overhead|top[- ]?down)\b/u.test(text)) return "gentle overhead viewpoint";
  if (/\b(?:low[- ]?angle|ground[- ]?level|creek[- ]?level)\b/u.test(text)) return "gentle low-angle viewpoint";
  if (/\b(?:high[- ]?angle|slightly above)\b/u.test(text)) return "slightly elevated viewpoint";
  if (/\b(?:side|profile)\b/u.test(text)) return "clean side viewpoint";
  return "natural eye-level viewpoint";
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
    "1. Exact Age, Gender & Species/Type: preserve any numeric or written age phrase exactly; for humans, MUST explicitly begin with 'Young girl (female child)' or 'Young boy (male child)' — NEVER write just 'Human' " +
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
    `BODY-FORM LOCK — ${guarded.map(label).join(", ")} ${guarded.length === 1 ? "retains its" : "retain their"} specified non-human ${guarded.length === 1 ? "type" : "types"} and species-correct anatomy.`,
    realCreatures.length > 0
      ? `${realCreatures.map(label).join(", ")} use natural species body plans, stance, and locomotion, never humanoid arms or hands.`
      : "",
    anthropomorphicCreatures.length > 0
      ? `${anthropomorphicCreatures.map(label).join(", ")} may pose upright but retain the exact species head, features, colors, and authored proportions.`
      : "",
    otherNonHumans.length > 0
      ? `${otherNonHumans.map(label).join(", ")} keep the exact authored non-human form; do not humanize or animalize them.`
      : "",
  ].filter(Boolean).join(" ");
}

function supportingEntityName(descriptor: string, index: number): string {
  const prefix = descriptor.split(":", 1)[0]?.replace(/\s+/g, " ").trim();
  return prefix || `Supporting entity ${index + 1}`;
}

function buildExactCastLedger(
  characterNames: string[] | undefined,
  characterCount: number,
  supportingEntities: readonly string[],
): string {
  const mainNames = Array.from({ length: characterCount }, (_, index) => (
    characterNames?.[index]?.replace(/\s+/g, " ").trim() || `Character ${index + 1}`
  ));
  const supportingNames = supportingEntities.map(supportingEntityName);
  const names = [...mainNames, ...supportingNames];
  if (names.length === 0) return "";

  return (
    `VISIBLE CAST — EXACTLY ${names.length} ${names.length === 1 ? "FIGURE" : "FIGURES"}, NO OTHERS: ` +
    `${names.map((name) => `[${name}] × 1`).join("; ")}. This ledger is authoritative for the complete shot.`
  );
}

function buildObjectCharacterInstanceLock(
  characterVisuals: SceneCharacterVisual[] | undefined,
): string {
  const objects = (characterVisuals ?? []).filter((item) => item.visualForm === "object_character");
  if (objects.length === 0) return "";

  return (
    "OBJECT-CHARACTER LOCK — " +
    objects.map((item) => {
      const name = item.name.replace(/\s+/g, " ").trim();
      const type = item.speciesOrType?.replace(/\s+/g, " ").trim() || "object";
      return `[${name}] is the one physical ${type}; its name, type, body, and parts always mean this same instance`;
    }).join(" | ") +
    ". It occupies one place and one state: carried/worn OR freestanding, never both, and no ordinary duplicate of its object type."
  );
}

/**
 * Converts authored camera prose into one safe shot size, viewpoint, and move.
 * We deliberately do not echo the raw text: old scripts can contain
 * split-screen, over-the-shoulder, or several competing camera moves, all of
 * which make a text-to-video model invent foreground copies.
 */
function buildSceneCameraLayer(rawCameraAngle: string, totalFigureCount: number): string {
  const authoredIntent = rawCameraAngle.replace(/\s+/g, " ").trim() || "wide establishing shot";
  const requestedPreset = resolveCameraPreset(authoredIntent);
  const effectivePreset = totalFigureCount >= 4
    ? "establishing"
    : totalFigureCount >= 2 && requestedPreset === "close"
      ? "medium"
      : requestedPreset;
  const castFraming = totalFigureCount > 0
    ? `Keep all ${totalFigureCount} ledger figures readable and spatially distinct without reflections, repeated foreground faces, or over-the-shoulder body doubles.`
    : "Keep the environment empty of figures.";

  return `CAMERA — ${CAMERA_PRESETS[effectivePreset]}; ${resolveCameraViewpoint(authoredIntent)}; ` +
    `${resolveCameraMovement(authoredIntent)}. One unbroken shot. ${castFraming}`;
}

/**
 * Builds a scene prompt using Agnes's documented semantic order: subject and
 * setting, action and change, camera, visual style, sound and rhythm, then
 * consistency requirements. Invariant bibles remain byte-stable across
 * scenes even though they are placed in the semantic section where Agnes is
 * expected to use them.
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
  const environment = params.environmentDescription.replace(/\s+/g, " ").trim();
  const envLayer = `SETTING — ${environment}`;

  const normalizedSupportingEntities = (params.supportingEntities ?? [])
    .map((entity) => entity.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (params.characterDescriptions.length !== (params.characterNames?.length ?? params.characterDescriptions.length)) {
    throw new Error("Scene characterNames and characterDescriptions must align 1:1.");
  }
  const normalizedCharacterNames = params.characterDescriptions.map((_, index) => (
    params.characterNames?.[index]?.replace(/\s+/g, " ").trim() || `Character ${index + 1}`
  ));
  if (new Set(normalizedCharacterNames.map((name) => name.toLocaleLowerCase())).size !== normalizedCharacterNames.length) {
    throw new Error("Scene visible cast must contain each main character exactly once.");
  }
  const supportingNames = normalizedSupportingEntities.map(supportingEntityName);
  const allCastNames = [...normalizedCharacterNames, ...supportingNames];
  if (new Set(allCastNames.map((name) => name.toLocaleLowerCase())).size !== allCastNames.length) {
    throw new Error("Scene visible cast must contain each main or supporting figure exactly once.");
  }

  // SUBJECT — preserve each locked identity entry verbatim apart from whitespace.
  // These entries may contain exact age and portrait-derived traits and must not
  // be summarized again at the provider boundary.
  const characters = params.characterDescriptions
    .map((description, index) => {
      const compactDescription = description.replace(/\s+/g, " ").trim();
      return `[${normalizedCharacterNames[index]}]: ${compactDescription}`;
    })
    .join(" | ");
  const charCount = params.characterDescriptions.length;
  const supportingCount = normalizedSupportingEntities.length;
  const totalFigureCount = charCount + supportingCount;
  const castLedger = buildExactCastLedger(
    params.characterNames,
    charCount,
    normalizedSupportingEntities,
  );
  const charLayer = charCount > 0
    ? `IDENTITY REFERENCES — ${characters}`
    : supportingCount > 0
      ? "MAIN-CAST EXCLUSION — no main-series character is visible; only the supporting figures in the ledger appear."
      : "EMPTY-SCENE LOCK — exactly zero people, animals, creatures, living objects, silhouettes, or other figures.";

  // SUBJECT — episode-local supporting entities.
  const supportingEntities = normalizedSupportingEntities
    .map((entity, index) => `[${supportingEntityName(entity, index)}]: ${entity.includes(":") ? entity.slice(entity.indexOf(":") + 1).trim() : entity}`)
    .join(" | ");
  const supportingLayer = supportingEntities
    ? `SUPPORTING IDENTITY REFERENCES — ${supportingEntities}`
    : "";

  const figureCountLayer = totalFigureCount > 0
    ? `COUNT AND TRAJECTORY LOCK — keep those same ${totalFigureCount} ledger ${totalFigureCount === 1 ? "identity" : "identities"} ` +
      "from first frame to last, each on one continuous trajectory with species-correct anatomy. No identity splits, forks, " +
      "re-enters, appears in two depth planes, or gains a second copy after movement, occlusion, or portal crossing."
    : "";

  // CONSISTENCY — episode-local recurring props/setup continuity.
  const continuityAnchors = params.continuityAnchors
    ?.map((anchor, index) => anchor.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((anchor, index) => `[Anchor ${index + 1}]: ${anchor}`)
    .join(" | ");
  const continuityLayer = continuityAnchors
    ? `INANIMATE CONTINUITY — ${continuityAnchors}. These anchors never authorize another figure.`
    : "";

  const creatureIdentityLayer = buildCreatureIdentityGuard(params.characterVisuals);
  const objectCharacterInstanceLayer = buildObjectCharacterInstanceLock(params.characterVisuals);

  // ACTION is the only dynamic instruction. DETAILS supplies blocking and the
  // desired end-state, so legacy prose cannot accidentally introduce a second
  // camera move, cut, or sequential story beat.
  const blockingParts = [
    params.sceneDetails
      ? params.sceneDetails
      : "",
    !params.sceneDetails && params.characterEmotions && params.characterEmotions.length > 0
      ? `Emotions: ${params.characterEmotions.join(", ")}`
      : "",
    !params.sceneDetails && params.characterPoses && params.characterPoses.length > 0
      ? `Poses: ${params.characterPoses.join(", ")}`
      : "",
    !params.sceneDetails && params.characterMovements && params.characterMovements.length > 0
      ? `Movement reference: ${params.characterMovements.join(", ")}`
      : "",
    !params.sceneDetails && params.objectInteractions
      ? `Props/interactions: ${params.objectInteractions}`
      : "",
  ].filter(Boolean);
  const action = params.action.replace(/\s+/g, " ").trim();
  const actionLayer = `ACTION AND CHANGE — ONE CONTINUOUS BEAT: ${action}. ` +
    (blockingParts.length > 0 ? `STATIC BLOCKING AND END-STATE REFERENCE: ${blockingParts.join(". ")}. ` : "") +
    "Animate only the movement explicitly stated in the continuous beat. Every other ledger figure keeps its assigned " +
    "position with a subtle natural reaction. No extra entrance, exit, replay, cut, montage, or time jump.";

  // CONSISTENCY — static and temporal exclusions, stated once at the end.
  const negativeLayer = totalFigureCount === 0
    ? `${NEGATIVE_BIBLE} No people, children, animals, creatures, living objects, or figures.`
    : NEGATIVE_BIBLE;

  const subjectAndSettingLayer = [
    "SUBJECT AND SETTING —",
    castLedger,
    charLayer,
    supportingLayer,
    envLayer,
  ].filter(Boolean).join("\n");
  const cameraLayer = buildSceneCameraLayer(params.cameraAngle, totalFigureCount);
  const lightingProfile = resolveSceneLightingProfile(params.lighting, environment);
  const visualStyleLayer = [
    "VISUAL STYLE —",
    STYLE_BIBLE,
    `LIGHTING PROFILE (${lightingProfile.toUpperCase()}) — ${LIGHTING_PROFILES[lightingProfile]}. Keep this profile, exposure, and color grade unchanged for the full shot.`,
    RENDERING_BIBLE,
  ].filter(Boolean).join(" ");
  const soundAndRhythmLayer =
    "SOUND AND RHYTHM — silent visual-only shot; gentle readable pacing; no speech, music, or sound effects.";
  const consistencyLayer = [
    "CONSISTENCY REQUIREMENTS —",
    totalFigureCount > 0 ? CHARACTER_APPEARANCE_BIBLE : "",
    figureCountLayer,
    continuityLayer,
    creatureIdentityLayer,
    objectCharacterInstanceLayer,
    TEMPORAL_STABILITY_NEGATIVE_BIBLE,
    negativeLayer,
  ].filter(Boolean).join(" ");

  // Agnes Video 2.5's documented order: subject/setting, action/change,
  // camera, visual style, sound/rhythm, then consistency requirements.
  return [
    subjectAndSettingLayer,
    actionLayer,
    cameraLayer,
    visualStyleLayer,
    soundAndRhythmLayer,
    consistencyLayer,
  ]
    .filter(Boolean)
    .join("\n");
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

// ---------------------------------------------------------------------------
// Direct Agnes video title cards
// ---------------------------------------------------------------------------

const TITLE_CARD_NEGATIVE_BIBLE =
  "No text except the one required title; no subtitles, extra lettering, misspelled/changing letters, logos, watermarks, " +
  "UI, panels, split-screen, collage, mirrors, reflections, portraits, statues, silhouettes, background figures, gender/age " +
  "changes, malformed anatomy, unlisted wardrobe, or unlisted accessories. " +
  CHARACTER_INTEGRITY_NEGATIVE_BIBLE;

function lockedSeriesCharacterText(params: {
  characters?: CharacterDef[];
  characterDescriptions?: string[];
  characterNames?: string[];
}): { name: string; appearance: string } {
  if (params.characters && params.characters.length > 0) {
    const character = params.characters[0]!;
    return {
      name: character.name.replace(/\s+/g, " ").trim(),
      appearance: character.description.replace(/\s+/g, " ").trim(),
    };
  }
  const descriptions = params.characterDescriptions ?? [];
  const description = descriptions[0];
  if (!description) return { name: "Main character", appearance: "one friendly preschool protagonist" };
  const name = params.characterNames?.[0]?.replace(/\s+/g, " ").trim();
  return {
    name: name || "Main character",
    appearance: description.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Canonical direct-video series title card in Agnes Video 2.5's recommended
 * semantic order. This deliberately does not reuse the legacy still-key-art
 * builder: words such as poster, thumbnail, cover, and image bias the model
 * toward a static composition.
 */
export function buildSeriesKeyArtVideoPrompt(params: {
  conceptName: string;
  conceptSummary: string;
  environmentDescription?: string;
  characters?: CharacterDef[];
  characterDescriptions?: string[];
  characterNames?: string[];
}): string {
  const title = params.conceptName.replace(/\s+/g, " ").trim();
  const environment = params.environmentDescription?.replace(/\s+/g, " ").trim()
    || "A warm, uncluttered storybook setting with cheerful colors and generous open space";
  const characters = lockedSeriesCharacterText(params);
  return [
    `SUBJECT AND SETTING — A full-bleed animated children's series title card in this figure-free location: ${environment}.`,
    `Render the exact title ${JSON.stringify(title)} once in large, playful, clearly readable lettering at the upper center.`,
    `EXACT ON-SCREEN CAST LEDGER — 1 TOTAL CHARACTER FIGURE, AND NO OTHERS: [${characters.name}] × 1.`,
    `REQUIRED FOREGROUND PROTAGONIST — show that one ${characters.name}, fully visible and prominent: [${characters.name} appearance]: ${characters.appearance}.`,
    "The title words are typography only and never authorize another person, creature, living object, or depiction.",
    "ACTION AND CHANGE — ONE CONTINUOUS BEAT: gentle breathing, one blink, and one small friendly gesture by the protagonist; subtle environmental motion only. Keep title and layout unchanged; no entrance, exit, plot beat, replay, cut, montage, or time jump.",
    "CAMERA — medium-wide eye-level 16:9 shot; protagonist centered in the lower half; environment readable; open title space above; one slow straight push-in; no other camera move.",
    `VISUAL STYLE — ${STYLE_BIBLE} LIGHTING PROFILE (DAYLIGHT) — ${LIGHTING_PROFILES.daylight}. ${RENDERING_BIBLE}`,
    "SOUND AND RHYTHM — silent visual-only title card; calm motion; no speech, music, or sound effects.",
    `CONSISTENCY REQUIREMENTS — Preserve the exact title spelling, placement, letter shapes, and readability; add no other text. ${CHARACTER_APPEARANCE_BIBLE} Keep the one protagonist on one continuous trajectory; never duplicate it in another depth plane. ${TEMPORAL_STABILITY_NEGATIVE_BIBLE} ${TITLE_CARD_NEGATIVE_BIBLE}`,
  ].join(" ");
}

/** Canonical direct-video episode title card in Agnes's recommended order. */
export function buildEpisodeKeyArtVideoPrompt(params: {
  conceptName: string;
  episodeTitle: string;
  episodePremise: string;
  environmentDescription?: string;
  mainCharacterDescription: string;
  mainCharacterName?: string;
  otherCharacters?: Array<{ name: string; description: string }>;
  supportingEntities?: string[];
}): string {
  const seriesTitle = params.conceptName.replace(/\s+/g, " ").trim();
  const episodeTitle = params.episodeTitle.replace(/\s+/g, " ").trim();
  const environment = params.environmentDescription?.replace(/\s+/g, " ").trim()
    || "A warm, uncluttered storybook setting with cheerful colors and generous open space";
  const protagonistName = params.mainCharacterName?.replace(/\s+/g, " ").trim() || "Main character";
  const protagonist = `[${protagonistName} appearance]: ${params.mainCharacterDescription.replace(/\s+/g, " ").trim()}`;
  return [
    `SUBJECT AND SETTING — A full-bleed animated children's episode title card in this figure-free location: ${environment}.`,
    `Render the exact episode title ${JSON.stringify(episodeTitle)} once in large, playful, clearly readable lettering at the upper center.`,
    `SERIES CONTEXT: ${JSON.stringify(seriesTitle)}.`,
    `EXACT ON-SCREEN CAST LEDGER — 1 TOTAL CHARACTER FIGURE, AND NO OTHERS: [${protagonistName}] × 1.`,
    `REQUIRED FOREGROUND PROTAGONIST — show that one ${protagonistName}, fully visible and prominent: ${protagonist}.`,
    "The series and episode title words are typography only and never authorize another person, creature, living object, or depiction.",
    "ACTION AND CHANGE — ONE CONTINUOUS BEAT: hold one readable premise-related pose with gentle breathing, one blink, and one small friendly gesture; subtle environmental motion only. Keep title and layout unchanged; no extra plot beat, replay, cut, montage, or time jump.",
    "CAMERA — medium-wide eye-level 16:9 title-card shot; protagonist centered in the lower half; setting readable; open title space above; one slow straight push-in; no other camera move.",
    `VISUAL STYLE — ${STYLE_BIBLE} LIGHTING PROFILE (DAYLIGHT) — ${LIGHTING_PROFILES.daylight}. ${RENDERING_BIBLE}`,
    "SOUND AND RHYTHM — silent visual-only title card; calm motion; no speech, music, or sound effects.",
    `CONSISTENCY REQUIREMENTS — Preserve the exact episode-title spelling, placement, letter shapes, and readability; add no other text. ${CHARACTER_APPEARANCE_BIBLE} Keep the one protagonist on one continuous trajectory; never duplicate it in another depth plane. ${TEMPORAL_STABILITY_NEGATIVE_BIBLE} ${TITLE_CARD_NEGATIVE_BIBLE}`,
  ].filter(Boolean).join(" ");
}
