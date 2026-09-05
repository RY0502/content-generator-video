import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  characterPortraitStorage,
  createCharacterPortraitRequestDigest,
} from "../services/characterSheetService.js";
import { agnesKeyArtPaths } from "../services/agnesKeyArtService.js";
import { planAgnesVideoSegments } from "../tools/agnesSceneVideoTool.js";
import { narrationAudioMetadataPath } from "../tools/ttsTool.js";

/**
 * Filesystem contract dry run for the production pipeline. No external API is
 * called here. Production creates images only for digest-bound character
 * portraits; two title cards and every script scene then map one-to-one to a
 * canonical Groq WAV and normalized Agnes text-to-video clip.
 */
describe("Production artifact contract dry run", () => {
  let testRoot: string;
  let assetsDir: string;
  let outputDir: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "content-generator-contract-"));
    assetsDir = path.join(testRoot, "assets");
    outputDir = path.join(testRoot, "output");
  });

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("stores the only generated image as a digest-bound character portrait", async () => {
    const characterDescription =
      "Pip the Ant: tiny red ant with six legs, round eyes, and a yellow backpack.";
    const requestDigest = createCharacterPortraitRequestDigest({ characterDescription });
    const storage = characterPortraitStorage({
      assetsDir,
      seriesId: 1,
      characterName: "Pip the Ant",
      requestDigest,
    });

    await mkdir(storage.destDir, { recursive: true });
    await writeFile(storage.portraitPath, Buffer.from("mock-character-portrait"));

    expect(storage.portraitPath).toBe(path.join(
      assetsDir,
      "series_1",
      "characters",
      "Pip_the_Ant",
      requestDigest,
      "portrait.png",
    ));
    expect((await stat(storage.portraitPath)).size).toBeGreaterThan(0);
  });

  it("stores both key-art video/audio pairs and maps every scene one-to-one", async () => {
    const episodeDir = path.join(outputDir, "series_1", "episode_1");
    const sceneNumbers = [1, 2, 3];

    for (const kind of ["series", "episode"] as const) {
      const keyArt = agnesKeyArtPaths({ outputDir, seriesId: 1, episodeNumber: 1, kind });
      await mkdir(keyArt.directory, { recursive: true });
      await writeFile(keyArt.audioPath, Buffer.from("mock-groq-title-wav"));
      await writeFile(keyArt.normalizedVideoPath, Buffer.from("mock-normalized-key-art-video"));
      expect((await stat(keyArt.audioPath)).size).toBeGreaterThan(0);
      expect((await stat(keyArt.normalizedVideoPath)).size).toBeGreaterThan(0);
    }

    for (const sceneNumber of sceneNumbers) {
      const stem = `scene_${String(sceneNumber).padStart(3, "0")}`;
      const audioPath = path.join(episodeDir, "audio", `${stem}_narrator.wav`);
      const videoPath = path.join(episodeDir, "agnes_text", "scenes", `${stem}.mp4`);
      await mkdir(path.dirname(audioPath), { recursive: true });
      await mkdir(path.dirname(videoPath), { recursive: true });
      await writeFile(audioPath, Buffer.from("mock-groq-wav"));
      await writeFile(narrationAudioMetadataPath(audioPath), JSON.stringify({
        kind: "narration-audio",
        durationSeconds: 7.5,
        durationStatus: "ready",
      }));
      await writeFile(videoPath, Buffer.from("mock-normalized-agnes-video"));
    }

    const audioFiles = (await readdir(path.join(episodeDir, "audio"))).sort();
    const videoFiles = (await readdir(path.join(episodeDir, "agnes_text", "scenes"))).sort();
    expect(audioFiles.filter((name) => name.endsWith("_narrator.wav"))).toEqual([
      "scene_001_narrator.wav",
      "scene_002_narrator.wav",
      "scene_003_narrator.wav",
    ]);
    expect(videoFiles).toEqual([
      "scene_001.mp4",
      "scene_002.mp4",
      "scene_003.mp4",
    ]);
    expect(videoFiles).toHaveLength(audioFiles.filter((name) => name.endsWith("_narrator.wav")).length);

    await expect(access(path.join(episodeDir, "scenes"))).rejects.toThrow();
    expect((await stat(path.join(episodeDir, "agnes_text", "key_art"))).isDirectory()).toBe(true);
  });

  it("uses a single Agnes request for each narration at or below twelve seconds", () => {
    expect(planAgnesVideoSegments(4.2)).toEqual([5]);
    expect(planAgnesVideoSegments(7.5)).toEqual([8]);
    expect(planAgnesVideoSegments(12)).toEqual([12]);
    expect(() => planAgnesVideoSegments(12.001)).toThrow("each scene must be at most 12s");
  });

  it("keeps caption boundaries contiguous with no artificial transition gap", async () => {
    const episodeDir = path.join(outputDir, "series_1", "episode_1");
    const captionsPath = path.join(episodeDir, "captions.srt");
    const captions = `1
00:00:00,000 --> 00:00:04,200
One sunny morning in the meadow...

2
00:00:04,200 --> 00:00:08,100
Pip woke up ready for adventure.

3
00:00:08,100 --> 00:00:11,300
Something rustled beside the path.
`;
    await mkdir(episodeDir, { recursive: true });
    await writeFile(captionsPath, captions, "utf8");

    const content = await readFile(captionsPath, "utf8");
    const ranges = [...content.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/gu)]
      .map((match) => ({ start: match[1], end: match[2] }));
    expect(ranges).toHaveLength(3);
    expect(ranges[1].start).toBe(ranges[0].end);
    expect(ranges[2].start).toBe(ranges[1].end);
  });

  it("creates the Agnes-only final output path", async () => {
    const finalPath = path.join(
      outputDir,
      "series_1",
      "episode_1",
      "Tiny_Heroes_Club_episode_1_agnes_text.mp4",
    );
    await writeFile(finalPath, Buffer.from("mock-final-video"));

    expect((await stat(finalPath)).size).toBeGreaterThan(0);
    expect(finalPath).toContain("_agnes_text.mp4");
  });
});
