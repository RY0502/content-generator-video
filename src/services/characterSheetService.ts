import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { chatText, chatVisionFrameworkOnly } from "../providers/aiClient.js";
import { generateAnyApiSceneImage } from "../providers/anyApiImageClient.js";
import { SeriesState, ReferenceImage, type CharacterDef } from "../state/seriesState.js";
import { CONFIG } from "../config.js";
import {
  buildCharacterPortraitPrompt,
  buildCharacterDetailExtractionSystemPrompt,
  buildCharacterDetailExtractionUserText,
  buildCharacterSignatureDistillSystemPrompt,
  buildCharacterSignatureDistillUserText,
  type SceneCharacterVisual,
  CHARACTER_SIGNATURE_MAX_CHARS,
} from "../promptBuilder.js";
import { logStep } from "../utils/logger.js";
import type { CustomStateStore } from "freetier-deepagent-framework";

/** Portrait generation model — Google Gemini for high-quality character art. */
export const PORTRAIT_MODEL = "google/gemini-3.1-flash-image";
export const CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION = 1 as const;
export const CHARACTER_SIGNATURE_REQUIRED_ENDING = "Always same colors.";

const CHARACTER_SIGNATURE_COLOR_PATTERN =
  /\b(?:amber|aqua|auburn|azure|beige|black|blue|bronze|brown|burgundy|caramel|cerulean|charcoal|chestnut|chocolate|cobalt|copper|coral|cream|crimson|cyan|emerald|gold|golden|gray|grey|green|hazel|indigo|ivory|lavender|lilac|magenta|mahogany|maroon|mint|mustard|navy|ochre|olive|orange|peach|pearl|pink|plum|purple|red|rose|rust|saffron|sand|scarlet|sienna|silver|slate|tan|teal|turquoise|violet|white|yellow)\b/iu;

/** Durable checkpoint for one character's portrait pipeline. */
export interface PortraitCheckpoint {
  portraitPath: string;
  model: string;
  requestDigest: string;
  /** Full exhaustive description from vision model (kept for reference). */
  detailedDescription?: string;
  /** Compact signature prompt distilled from detailedDescription. */
  generationPrompt?: string;
}

export interface EnsureCharacterSheetResult {
  status: "already_approved" | "generated";
  referenceImagePaths: Record<string, ReferenceImage>;
  generationPrompt: string;
}

export interface EnsuredSeriesCharacterSheet {
  name: string;
  status: EnsureCharacterSheetResult["status"];
  referenceImagePaths: Record<string, ReferenceImage>;
  generationPrompt: string;
}

export interface EnsureSeriesCharacterSheetsResult {
  seriesId: number;
  rosterCount: number;
  generatedCount: number;
  reusedCount: number;
  characters: EnsuredSeriesCharacterSheet[];
}

export interface CharacterSignatureInspection {
  normalized: string;
  pass: boolean;
  issues: string[];
}

/** Stable identity for a portrait request; paths and checkpoints use this digest. */
export function createCharacterPortraitRequestDigest(params: {
  characterDescription: string;
  model?: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION,
    characterDescription: params.characterDescription.trim(),
    model: params.model ?? PORTRAIT_MODEL,
  })).digest("hex");
}

function safeCharacterPathSegment(characterName: string): string {
  const normalized = characterName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+|\.+$/gu, "")
    .replace(/^_+|_+$/gu, "");
  return normalized || "unnamed_character";
}

export function characterPortraitStorage(params: {
  assetsDir: string;
  seriesId: number;
  characterName: string;
  requestDigest: string;
}): { destDir: string; portraitPath: string; checkpointKey: string } {
  const destDir = path.join(
    params.assetsDir,
    `series_${params.seriesId}`,
    "characters",
    safeCharacterPathSegment(params.characterName),
    params.requestDigest,
  );
  return {
    destDir,
    portraitPath: path.join(destDir, "portrait.png"),
    checkpointKey:
      `series:${params.seriesId}:character:${params.characterName}:portrait:${params.requestDigest}`,
  };
}

function normalizeCharacterSignatureResponse(raw: string): string {
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:text)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) candidate = fenced[1].trim();
  candidate = candidate
    .replace(/^.*?(?:We need to produce|Produce a compact|Here's the compact|The compact prompt is)[:\s]*/iu, "")
    .replace(/^(["'])|(["'])$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return candidate;
}

/** Deterministic gate for the compact identity reused in every Agnes prompt. */
export function inspectCharacterSignaturePrompt(raw: string): CharacterSignatureInspection {
  const normalized = normalizeCharacterSignatureResponse(raw);
  const issues: string[] = [];
  if (!normalized) issues.push("Signature prompt is empty.");
  if (normalized.length > CHARACTER_SIGNATURE_MAX_CHARS) {
    issues.push(
      `Signature prompt is ${normalized.length} characters; maximum is ${CHARACTER_SIGNATURE_MAX_CHARS}.`,
    );
  }
  if (!normalized.endsWith(CHARACTER_SIGNATURE_REQUIRED_ENDING)) {
    issues.push(`Signature prompt must end with '${CHARACTER_SIGNATURE_REQUIRED_ENDING}'.`);
  }

  const identityText = normalized.endsWith(CHARACTER_SIGNATURE_REQUIRED_ENDING)
    ? normalized.slice(0, -CHARACTER_SIGNATURE_REQUIRED_ENDING.length).replace(/[\s,.;:-]+$/gu, "")
    : normalized;
  const identityWordCount = identityText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  if (identityWordCount < 3) {
    issues.push("Signature prompt must retain a substantive character identity description.");
  }
  if (identityText && !CHARACTER_SIGNATURE_COLOR_PATTERN.test(identityText)) {
    issues.push("Signature prompt must retain at least one explicit character color.");
  }

  return { normalized, pass: issues.length === 0, issues };
}

/**
 * Trims text to a maximum length without cutting a word in half, so a
 * truncated character bible never ends mid-word (e.g. "cream-wh").
 */
export function trimToWordBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const nextCharacter = text.charAt(maxChars);
  if (!nextCharacter || /[\s,.;:!?]/u.test(nextCharacter)) return clipped.trim();

  const separatorMatches = [...clipped.matchAll(/[\s,.;:!?]/gu)];
  const lastSeparator = separatorMatches.at(-1)?.index ?? -1;
  return lastSeparator >= 0 ? clipped.slice(0, lastSeparator).trim() : "";
}

function hasOnlySignatureLengthOverflow(inspection: CharacterSignatureInspection): boolean {
  return inspection.normalized.length > CHARACTER_SIGNATURE_MAX_CHARS && inspection.issues.length === 1;
}

/**
 * Removes only optional spaces after list punctuation. This preserves every
 * identity word and the required color-lock suffix while recovering the common
 * case where a model misses the hard limit by a handful of characters.
 */
function compactSignaturePunctuationSpacing(signature: string): string {
  let remainingOverflow = signature.length - CHARACTER_SIGNATURE_MAX_CHARS;
  if (remainingOverflow <= 0) return signature;

  const optionalSpaces = [...signature.matchAll(/[,;:] (?=\S)/gu)];
  let compacted = signature;
  // Work backwards so the match indexes remain valid after each deletion.
  for (let index = optionalSpaces.length - 1; index >= 0 && remainingOverflow > 0; index--) {
    const punctuationIndex = optionalSpaces[index].index;
    if (punctuationIndex === undefined) continue;
    const spaceIndex = punctuationIndex + 1;
    compacted = compacted.slice(0, spaceIndex) + compacted.slice(spaceIndex + 1);
    remainingOverflow--;
  }
  return compacted;
}

/**
 * Recovers a semantically valid signature whose sole defect is its length.
 * Word removal remains a final-attempt fallback; earlier attempts retain the
 * existing opportunity for the model to author a naturally shorter version.
 */
function recoverSignatureLengthOverflow(
  inspection: CharacterSignatureInspection,
  allowWordBoundaryTrim: boolean,
): CharacterSignatureInspection | null {
  if (!hasOnlySignatureLengthOverflow(inspection)) return null;

  const compactedInspection = inspectCharacterSignaturePrompt(
    compactSignaturePunctuationSpacing(inspection.normalized),
  );
  if (compactedInspection.pass) return compactedInspection;
  if (!allowWordBoundaryTrim || !hasOnlySignatureLengthOverflow(compactedInspection)) return null;

  const suffix = CHARACTER_SIGNATURE_REQUIRED_ENDING;
  const identity = compactedInspection.normalized
    .slice(0, -suffix.length)
    .replace(/[\s,.;:-]+$/gu, "")
    .trim();
  const identityBudget = CHARACTER_SIGNATURE_MAX_CHARS - suffix.length - 2; // `. ${suffix}`
  const trimmedIdentity = trimToWordBoundary(identity, identityBudget)
    .replace(/[\s,.;:-]+$/gu, "")
    .trim();
  if (!trimmedIdentity) return null;

  const trimmedInspection = inspectCharacterSignaturePrompt(`${trimmedIdentity}. ${suffix}`);
  return trimmedInspection.pass ? trimmedInspection : null;
}

/** Normalizes a character name for tolerant matching against the roster. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildOntologyAwareCharacterDescription(params: {
  characterName: string;
  characterDescription: string;
  characterVisual?: SceneCharacterVisual;
}): string {
  const baseDescription = params.characterDescription.trim();
  const visual = params.characterVisual;
  if (!visual) return baseDescription;

  const speciesOrType = visual.speciesOrType?.trim();
  if (visual.visualForm === "real_creature" && visual.humanoidAllowed !== true) {
    return `${baseDescription}. Visual ontology: ${params.characterName} must be a real non-human ${speciesOrType ?? "creature"} with true ${speciesOrType ?? "animal"} anatomy and proportions, not a humanoid, fairy-like, mascot-like, doll-like, or human-child hybrid. No human face, human hands, upright child body, or clothing unless explicitly required by the story.`;
  }

  if (visual.visualForm === "humanoid") {
    return `${baseDescription}. Visual ontology: ${params.characterName} is intentionally humanoid.`;
  }

  if (visual.visualForm === "anthropomorphic_creature") {
    return `${baseDescription}. Visual ontology: ${params.characterName} is an anthropomorphic ${speciesOrType ?? "creature"}, so preserve creature identity while allowing intentional stylized character traits.`;
  }

  if (visual.visualForm === "object_character") {
    return `${baseDescription}. Visual ontology: ${params.characterName} is an object-based character, not a human.`;
  }

  if (visual.visualForm === "fantasy_creature") {
    return `${baseDescription}. Visual ontology: ${params.characterName} is a fantasy creature with a non-human body plan unless the story explicitly says otherwise.`;
  }

  return baseDescription;
}

function stripGeneratedOntologyGuard(text: string): string {
  return text
    // `buildOntologyAwareCharacterDescription` appends this generated guard.
    // It contains words such as "non-human", "not a humanoid", and "no human
    // face" which are prohibitions, not evidence that the portrait is human.
    .replace(/(?:^|\.)\s*Visual ontology:[\s\S]*$/iu, " ")
    .replace(/\bno\s+human\s+face,\s*human\s+hands,\s*upright\s+child\s+body,\s*or\s+clothing\s+unless[^.;]*[.;]?/giu, " ")
    .replace(/\bnon[-\s]?human\b/giu, " ")
    .replace(/\bnot\s+(?:an?\s+)?humanoid\b/giu, " ")
    .replace(/\bno\s+human\s+(?:face|hands?|body|features?|anatomy)\b/giu, " ")
    .replace(/\bwithout\s+(?:an?\s+)?human(?:oid)?\s+(?:face|body|form|features?|anatomy)\b/giu, " ");
}

export function conflictsWithCharacterVisual(params: {
  characterVisual?: SceneCharacterVisual;
  description?: string | null;
  generationPrompt?: string | null;
}): boolean {
  const visual = params.characterVisual;
  if (!visual) return false;

  const haystack = `${stripGeneratedOntologyGuard(params.description ?? "")} ` +
    stripGeneratedOntologyGuard(params.generationPrompt ?? "");
  const normalizedHaystack = haystack.toLowerCase();
  if (!normalizedHaystack.trim()) return false;

  if (visual.visualForm === "real_creature" && visual.humanoidAllowed !== true) {
    return [
      /\b(?:girl|boy|princess|fairy)\b/u,
      /\b(?:human|humanoid)(?:-child)?\b/u,
      /\b(?:bob|ponytail|pigtails?|braids?)\s+(?:cut|hair|hairstyle)\b/u,
      /\b(?:dress|tunic|leggings|flats|shirt|pants|shoes)\b/u,
      /\bupright\s+(?:child|human|person)(?:-like)?\s+(?:body|form|figure)\b/u,
    ].some((pattern) => pattern.test(normalizedHaystack));
  }

  return false;
}

/**
 * Resolves a character's canonical story description from the series roster.
 * Matching is deliberately tolerant (exact -> case-insensitive -> normalized ->
 * first-name) because the agent occasionally refers to "Sunny" when the roster
 * entry is "Sunny the Sparrow". Returns null when the character isn't in the
 * roster at all.
 */
export async function resolveCharacterDescription(
  seriesState: SeriesState,
  seriesId: number,
  characterName: string
): Promise<string | null> {
  const roster = await seriesState.getSeriesCharacters(seriesId);
  if (roster.length === 0) return null;

  const target = normalizeName(characterName);
  const exact = roster.find((entry) => entry.name === characterName);
  if (exact) return exact.description;

  const normalized = roster.find((entry) => normalizeName(entry.name) === target);
  if (normalized) return normalized.description;

  // "Sunny" should still match the roster entry "Sunny the Sparrow".
  const firstToken = target.split(" ")[0];
  const byFirstToken = roster.find((entry) => normalizeName(entry.name).split(" ")[0] === firstToken);
  return byFirstToken?.description ?? null;
}

/**
 * Extracts an exhaustive visual description of the portrait via a vision model,
 * retrying with exponential backoff since this call is the most failure-prone
 * step in the character pipeline.
 */
async function extractDetailedDescription(params: {
  portraitBytes: Buffer;
  characterName: string;
  characterDescription: string;
}): Promise<string> {
  const systemPrompt = buildCharacterDetailExtractionSystemPrompt();
  const userText = buildCharacterDetailExtractionUserText(params.characterDescription);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const description = await chatVisionFrameworkOnly({
        systemPrompt,
        userText,
        imageBase64: params.portraitBytes.toString("base64"),
        mimeType: "image/png",
      });
      if (description && description.trim().length > 0) return description;
      lastError = new Error("Vision model returned empty response");
      console.warn(`[Attempt ${attempt}/3] Vision model returned empty response, retrying...`);
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Attempt ${attempt}/3] Vision extraction failed: ${lastError.message}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }

  throw lastError ?? new Error(`Failed to extract detailed description for ${params.characterName} after 3 attempts`);
}

/**
 * Distills the exhaustive description into the compact character bible entry
 * that gets embedded in every scene prompt.
 */
async function distillSignaturePrompt(detailedDescription: string): Promise<string> {
  const systemPrompt = buildCharacterSignatureDistillSystemPrompt();
  const userText = buildCharacterSignatureDistillUserText(detailedDescription);
  let lastFailure = "No response was returned.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rawSignature = await chatText({
        systemPrompt: attempt === 1
          ? systemPrompt
          : `${systemPrompt} Your previous response failed deterministic validation. Correct every listed issue; do not truncate required identity or color details.`,
        userText: attempt === 1
          ? userText
          : `${userText}\n\nPrevious validation failure: ${lastFailure}\nReturn a corrected compact signature only.`,
      });
      const inspection = inspectCharacterSignaturePrompt(rawSignature);
      if (inspection.pass) return inspection.normalized;
      const recovered = recoverSignatureLengthOverflow(inspection, attempt === 3);
      if (recovered?.pass) return recovered.normalized;
      lastFailure = inspection.issues.join(" ");
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Character signature distillation failed validation after 3 attempts: ${lastFailure}`);
}

/**
 * Guarantees that an approved character sheet exists for `characterName`,
 * generating it on demand when it is missing.
 *
 * This is the single-character source of truth used by the production roster
 * tool and by downstream video-prompt construction. Downstream tools call it so
 * that a partially-completed or interrupted run self-heals instead of failing
 * fatally with "No approved detailed description found".
 *
 * Idempotent at three levels:
 * - Returns immediately when the sheet is already approved in the database.
 * - Reuses a checkpointed portrait/description when a prior run crashed midway.
 * - Only regenerates the specific step that is actually missing.
 */
export async function ensureCharacterSheet(params: {
  seriesState: SeriesState;
  seriesId: number;
  characterName: string;
  characterVisual?: SceneCharacterVisual;
  /** Legacy fallback only when the character is absent from the stored roster. */
  characterDescription?: string;
  customState?: CustomStateStore;
  promptHash?: string;
}): Promise<EnsureCharacterSheetResult> {
  const { seriesState, seriesId, characterName, customState, promptHash } = params;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error("seriesId must be a positive integer.");
  }

  const existing = await seriesState.getCharacterSheet(seriesId, characterName);
  // The stored series roster is the immutable portrait identity. Agent turns
  // may paraphrase a tool argument on a rerun; allowing that prose to win would
  // change the request digest and generate a second portrait for the same
  // character. Caller text remains only a legacy fallback for a character that
  // genuinely has no roster entry yet.
  const rosterDescription = (
    await resolveCharacterDescription(seriesState, seriesId, characterName)
  )?.trim();
  if (
    rosterDescription
    && params.characterDescription?.trim()
    && params.characterDescription.trim() !== rosterDescription
  ) {
    console.warn(
      `[characterSheet] Ignoring a non-canonical rerun description for "${characterName}"; ` +
      "using the stored series roster identity.",
    );
  }
  let baseCharacterDescription = rosterDescription
    || params.characterDescription?.trim()
    || existing?.description?.replace(/\.\s*Visual ontology:[\s\S]*$/iu, "").trim()
    || undefined;

  if (!baseCharacterDescription?.trim()) {
    console.warn(
      `[characterSheet] "${characterName}" is not in the series roster and has no stored description. ` +
      "Generating from the character name alone — add it to the roster for better consistency."
    );
    baseCharacterDescription = characterName;
  }
  baseCharacterDescription = baseCharacterDescription.trim();

  const generationCharacterDescription = buildOntologyAwareCharacterDescription({
    characterName,
    characterDescription: baseCharacterDescription,
    characterVisual: params.characterVisual,
  });
  const requestDigest = createCharacterPortraitRequestDigest({
    characterDescription: baseCharacterDescription,
    model: PORTRAIT_MODEL,
  });
  const { destDir, portraitPath, checkpointKey } = characterPortraitStorage({
    assetsDir: CONFIG.assetsDir,
    seriesId,
    characterName,
    requestDigest,
  });
  const prompt = buildCharacterPortraitPrompt({ characterDescription: generationCharacterDescription });

  const existingConflictsWithVisual = conflictsWithCharacterVisual({
    characterVisual: params.characterVisual,
    description: existing?.description,
    generationPrompt: existing?.generationPrompt,
  });
  const existingSignature = existing?.generationPrompt
    ? inspectCharacterSignaturePrompt(existing.generationPrompt)
    : null;
  const existingPortraitPath = existing?.referenceImagePaths?.portrait?.path;
  const existingMatchesRequest = Boolean(
    existing?.approvedAt &&
    existingSignature?.pass &&
    existing?.description.trim() === baseCharacterDescription &&
    existingPortraitPath &&
    path.resolve(existingPortraitPath) === path.resolve(portraitPath) &&
    !existingConflictsWithVisual,
  );
  if (existingMatchesRequest) {
    try {
      const bytes = await readFile(portraitPath);
      if (bytes.length > 0) {
        return {
          status: "already_approved",
          referenceImagePaths: existing!.referenceImagePaths,
          generationPrompt: existingSignature!.normalized,
        };
      }
    } catch {
      // The durable row is stale when its digest-bound portrait is missing.
    }
  }
  if (existingConflictsWithVisual) {
    console.warn(
      `[characterSheet] Existing sheet for "${characterName}" conflicts with current visual ontology; regenerating.`,
    );
  }

  const rawCheckpoint =
    customState && promptHash ? await customState.get<PortraitCheckpoint>(promptHash, checkpointKey) : null;
  const checkpointMatchesRequest = Boolean(
    rawCheckpoint &&
    rawCheckpoint.requestDigest === requestDigest &&
    rawCheckpoint.model === PORTRAIT_MODEL &&
    path.resolve(rawCheckpoint.portraitPath) === path.resolve(portraitPath),
  );
  const checkpointConflictsWithVisual = checkpointMatchesRequest && conflictsWithCharacterVisual({
    characterVisual: params.characterVisual,
    description: rawCheckpoint?.detailedDescription,
    generationPrompt: rawCheckpoint?.generationPrompt,
  });
  const checkpoint = checkpointMatchesRequest && !checkpointConflictsWithVisual ? rawCheckpoint : null;
  if (checkpointConflictsWithVisual) {
    console.warn(
      `[characterSheet] Checkpoint for "${characterName}" conflicts with current visual ontology; regenerating.`
    );
  }

  // Step 1: generate or reuse the portrait.
  let portraitBytes: Buffer | null = null;
  const forcePortraitRegeneration = existingConflictsWithVisual || checkpointConflictsWithVisual;

  if (!forcePortraitRegeneration && checkpoint?.portraitPath) {
    try {
      portraitBytes = await readFile(checkpoint.portraitPath);
      if (portraitBytes.length === 0) portraitBytes = null;
      if (portraitBytes) {
        logStep(`Reusing digest-bound checkpointed portrait for ${characterName} (model: ${checkpoint.model})`);
      }
    } catch {
      // Checkpoint points at a file that no longer exists — regenerate below.
      console.warn(`[characterSheet] Checkpointed portrait missing for ${characterName}, regenerating.`);
    }
  }

  if (!forcePortraitRegeneration && !portraitBytes) {
    try {
      portraitBytes = await readFile(portraitPath);
      if (portraitBytes.length === 0) portraitBytes = null;
      if (portraitBytes) logStep(`Reusing digest-bound on-disk portrait for ${characterName}`);
    } catch {
      // No existing portrait file on disk — generate below.
    }
  }

  if (!portraitBytes) {
    logStep(`Generating portrait with model="${PORTRAIT_MODEL}" for ${characterName}`);
    await mkdir(destDir, { recursive: true });
    portraitBytes = await generateAnyApiSceneImage(prompt, PORTRAIT_MODEL);
    if (!portraitBytes.length) throw new Error(`Portrait provider returned an empty image for ${characterName}.`);
    await writeFile(portraitPath, portraitBytes);
    logStep(`✅ Portrait generated with model="${PORTRAIT_MODEL}" for ${characterName}`);

    if (customState && promptHash) {
      await customState.set(promptHash, checkpointKey, {
        portraitPath,
        model: PORTRAIT_MODEL,
        requestDigest,
      });
    }
  }

  // Step 2: extract the exhaustive visual description.
  let detailedDescription = checkpoint?.detailedDescription;
  if (!detailedDescription) {
    logStep(`Extracting detailed visual description for ${characterName}`);
    detailedDescription = await extractDetailedDescription({
      portraitBytes,
      characterName,
      characterDescription: generationCharacterDescription,
    });
  }

  // Step 3: distill it into the compact character bible entry.
  const checkpointSignature = checkpoint?.generationPrompt
    ? inspectCharacterSignaturePrompt(checkpoint.generationPrompt)
    : null;
  let generationPrompt = checkpointSignature?.pass ? checkpointSignature.normalized : undefined;
  if (!generationPrompt) {
    logStep(`Distilling signature prompt for ${characterName}`);
    generationPrompt = await distillSignaturePrompt(detailedDescription);
  }

  if (customState && promptHash) {
    await customState.set(promptHash, checkpointKey, {
      portraitPath,
      model: PORTRAIT_MODEL,
      requestDigest,
      detailedDescription,
      generationPrompt,
    });
  }

  const referenceImagePaths: Record<string, ReferenceImage> = { portrait: { path: portraitPath } };

  await seriesState.upsertCharacterSheet(
    seriesId,
    characterName,
    baseCharacterDescription,
    referenceImagePaths,
    generationPrompt
  );

  return { status: "generated", referenceImagePaths, generationPrompt };
}

/**
 * Ensures the complete stored main-character roster in its canonical order.
 *
 * This is intentionally a deterministic application operation rather than a
 * sequence the creative agent must remember to perform. Each character still
 * uses `ensureCharacterSheet`, so approved digest-bound portraits, on-disk
 * portraits, and durable extraction checkpoints retain their existing reuse
 * behavior. Work is sequential to avoid bursting the portrait provider. If a
 * later character fails, earlier completed sheets remain durable and a rerun
 * resumes only the missing work.
 */
export async function ensureSeriesCharacterSheets(params: {
  seriesState: SeriesState;
  seriesId: number;
  /** A caller that already loaded the canonical roster may avoid a second DB read. */
  roster?: readonly CharacterDef[];
  customState?: CustomStateStore;
  promptHash?: string;
}): Promise<EnsureSeriesCharacterSheetsResult> {
  const { seriesState, seriesId, customState, promptHash } = params;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error("seriesId must be a positive integer.");
  }
  if (!(await seriesState.seriesExists(seriesId))) {
    throw new Error(
      `Series id ${seriesId} does not exist. Re-run from the beginning so ` +
      "get_or_create_series returns the current durable series id.",
    );
  }

  const roster = params.roster ? [...params.roster] : await seriesState.getSeriesCharacters(seriesId);
  if (roster.length === 0) {
    throw new Error(`Series ${seriesId} has no stored main-character roster.`);
  }

  const characters: EnsuredSeriesCharacterSheet[] = [];
  for (const character of roster) {
    const name = character.name.trim();
    const description = character.description.trim();
    if (!name || !description) {
      throw new Error(`Series ${seriesId} contains a main character with a missing name or description.`);
    }
    logStep(`Ensuring roster portrait ${characters.length + 1}/${roster.length}: ${name}`);
    const ensured = await ensureCharacterSheet({
      seriesState,
      seriesId,
      characterName: name,
      characterDescription: description,
      customState,
      promptHash,
    });
    if (!ensured.generationPrompt.trim() || !ensured.referenceImagePaths.portrait?.path) {
      throw new Error(`Character-sheet pipeline returned an incomplete approved sheet for "${name}".`);
    }
    const durable = await seriesState.getCharacterSheet(seriesId, name);
    if (
      !durable?.approvedAt
      || !durable.generationPrompt?.trim()
      || !durable.referenceImagePaths.portrait?.path
      || durable.generationPrompt.trim() !== ensured.generationPrompt.trim()
    ) {
      throw new Error(`Approved character sheet for "${name}" was not durably persisted as expected.`);
    }
    characters.push({
      name,
      status: ensured.status,
      referenceImagePaths: durable.referenceImagePaths,
      generationPrompt: durable.generationPrompt.trim(),
    });
  }

  const generatedCount = characters.filter(({ status }) => status === "generated").length;
  return {
    seriesId,
    rosterCount: roster.length,
    generatedCount,
    reusedCount: roster.length - generatedCount,
    characters,
  };
}

/**
 * Returns the locked character bible entry for a character, generating the
 * whole character sheet first if it is missing. Direct scene-video prompting
 * uses this so a missing sheet self-heals rather than aborting the run.
 */
export async function ensureCharacterBibleEntry(params: {
  seriesState: SeriesState;
  seriesId: number;
  characterName: string;
  characterVisual?: SceneCharacterVisual;
  customState?: CustomStateStore;
  promptHash?: string;
  /** Label used in the log line explaining why the sheet is being back-filled. */
  requestedBy: string;
}): Promise<string> {
  // The mandatory complete-roster sheet phase owns provenance migration and
  // signature validation. Scene prompt materialization can use an already locked
  // DB identity directly, but it must still reject an actual ontology conflict.
  const sheet = await params.seriesState.getCharacterSheet(params.seriesId, params.characterName);
  const sheetConflictsWithVisual = conflictsWithCharacterVisual({
    characterVisual: params.characterVisual,
    description: sheet?.description,
    generationPrompt: sheet?.generationPrompt,
  });
  if (sheet?.generationPrompt && !sheetConflictsWithVisual) return sheet.generationPrompt;

  const result = await ensureCharacterSheet({
    seriesState: params.seriesState,
    seriesId: params.seriesId,
    characterName: params.characterName,
    characterVisual: params.characterVisual,
    customState: params.customState,
    promptHash: params.promptHash,
  });
  if (result.status === "generated") {
    logStep(`✅ Generated or refreshed character sheet for "${params.characterName}" (needed by ${params.requestedBy})`);
  }
  return result.generationPrompt;
}
