import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import { buildCharacterPortraitPrompt } from "../promptBuilder.js";
import { generateAnyApiSceneImage } from "../providers/anyApiImageClient.js";
import {
  canonicalCharacterImageName,
  downloadSupabaseCharacterReference,
  uploadSupabaseCharacterReference,
  type DownloadedSupabaseCharacterReference,
  type SupabaseCharacterReferenceStoreOptions,
} from "../providers/supabaseCharacterReferenceStore.js";
import {
  SeriesState,
  type CharacterDef,
  type ReferenceImage,
} from "../state/seriesState.js";
import { logStep } from "../utils/logger.js";

export const MAX_SERIES_MAIN_CHARACTERS = 5;
const CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION = 1;

export type SeriesCharacterPortraitStatus =
  | "already_available"
  | "restored_from_supabase"
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

export interface SeriesCharacterPortraitDependencies {
  generatePortrait?: typeof generateAnyApiSceneImage;
  downloadReference?: typeof downloadSupabaseCharacterReference;
  uploadReference?: typeof uploadSupabaseCharacterReference;
  storeOptions?: SupabaseCharacterReferenceStoreOptions;
  assetsDir?: string;
  model?: string;
  now?: () => Date;
}

/** Shared production settings for ensure and terminal series cleanup hooks. */
export function configuredSupabaseCharacterReferenceStoreOptions(): SupabaseCharacterReferenceStoreOptions {
  return {
    projectUrl: CONFIG.supabaseUrl,
    bucket: CONFIG.supabaseStorageBucket,
    serviceRoleKey: CONFIG.supabaseServiceRoleKey,
    objectPrefix: CONFIG.supabaseCharacterReferencePrefix,
    requestTimeoutMs: CONFIG.supabaseStorageRequestTimeoutMs,
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
  publicReference: DownloadedSupabaseCharacterReference;
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
 * 2. otherwise restore the deterministic public Supabase object locally;
 * 3. otherwise generate exactly one portrait;
 * 4. upload (when needed), publicly re-download, hash-verify, then persist.
 *
 * No vision analysis or text-signature distillation is performed. The legacy
 * `generation_prompt` column receives only the character name so old readers
 * cannot accidentally reuse a verbose character sheet in a video prompt.
 */
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
  const generatePortrait = dependencies.generatePortrait ?? generateAnyApiSceneImage;
  const downloadReference = dependencies.downloadReference ?? downloadSupabaseCharacterReference;
  const uploadReference = dependencies.uploadReference ?? uploadSupabaseCharacterReference;
  const storeOptions = dependencies.storeOptions ?? configuredSupabaseCharacterReferenceStoreOptions();
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
      status = "restored_from_supabase";
      logStep(`Restored ${character.name} portrait from its public Supabase URL`);
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
      logStep(`Uploaded existing ${character.name} portrait to Supabase`);
    } else {
      const prompt = buildCharacterPortraitPrompt({
        characterDescription: `${character.name}: ${character.description}`,
      });
      logStep(`Generating one portrait with model="${model}" for ${character.name}`);
      localBytes = await generatePortrait(prompt, model);
      if (localBytes.length < 1) {
        throw new Error(`Portrait provider returned an empty image for ${character.name}.`);
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
    restoredCount: characters.filter(({ status }) => status === "restored_from_supabase").length,
    reusedCount: characters.filter(({ status }) => status !== "generated").length,
    characters,
  };
}
