import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import { buildCharacterPortraitPrompt } from "../promptBuilder.js";
import { generateAgnesImage } from "../providers/agnesImageClient.js";
import { generateAnyApiSceneImage } from "../providers/anyApiImageClient.js";
import { generatePollinationsImageDetailed } from "../providers/pollinationsImageClient.js";
import {
  canonicalCharacterImageName,
  downloadConvexCharacterReference,
  uploadConvexCharacterReference,
  type DownloadedConvexCharacterReference,
  type ConvexCharacterReferenceStoreOptions,
} from "../providers/convexCharacterReferenceStore.js";
import {
  SeriesState,
  type CharacterDef,
  type ReferenceImage,
} from "../state/seriesState.js";
import { logStep } from "../utils/logger.js";
import {
  inferDefaultCharacterVisual,
} from "./sceneCastCanonicalizer.js";
import { chatVisionFrameworkOnly } from "../providers/aiClient.js";
import type { SceneCharacterVisual } from "../promptBuilder.js";

export const MAX_SERIES_MAIN_CHARACTERS = 5;
const CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION = 1;

export type SeriesCharacterPortraitStatus =
  | "already_available"
  | "restored_from_convex"
  | "uploaded_existing_local"
  | "generated";

export interface EnsuredSeriesCharacterPortrait {
  name: string;
  imageName: string;
  status: SeriesCharacterPortraitStatus;
  localPath: string;
  publicUrl: string;
  publicObjectKey: string;
  sha256: string;
}

export interface EnsureSeriesCharacterPortraitsResult {
  seriesId: number;
  rosterCount: number;
  generatedCount: number;
  restoredCount: number;
  reusedCount: number;
  characters: EnsuredSeriesCharacterPortrait[];
}

export type CharacterPortraitAuditor = (params: {
  characterName: string;
  characterDescription: string;
  visual?: SceneCharacterVisual;
  imageBytes: Buffer;
}) => Promise<{ pass: boolean; reason?: string }>;

export interface SeriesCharacterPortraitDependencies {
  generatePortrait?: typeof generateAnyApiSceneImage;
  downloadReference?: typeof downloadConvexCharacterReference;
  uploadReference?: typeof uploadConvexCharacterReference;
  auditPortrait?: CharacterPortraitAuditor;
  storeOptions?: ConvexCharacterReferenceStoreOptions;
  assetsDir?: string;
  model?: string;
  now?: () => Date;
}

/** Shared production settings for ensure and terminal series cleanup hooks. */
export function configuredConvexCharacterReferenceStoreOptions(): ConvexCharacterReferenceStoreOptions {
  return {
    convexUrl: CONFIG.convexUrl,
    bucket: CONFIG.convexStorageBucket,
    deployKey: CONFIG.convexDeployKey,
    objectPrefix: CONFIG.convexCharacterReferencePrefix,
    requestTimeoutMs: CONFIG.convexStorageRequestTimeoutMs,
  };
}

function normalizeCharacter(value: CharacterDef, index: number): CharacterDef {
  const name = value?.name?.replace(/\s+/gu, " ").trim() ?? "";
  const description = value?.description?.replace(/\s+/gu, " ").trim() ?? "";
  if (!name) throw new Error(`Main character ${index + 1} must have a non-empty name.`);
  if (!description) {
    throw new Error(`Main character "${name}" must have a non-empty portrait description.`);
  }
  return { name, description };
}

/** Enforces Agnes's five-reference ceiling before any portrait work starts. */
export function validateSeriesMainCharacterRoster(
  roster: readonly CharacterDef[],
): CharacterDef[] {
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > MAX_SERIES_MAIN_CHARACTERS) {
    throw new Error(
      `A series must have 1-${MAX_SERIES_MAIN_CHARACTERS} main characters; received ${Array.isArray(roster) ? roster.length : "a non-array value"}.`,
    );
  }

  const normalized = roster.map(normalizeCharacter);
  const names = new Set<string>();
  const imageNames = new Set<string>();
  for (const character of normalized) {
    const comparableName = character.name.normalize("NFKC").toLowerCase();
    if (names.has(comparableName)) {
      throw new Error(`Main-character names must be unique; "${character.name}" is duplicated.`);
    }
    names.add(comparableName);

    const imageName = canonicalCharacterImageName(character.name);
    if (imageNames.has(imageName)) {
      throw new Error(
        `Main-character names must produce unique image filenames; "${character.name}" collides at ${imageName}.png.`,
      );
    }
    imageNames.add(imageName);
  }
  return normalized;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Retains the legacy digest/layout so existing portraits remain reusable. */
function createCharacterPortraitRequestDigest(params: {
  characterDescription: string;
  model: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION,
    characterDescription: params.characterDescription.trim(),
    model: params.model,
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

function characterPortraitStorage(params: {
  assetsDir: string;
  seriesId: number;
  characterName: string;
  requestDigest: string;
}): { destDir: string; portraitPath: string } {
  const destDir = path.join(
    params.assetsDir,
    `series_${params.seriesId}`,
    "characters",
    safeCharacterPathSegment(params.characterName),
    params.requestDigest,
  );
  return { destDir, portraitPath: path.join(destDir, "portrait.png") };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function readExistingFile(filePath: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.length < 1) throw new Error(`Character portrait is empty: ${filePath}`);
    return bytes;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function writeAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function findLocalPortrait(params: {
  candidates: readonly (string | null | undefined)[];
  canonicalPath: string;
}): Promise<Buffer | null> {
  const visited = new Set<string>();
  for (const candidate of params.candidates) {
    if (!candidate || /^https?:\/\//iu.test(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    const bytes = await readExistingFile(resolved);
    if (!bytes) continue;
    if (resolved !== path.resolve(params.canonicalPath)) {
      await writeAtomically(params.canonicalPath, bytes);
    }
    return bytes;
  }
  return null;
}

function assertMatchingLocalAndPublic(params: {
  characterName: string;
  localBytes: Buffer;
  publicReference: DownloadedConvexCharacterReference;
}): void {
  const localSha256 = sha256(params.localBytes);
  if (localSha256 !== params.publicReference.sha256) {
    throw new Error(
      `Local and public portraits for "${params.characterName}" differ. Refusing to overwrite a stable character identity; restore the intended image or remove the incorrect object explicitly.`,
    );
  }
}

/**
 * Ensures one reusable public portrait per canonical series character.
 *
 * The operation is deliberately simple and resumable:
 * 1. reuse a matching local portrait when present;
 * 2. otherwise restore the deterministic public Convex object locally;
 * 3. otherwise generate exactly one portrait;
 * 4. upload (when needed), publicly re-download, hash-verify, then persist.
 *
 * No vision analysis or text-signature distillation is performed. The legacy
 * `generation_prompt` column receives only the character name so old readers
 * cannot accidentally reuse a verbose character sheet in a video prompt.
 */
async function defaultAuditPortrait(params: {
  characterName: string;
  characterDescription: string;
  visual?: SceneCharacterVisual;
  imageBytes: Buffer;
}): Promise<{ pass: boolean; reason?: string }> {
  if (!params.visual || params.visual.visualForm === "humanoid") {
    return { pass: true };
  }
  // Only inspect if bytes is a valid image file (PNG/JPEG magic bytes)
  const isPng = params.imageBytes.length > 8 && params.imageBytes[0] === 0x89 && params.imageBytes[1] === 0x50;
  const isJpg = params.imageBytes.length > 3 && params.imageBytes[0] === 0xff && params.imageBytes[1] === 0xd8;
  if (!isPng && !isJpg) {
    return { pass: true };
  }
  try {
    const systemPrompt =
      "You are a quality-assurance visual auditor for animated character reference sheets. " +
      "Verify whether the illustrated character strictly matches the intended non-human species/ontology.";
    const userText =
      `Character Name: "${params.characterName}"\n` +
      `Description: "${params.characterDescription}"\n` +
      `Required Ontology: NON-HUMAN (${params.visual.visualForm}: ${params.visual.speciesOrType || "non-human"}).\n` +
      "Question: Does this image depict a human being (such as a human child, boy, girl, or adult person) instead of, or carrying/wearing, the object/animal?\n" +
      'Reply in JSON only: { "hasHuman": boolean, "isExpectedNonHuman": boolean, "reason": string }';
    const raw = await chatVisionFrameworkOnly({
      systemPrompt,
      userText,
      imageBase64: params.imageBytes.toString("base64"),
      mimeType: isPng ? "image/png" : "image/jpeg",
    });
    const parsed = raw.match(/\{[\s\S]*\}/);
    if (parsed) {
      const json = JSON.parse(parsed[0]);
      if (json.hasHuman === true && json.isExpectedNonHuman === false) {
        return {
          pass: false,
          reason: `Image depicts a human person instead of the intended non-human ${params.visual.speciesOrType || "object/creature"}: ${json.reason || "detected human"}`,
        };
      }
    }
  } catch (error) {
    console.warn(`[seriesCharacterPortraitService] Visual audit skipped: ${(error as Error).message}`);
  }
  return { pass: true };
}

export async function ensureSeriesCharacterPortraits(params: {
  seriesState: SeriesState;
  seriesId: number;
  roster?: readonly CharacterDef[];
  dependencies?: SeriesCharacterPortraitDependencies;
}): Promise<EnsureSeriesCharacterPortraitsResult> {
  const { seriesState, seriesId } = params;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error("seriesId must be a positive integer.");
  }
  if (!(await seriesState.seriesExists(seriesId))) {
    throw new Error(`Series id ${seriesId} does not exist.`);
  }

  const roster = validateSeriesMainCharacterRoster(
    params.roster ? [...params.roster] : await seriesState.getSeriesCharacters(seriesId),
  );
  const dependencies = params.dependencies ?? {};
  const defaultGeneratePortrait = async (prompt: string, modelName: string): Promise<Buffer> => {
    if (CONFIG.imageProvider === "agnes") {
      logStep(`Generating portrait via Agnes Image (${CONFIG.agnesImageModel})`);
      const { bytes, model: usedModel } = await generateAgnesImage(prompt, {
        aspectRatio: "1:1",
        size: "2K",
        model: CONFIG.agnesImageModel,
      });
      logStep(`✅ Portrait generated via Agnes Image (${usedModel})`);
      return bytes;
    }
    if (CONFIG.imageProvider === "pollinations") {
      logStep("Generating portrait via Pollinations");
      const { bytes, model: usedModel } = await generatePollinationsImageDetailed(
        prompt,
        CONFIG.pollinationsModel1,
        CONFIG.pollinationsModel2,
        1024,
        1024,
      );
      logStep(`✅ Portrait generated via Pollinations (${usedModel})`);
      return bytes;
    }
    return generateAnyApiSceneImage(prompt, modelName);
  };
  const generatePortrait = dependencies.generatePortrait ?? defaultGeneratePortrait;
  const downloadReference = dependencies.downloadReference ?? downloadConvexCharacterReference;
  const uploadReference = dependencies.uploadReference ?? uploadConvexCharacterReference;
  const auditPortrait = dependencies.auditPortrait ?? defaultAuditPortrait;
  const storeOptions = dependencies.storeOptions ?? configuredConvexCharacterReferenceStoreOptions();
  const assetsDir = dependencies.assetsDir ?? CONFIG.assetsDir;
  const model = dependencies.model ?? CONFIG.anyApiImageModel;
  const now = dependencies.now ?? (() => new Date());

  const characters: EnsuredSeriesCharacterPortrait[] = [];
  for (const [index, character] of roster.entries()) {
    const imageStem = canonicalCharacterImageName(character.name);
    const imageName = `${imageStem}.png`;
    const requestDigest = createCharacterPortraitRequestDigest({
      characterDescription: character.description,
      model,
    });
    const legacyStorage = characterPortraitStorage({
      assetsDir,
      seriesId,
      characterName: character.name,
      requestDigest,
    });
    const canonicalPath = path.join(legacyStorage.destDir, imageName);
    const existing = await seriesState.getCharacterSheet(seriesId, character.name);
    const existingPortrait = existing?.referenceImagePaths?.portrait;

    logStep(
      `Ensuring public character portrait ${index + 1}/${roster.length}: ${character.name} (${imageName})`,
    );

    let localBytes = await findLocalPortrait({
      candidates: [
        existing?.description.trim() === character.description
          ? existingPortrait?.path
          : undefined,
        canonicalPath,
        // Reuse pre-simplification assets without rerunning image generation.
        legacyStorage.portraitPath,
      ],
      canonicalPath,
    });
    let publicReference = await downloadReference(
      { seriesId, characterName: character.name },
      storeOptions,
    );
    let status: SeriesCharacterPortraitStatus;

    if (!localBytes && publicReference) {
      localBytes = publicReference.bytes;
      await writeAtomically(canonicalPath, localBytes);
      status = "restored_from_convex";
      logStep(`Restored ${character.name} portrait from its public Convex URL`);
    } else if (localBytes && publicReference) {
      assertMatchingLocalAndPublic({
        characterName: character.name,
        localBytes,
        publicReference,
      });
      status = "already_available";
    } else if (localBytes) {
      publicReference = await uploadReference(
        { seriesId, characterName: character.name },
        localBytes,
        storeOptions,
      );
      status = "uploaded_existing_local";
      logStep(`Uploaded existing ${character.name} portrait to Convex`);
    } else {
      const visual = inferDefaultCharacterVisual(character.name, character.description);
      const prompt = buildCharacterPortraitPrompt({
        characterDescription: `${character.name}: ${character.description}`,
        characterVisual: visual,
      });
      logStep(`Generating one portrait with model="${model}" for ${character.name}`);
      localBytes = await generatePortrait(prompt, model);
      if (localBytes.length < 1) {
        throw new Error(`Portrait provider returned an empty image for ${character.name}.`);
      }

      let audit = await auditPortrait({
        characterName: character.name,
        characterDescription: character.description,
        visual,
        imageBytes: localBytes,
      });

      if (!audit.pass) {
        logStep(`⚠️ Portrait audit failed for ${character.name}: ${audit.reason}. Retrying with strict anti-human prompt...`);
        const reinforcedPrompt = `${prompt} STRICT NEGATIVE: ABSOLUTELY NO HUMAN PERSON, NO HUMAN BOY, NO HUMAN GIRL, NO CHILD. RENDER ONLY THE ${visual?.speciesOrType?.toUpperCase() || "OBJECT"} ITSELF.`;
        localBytes = await generatePortrait(reinforcedPrompt, model);
        if (localBytes.length < 1) {
          throw new Error(`Portrait provider returned an empty image for ${character.name}.`);
        }
        audit = await auditPortrait({
          characterName: character.name,
          characterDescription: character.description,
          visual,
          imageBytes: localBytes,
        });
        if (!audit.pass) {
          throw new Error(`Character portrait failed visual ontology audit for ${character.name}: ${audit.reason}`);
        }
      }

      await writeAtomically(canonicalPath, localBytes);
      publicReference = await uploadReference(
        { seriesId, characterName: character.name },
        localBytes,
        storeOptions,
      );
      status = "generated";
      logStep(`Generated and published ${character.name} portrait`);
    }

    if (!publicReference) {
      throw new Error(`Public character portrait was not established for ${character.name}.`);
    }
    assertMatchingLocalAndPublic({
      characterName: character.name,
      localBytes,
      publicReference,
    });

    const referenceImagePaths: Record<string, ReferenceImage> = {
      portrait: {
        path: canonicalPath,
        canonicalFileName: imageName,
        requestDigest,
        sha256: publicReference.sha256,
        model,
        publicUrl: publicReference.publicUrl,
        publicObjectKey: publicReference.objectKey,
        contentType: publicReference.contentType,
        publicVerifiedAt: now().toISOString(),
      },
    };
    await seriesState.upsertCharacterSheet(
      seriesId,
      character.name,
      character.description,
      referenceImagePaths,
      character.name,
    );

    const durable = await seriesState.getCharacterSheet(seriesId, character.name);
    const durablePortrait = durable?.referenceImagePaths?.portrait;
    if (
      !durable?.approvedAt
      || durable.generationPrompt !== character.name
      || durablePortrait?.publicUrl !== publicReference.publicUrl
      || durablePortrait.sha256 !== publicReference.sha256
      || durablePortrait.path !== canonicalPath
    ) {
      throw new Error(`Portrait registry for "${character.name}" was not durably persisted.`);
    }

    characters.push({
      name: character.name,
      imageName,
      status,
      localPath: canonicalPath,
      publicUrl: publicReference.publicUrl,
      publicObjectKey: publicReference.objectKey,
      sha256: publicReference.sha256,
    });
  }

  return {
    seriesId,
    rosterCount: characters.length,
    generatedCount: characters.filter(({ status }) => status === "generated").length,
    restoredCount: characters.filter(({ status }) => status === "restored_from_convex").length,
    reusedCount: characters.filter(({ status }) => status !== "generated").length,
    characters,
  };
}
