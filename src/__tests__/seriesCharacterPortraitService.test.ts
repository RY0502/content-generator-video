import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterDef, CharacterSheetRow, SeriesState } from "../state/seriesState.js";
import type { DownloadedSupabaseCharacterReference } from "../providers/supabaseCharacterReferenceStore.js";
import {
  ensureSeriesCharacterPortraits,
  validateSeriesMainCharacterRoster,
} from "../services/seriesCharacterPortraitService.js";
import {
  characterPortraitStorage,
  createCharacterPortraitRequestDigest,
} from "../services/characterSheetService.js";

const model = "google/gemini-3.1-flash-image";
const storeOptions = {
  projectUrl: "https://project.supabase.co",
  bucket: "character-refs",
  serviceRoleKey: "service-role-secret",
  objectPrefix: "series-characters",
};

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function remoteReference(
  bytes: Buffer,
  characterName = "Bobo the Backpack",
): DownloadedSupabaseCharacterReference {
  const slug = characterName.toLowerCase().replaceAll(" ", "_");
  const objectKey = `series-characters/series_7/characters/${slug}.png`;
  return {
    bytes,
    sha256: digest(bytes),
    contentType: "image/png",
    objectKey,
    publicUrl: `https://project.supabase.co/storage/v1/object/public/character-refs/${objectKey}`,
  };
}

function fakeSeriesState(roster: CharacterDef[]) {
  const rows = new Map<string, CharacterSheetRow>();
  const state = {
    seriesExists: vi.fn(async () => true),
    getSeriesCharacters: vi.fn(async () => roster),
    getCharacterSheet: vi.fn(async (_seriesId: number, name: string) => rows.get(name) ?? null),
    upsertCharacterSheet: vi.fn(async (
      seriesId: number,
      characterName: string,
      description: string,
      referenceImagePaths: CharacterSheetRow["referenceImagePaths"],
      generationPrompt?: string,
    ) => {
      rows.set(characterName, {
        id: rows.size + 1,
        seriesId,
        characterName,
        description,
        referenceImagePaths,
        generationPrompt: generationPrompt ?? null,
        approvedAt: "2026-09-15T00:00:00.000Z",
      });
    }),
  };
  return { state: state as unknown as SeriesState, rows, spies: state };
}

describe("ensureSeriesCharacterPortraits", () => {
  let assetsDir: string;
  const roster = [{
    name: "Bobo the Backpack",
    description: "A friendly red magical backpack with one face and two straps.",
  }];

  beforeEach(async () => {
    assetsDir = await mkdtemp(path.join(tmpdir(), "portrait-registry-"));
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it("restores a missing local portrait from its deterministic public object without generating", async () => {
    const bytes = Buffer.from("existing-public-portrait");
    const publicReference = remoteReference(bytes);
    const { state, rows } = fakeSeriesState(roster);
    const generatePortrait = vi.fn();
    const uploadReference = vi.fn();

    const result = await ensureSeriesCharacterPortraits({
      seriesState: state,
      seriesId: 7,
      dependencies: {
        assetsDir,
        model,
        storeOptions,
        generatePortrait,
        downloadReference: vi.fn(async () => publicReference),
        uploadReference,
        now: () => new Date("2026-09-15T10:00:00.000Z"),
      },
    });

    expect(result.generatedCount).toBe(0);
    expect(result.restoredCount).toBe(1);
    expect(result.characters[0]).toMatchObject({
      imageName: "bobo_the_backpack.png",
      status: "restored_from_supabase",
      publicUrl: publicReference.publicUrl,
    });
    expect(generatePortrait).not.toHaveBeenCalled();
    expect(uploadReference).not.toHaveBeenCalled();
    await expect(readFile(result.characters[0].localPath)).resolves.toEqual(bytes);
    expect(path.basename(result.characters[0].localPath)).toBe("bobo_the_backpack.png");

    const persisted = rows.get("Bobo the Backpack")!;
    expect(persisted.generationPrompt).toBe("Bobo the Backpack");
    expect(persisted.referenceImagePaths.portrait).toMatchObject({
      canonicalFileName: "bobo_the_backpack.png",
      sha256: digest(bytes),
      publicUrl: publicReference.publicUrl,
      publicObjectKey: publicReference.objectKey,
      publicVerifiedAt: "2026-09-15T10:00:00.000Z",
    });
  });

  it("generates exactly once only when both local and public copies are absent", async () => {
    const bytes = Buffer.from("new-portrait");
    const { state } = fakeSeriesState(roster);
    const generatePortrait = vi.fn(async () => bytes);
    const uploadReference = vi.fn(async (_identity, uploaded: Buffer) => remoteReference(uploaded));

    const result = await ensureSeriesCharacterPortraits({
      seriesState: state,
      seriesId: 7,
      dependencies: {
        assetsDir,
        model,
        storeOptions,
        generatePortrait,
        downloadReference: vi.fn(async () => null),
        uploadReference,
      },
    });

    expect(result.generatedCount).toBe(1);
    expect(result.characters[0].status).toBe("generated");
    expect(generatePortrait).toHaveBeenCalledOnce();
    const generationCall = generatePortrait.mock.calls[0] as unknown as [string, string];
    expect(generationCall[0]).toContain("Bobo the Backpack");
    expect(generationCall[1]).toBe(model);
    expect(uploadReference).toHaveBeenCalledOnce();
    expect(uploadReference.mock.calls[0][1]).toEqual(bytes);
  });

  it("reuses and migrates an old portrait.png asset before publishing it", async () => {
    const bytes = Buffer.from("legacy-local-portrait");
    const { state } = fakeSeriesState(roster);
    const requestDigest = createCharacterPortraitRequestDigest({
      characterDescription: roster[0].description,
      model,
    });
    const legacy = characterPortraitStorage({
      assetsDir,
      seriesId: 7,
      characterName: roster[0].name,
      requestDigest,
    });
    await mkdir(legacy.destDir, { recursive: true });
    await writeFile(legacy.portraitPath, bytes);
    const generatePortrait = vi.fn();
    const uploadReference = vi.fn(async (_identity, uploaded: Buffer) => remoteReference(uploaded));

    const result = await ensureSeriesCharacterPortraits({
      seriesState: state,
      seriesId: 7,
      dependencies: {
        assetsDir,
        model,
        storeOptions,
        generatePortrait,
        downloadReference: vi.fn(async () => null),
        uploadReference,
      },
    });

    expect(result.characters[0].status).toBe("uploaded_existing_local");
    expect(generatePortrait).not.toHaveBeenCalled();
    expect(uploadReference).toHaveBeenCalledOnce();
    await expect(readFile(result.characters[0].localPath)).resolves.toEqual(bytes);
  });

  it("does not generate when the public lookup has a transient or policy error", async () => {
    const { state } = fakeSeriesState(roster);
    const generatePortrait = vi.fn();
    await expect(ensureSeriesCharacterPortraits({
      seriesState: state,
      seriesId: 7,
      dependencies: {
        assetsDir,
        model,
        storeOptions,
        generatePortrait,
        downloadReference: vi.fn(async () => {
          throw new Error("HTTP 503");
        }),
        uploadReference: vi.fn(),
      },
    })).rejects.toThrow("HTTP 503");
    expect(generatePortrait).not.toHaveBeenCalled();
  });

  it("fails closed when local and public bytes describe different identities", async () => {
    const localBytes = Buffer.from("local-identity");
    const { state, rows } = fakeSeriesState(roster);
    const requestDigest = createCharacterPortraitRequestDigest({
      characterDescription: roster[0].description,
      model,
    });
    const storage = characterPortraitStorage({
      assetsDir,
      seriesId: 7,
      characterName: roster[0].name,
      requestDigest,
    });
    await mkdir(storage.destDir, { recursive: true });
    await writeFile(storage.portraitPath, localBytes);

    await expect(ensureSeriesCharacterPortraits({
      seriesState: state,
      seriesId: 7,
      dependencies: {
        assetsDir,
        model,
        storeOptions,
        generatePortrait: vi.fn(),
        downloadReference: vi.fn(async () => remoteReference(Buffer.from("other-identity"))),
        uploadReference: vi.fn(),
      },
    })).rejects.toThrow("differ");
    expect(rows.size).toBe(0);
  });
});

describe("validateSeriesMainCharacterRoster", () => {
  it("rejects more than five main characters before provider work", () => {
    const roster = Array.from({ length: 6 }, (_, index) => ({
      name: `Character ${index + 1}`,
      description: "A defined character.",
    }));
    expect(() => validateSeriesMainCharacterRoster(roster)).toThrow("1-5");
  });

  it("rejects duplicate names and canonical filename collisions", () => {
    expect(() => validateSeriesMainCharacterRoster([
      { name: "Mia", description: "One." },
      { name: " mia ", description: "Two." },
    ])).toThrow("unique");
    expect(() => validateSeriesMainCharacterRoster([
      { name: "Bobo!", description: "One." },
      { name: "Bobo?", description: "Two." },
    ])).toThrow("unique image filenames");
  });
});
