import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_KEY_ART_AUDIO_MUTATION_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  AgnesKeyArtAudioMutationDeferredError,
  agnesKeyArtPaths,
  ensureAgnesKeyArtAudioAssets,
} from "../services/agnesKeyArtService.js";
import { readNarrationAudioMetadata } from "../tools/ttsTool.js";

describe("Agnes key-art title audio", () => {
  it("creates two provenance-bound WAVs in separate key-art directories and reuses them", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-audio-"));
    const audioGenerator = {
      invoke: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "generated-title-audio");
        return "ok";
      }),
    };
    const options = {
      outputDir,
      audioGenerator,
      probeDurationSeconds: vi.fn(async (filePath: string) => (
        filePath.includes(`${path.sep}series${path.sep}`) ? 2.25 : 3.5
      )),
      retryDelayMs: () => 0,
    };

    const first = await ensureAgnesKeyArtAudioAssets({
      seriesId: 4,
      episodeNumber: 7,
      seriesTitle: "  Tiny Heroes Club  ",
      episodeTitle: "\nThe Berry Bridge\t",
      options,
    });
    const second = await ensureAgnesKeyArtAudioAssets({
      seriesId: 4,
      episodeNumber: 7,
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      options,
    });

    expect(audioGenerator.invoke).toHaveBeenCalledTimes(2);
    expect(first.map(({ trackingSceneNumber }) => trackingSceneNumber)).toEqual([
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    ]);
    expect(first[0].directory).not.toBe(first[1].directory);
    expect(second.map(({ requestDigest }) => requestDigest)).toEqual(first.map(({ requestDigest }) => requestDigest));
    expect(first.map(({ text }) => text)).toEqual(["Tiny Heroes Club", "The Berry Bridge"]);
    expect(audioGenerator.invoke).toHaveBeenCalledWith(expect.objectContaining({ input: "Tiny Heroes Club" }));
    expect(audioGenerator.invoke).toHaveBeenCalledWith(expect.objectContaining({ input: "The Berry Bridge" }));
    expect((await readNarrationAudioMetadata(first[0].audioMetadataPath))?.durationSeconds).toBe(2.25);
    expect((await readNarrationAudioMetadata(first[1].audioMetadataPath))?.durationSeconds).toBe(3.5);
  });

  it("rejects an oversized title before making a paid audio request", async () => {
    const audioGenerator = { invoke: vi.fn() };
    await expect(ensureAgnesKeyArtAudioAssets({
      seriesId: 1,
      episodeNumber: 1,
      seriesTitle: "word ".repeat(13),
      episodeTitle: "Short Episode",
      options: {
        outputDir: await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-title-contract-")),
        audioGenerator,
      },
    })).rejects.toThrow("at most 12");
    expect(audioGenerator.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when a title WAV exceeds the twelve-second Agnes limit", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-long-"));
    const audioGenerator = {
      invoke: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "generated-title-audio");
        return "ok";
      }),
    };

    await expect(ensureAgnesKeyArtAudioAssets({
      seriesId: 1,
      episodeNumber: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "An Episode Title That Is Far Too Slow When Spoken",
      options: {
        outputDir,
        audioGenerator,
        probeDurationSeconds: vi.fn(async (filePath: string) => (
          filePath.includes(`${path.sep}episode${path.sep}`) ? 12.5 : 2
        )),
        retryDelayMs: () => 0,
      },
    })).rejects.toThrow("Shorten the title");
  });

  it("holds one episode mutation lease across both title candidates and commits one revision", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-lease-"));
    const audioGenerator = {
      invoke: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await writeFile(outputPath, "leased-title-audio");
        return "ok";
      }),
    };
    const audioMutationState = {
      beginEpisodeNarrationAudioMutation: vi.fn(async () => ({
        acquired: true,
        audioRevision: 4,
        startedAssetCount: 0,
      })),
      renewEpisodeNarrationAudioMutation: vi.fn(async () => true),
      completeEpisodeNarrationAudioMutation: vi.fn(async () => true),
      abortEpisodeNarrationAudioMutation: vi.fn(async () => true),
    };

    await ensureAgnesKeyArtAudioAssets({
      seriesId: 4,
      episodeNumber: 7,
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      options: {
        outputDir,
        audioGenerator,
        audioMutationState,
        probeDurationSeconds: vi.fn(async (filePath: string) => (
          filePath.includes(`${path.sep}series${path.sep}`) ? 2.25 : 3.5
        )),
        retryDelayMs: () => 0,
      },
    });

    expect(audioMutationState.beginEpisodeNarrationAudioMutation).toHaveBeenCalledOnce();
    expect(audioMutationState.beginEpisodeNarrationAudioMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesId: 4,
        episodeNumber: 7,
        sceneNumber: AGNES_KEY_ART_AUDIO_MUTATION_SCENE,
        leaseToken: expect.any(String),
      }),
    );
    expect(audioMutationState.renewEpisodeNarrationAudioMutation.mock.calls.length)
      .toBeGreaterThanOrEqual(5);
    expect(audioMutationState.completeEpisodeNarrationAudioMutation).toHaveBeenCalledOnce();
    expect(audioMutationState.abortEpisodeNarrationAudioMutation).not.toHaveBeenCalled();
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(2);
  });

  it("defers an overlapping preparer so it cannot become a late title-audio writer", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-overlap-"));
    let activeToken: string | null = null;
    let startedAssetCount = 0;
    let releaseGeneration!: () => void;
    let reportGenerationStarted!: () => void;
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const generationStarted = new Promise<void>((resolve) => { reportGenerationStarted = resolve; });
    const audioGenerator = {
      invoke: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        reportGenerationStarted();
        await generationGate;
        await writeFile(outputPath, "first-owner-title-audio");
        return "ok";
      }),
    };
    const audioMutationState = {
      beginEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (startedAssetCount > 0) {
          return { acquired: false, reason: "agnes_started" as const, startedAssetCount };
        }
        if (activeToken) {
          return { acquired: false, reason: "mutation_in_progress" as const, startedAssetCount: 0 };
        }
        activeToken = input.leaseToken;
        return { acquired: true, audioRevision: 0, startedAssetCount: 0 };
      }),
      renewEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => (
        activeToken === input.leaseToken
      )),
      completeEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (activeToken !== input.leaseToken) return false;
        activeToken = null;
        return true;
      }),
      abortEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (activeToken !== input.leaseToken) return false;
        activeToken = null;
        return true;
      }),
    };
    const request = {
      seriesId: 8,
      episodeNumber: 3,
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      options: {
        outputDir,
        audioGenerator,
        audioMutationState,
        probeDurationSeconds: vi.fn(async () => 3),
        retryDelayMs: () => 0,
      },
    };

    const firstPreparer = ensureAgnesKeyArtAudioAssets(request);
    await generationStarted;
    const overlappingPreparer = ensureAgnesKeyArtAudioAssets(request);
    await expect(overlappingPreparer).rejects.toMatchObject({
      name: "AgnesKeyArtAudioMutationDeferredError",
      reason: "mutation_in_progress",
    });
    releaseGeneration();
    const firstAssets = await firstPreparer;
    startedAssetCount = 1; // Models the first Agnes claim immediately after preparation.

    const beforeLateRetry = await Promise.all(firstAssets.map(({ audioPath }) => readFile(audioPath, "utf8")));
    const reusedAfterClaim = await ensureAgnesKeyArtAudioAssets({
      ...request,
      options: { ...request.options, allowMutation: false },
    });
    expect(await Promise.all(reusedAfterClaim.map(({ audioPath }) => readFile(audioPath, "utf8"))))
      .toEqual(beforeLateRetry);
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(2);
  });

  it("restores both prior title pairs when the lease is lost at revision commit", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-key-art-rollback-"));
    const seriesPaths = agnesKeyArtPaths({ outputDir, seriesId: 2, episodeNumber: 5, kind: "series" });
    const episodePaths = agnesKeyArtPaths({ outputDir, seriesId: 2, episodeNumber: 5, kind: "episode" });
    await Promise.all([mkdir(seriesPaths.directory, { recursive: true }), mkdir(episodePaths.directory, { recursive: true })]);
    await Promise.all([
      writeFile(seriesPaths.audioPath, "old-series-audio"),
      writeFile(seriesPaths.audioMetadataPath, "old-series-metadata"),
      writeFile(episodePaths.audioPath, "old-episode-audio"),
      writeFile(episodePaths.audioMetadataPath, "old-episode-metadata"),
    ]);
    const audioMutationState = {
      beginEpisodeNarrationAudioMutation: vi.fn(async () => ({
        acquired: true,
        audioRevision: 3,
        startedAssetCount: 0,
      })),
      renewEpisodeNarrationAudioMutation: vi.fn(async () => true),
      completeEpisodeNarrationAudioMutation: vi.fn(async () => false),
      abortEpisodeNarrationAudioMutation: vi.fn(async () => true),
    };

    await expect(ensureAgnesKeyArtAudioAssets({
      seriesId: 2,
      episodeNumber: 5,
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "The Berry Bridge",
      options: {
        outputDir,
        audioMutationState,
        audioGenerator: {
          invoke: vi.fn(async ({ outputPath }: { outputPath: string }) => {
            await writeFile(outputPath, "new-candidate-audio");
            return "ok";
          }),
        },
        probeDurationSeconds: vi.fn(async () => 3),
        retryDelayMs: () => 0,
      },
    })).rejects.toBeInstanceOf(AgnesKeyArtAudioMutationDeferredError);

    expect(await readFile(seriesPaths.audioPath, "utf8")).toBe("old-series-audio");
    expect(await readFile(seriesPaths.audioMetadataPath, "utf8")).toBe("old-series-metadata");
    expect(await readFile(episodePaths.audioPath, "utf8")).toBe("old-episode-audio");
    expect(await readFile(episodePaths.audioMetadataPath, "utf8")).toBe("old-episode-metadata");
    expect(audioMutationState.abortEpisodeNarrationAudioMutation).toHaveBeenCalledOnce();
  });
});
