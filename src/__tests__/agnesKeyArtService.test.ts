import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
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
});
