import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ffmpeg-installer/ffmpeg", () => ({ default: { path: "ffmpeg", version: "6.0", url: "" } }));
vi.mock("@ffprobe-installer/ffprobe", () => ({ default: { path: "ffprobe", version: "6.0", url: "" } }));

vi.mock("../config.js", () => ({
  CONFIG: {
    outputDir: "/tmp/output",
    assetsDir: "/tmp/assets",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    groqTtsVoice: "hannah",
    groqTtsModel: "canopylabs/orpheus-v1-english",
    burnSubtitles: false,
    agnesReferenceEnabled: false,
  },
}));

vi.mock("freetier-deepagent-framework", () => ({
  createAudioGenTool: () => ({
    invoke: vi.fn().mockResolvedValue("Audio generated successfully"),
  }),
}));

vi.mock("fluent-ffmpeg", () => {
  const ffprobeFn = (_path: string, cb: (err: Error | null, data: any) => void) => {
    cb(null, { format: { duration: 3.0 } });
  };
  const ffmpegFn = Object.assign(() => ({}), {
    setFfprobePath: vi.fn(),
    ffprobe: ffprobeFn,
  });
  return { default: ffmpegFn };
});

import { CONFIG } from "../config.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
} from "../services/agnesKeyArtService.js";
import { buildVideoAssemblyTool } from "../tools/videoAssemblyTool.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  createNarrationAudioRequestDigest,
} from "../tools/ttsTool.js";

describe("videoAssemblyTool", () => {
  it("normalizes scenes from a JSON string via the tool schema", () => {
    const tool = buildVideoAssemblyTool();

    const parsed = (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: JSON.stringify([
        {
          sceneNumber: 1,
          narrationAudioPath: "/tmp/scene_001.wav",
        },
      ]),
    });

    expect(parsed.scenes).toEqual([
      {
        sceneNumber: 1,
        narrationAudioPath: "/tmp/scene_001.wav",
      },
    ]);
    expect(parsed.seriesTitle).toBe("Tiny Heroes Club");
    expect(parsed.burnSubtitles).toBe(false);
  });

  it("accepts explicit burnSubtitles flag in schema", () => {
    const tool = buildVideoAssemblyTool();

    const parsed = (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [
        {
          sceneNumber: 1,
          narrationAudioPath: "/tmp/scene_001.wav",
        },
      ],
      burnSubtitles: true,
    });

    expect(parsed.burnSubtitles).toBe(true);
  });

  it("does not expose inter-scene transition padding", () => {
    const tool = buildVideoAssemblyTool();

    const parsedDefault = (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [
        {
          sceneNumber: 1,
          narrationAudioPath: "/tmp/scene_001.wav",
        },
      ],
    });

    expect(parsedDefault).not.toHaveProperty("transitionSeconds");

    const parsedCustom = (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [
        {
          sceneNumber: 1,
          narrationAudioPath: "/tmp/scene_001.wav",
        },
      ],
      transitionSeconds: 0.5,
    });

    expect(parsedCustom).not.toHaveProperty("transitionSeconds");
  });

  it("rejects a caller scene order that differs from the persisted script and records failure", async () => {
    const upsertEpisodeVideoOutput = vi.fn().mockResolvedValue({});
    const seriesState = {
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 1,
        scriptJson: { scenes: [{ sceneNumber: 1 }, { sceneNumber: 2 }] },
      }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 300 }),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([]),
      upsertEpisodeVideoOutput,
    };
    const tool = buildVideoAssemblyTool(seriesState as any);

    await expect((tool as any).func({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [
        { sceneNumber: 2, narrationAudioPath: "/missing/2.wav" },
        { sceneNumber: 1, narrationAudioPath: "/missing/1.wav" },
      ],
    })).rejects.toThrow("does not match persisted script order");

    expect(upsertEpisodeVideoOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({
      variant: "agnes_text",
      status: "pending",
      outputPath: null,
    }));
    expect(upsertEpisodeVideoOutput).toHaveBeenLastCalledWith(expect.objectContaining({
      variant: "agnes_text",
      status: "failed",
      error: expect.stringContaining("persisted script order"),
    }));
  });

  it("never accepts an arbitrary Agnes override in place of the canonical scene file", async () => {
    const priorOutputDir = CONFIG.outputDir;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "assembly-canonical-"));
    const overridePath = path.join(outputDir, "unrelated.mp4");
    await writeFile(overridePath, Buffer.from("not-canonical"));
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    const seriesState = {
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 1,
        scriptJson: { scenes: [{ sceneNumber: 1 }] },
      }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 300 }),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([{
        sceneNumber: 1,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        normalizedOutputPath: overridePath,
        requestedDurationSeconds: 4,
      }]),
      upsertEpisodeVideoOutput: vi.fn().mockResolvedValue({}),
    };
    const tool = buildVideoAssemblyTool(seriesState as any);

    try {
      await expect((tool as any).func({
        seriesId: 1,
        seriesTitle: "Tiny Heroes Club",
        episodeNumber: 1,
        scenes: [{
          sceneNumber: 1,
          narrationAudioPath: "/unused.wav",
          agnesTextVideoPath: overridePath,
        }],
      })).rejects.toThrow("Missing canonical Agnes text video");
    } finally {
      (CONFIG as { outputDir: string }).outputDir = priorOutputDir;
    }
  });

  it("does not expose caller-provided image, key-art, or visual-variant inputs", () => {
    const tool = buildVideoAssemblyTool();
    const parsed = (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [{
        sceneNumber: 1,
        narrationAudioPath: "/tmp/scene.wav",
        imagePath: "/tmp/scene.png",
        agnesReferenceVideoPath: "/tmp/reference.mp4",
      }],
      seriesKeyArtPath: "/tmp/series.png",
      episodeKeyArtPath: "/tmp/episode.png",
      visualVariant: "agnes_reference",
    });

    expect(parsed).not.toHaveProperty("seriesKeyArtPath");
    expect(parsed).not.toHaveProperty("episodeKeyArtPath");
    expect(parsed).not.toHaveProperty("visualVariant");
    expect(parsed.scenes[0]).toEqual({
      sceneNumber: 1,
      narrationAudioPath: "/tmp/scene.wav",
    });
  });

  it("prepends both canonical Agnes key-art clips and offsets burned scene captions", async () => {
    const priorOutputDir = CONFIG.outputDir;
    const priorFfmpegPath = CONFIG.ffmpegPath;
    const priorFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "assembly-key-art-"));
    const ffmpegLog = path.join(outputDir, "ffmpeg.log");
    const fakeFfmpeg = path.join(outputDir, "fake-ffmpeg.sh");
    const fakeFfprobe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeFfmpeg, [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> '${ffmpegLog}'`,
      "last=''",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf 'fake-video-data' > \"$last\"",
    ].join("\n"), "utf8");
    await writeFile(fakeFfprobe, [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *series_key_art*) printf '1.5\\n' ;;",
      "  *episode_key_art*) printf '2.0\\n' ;;",
      "  *key_art_preview*|*concatenated.mp4*) printf '5.75\\n' ;;",
      "  *) printf '2.25\\n' ;;",
      "esac",
    ].join("\n"), "utf8");
    await chmod(fakeFfmpeg, 0o755);
    await chmod(fakeFfprobe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffmpegPath: string }).ffmpegPath = fakeFfmpeg;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeFfprobe;

    const episodeDir = path.join(outputDir, "series_1", "episode_1");
    const scenePath = path.join(episodeDir, "agnes_text", "scenes", "scene_001.mp4");
    const narrationPath = path.join(episodeDir, "audio", "scene_001_narrator.wav");
    const captionsPath = path.join(episodeDir, "captions.srt");
    await mkdir(path.dirname(scenePath), { recursive: true });
    await mkdir(path.dirname(narrationPath), { recursive: true });
    await writeFile(scenePath, "scene-video");
    await writeFile(narrationPath, "scene-audio");
    await writeFile(captionsPath, "1\n00:00:00,000 --> 00:00:02,250\nPip waves.\n", "utf8");

    const introRows: any[] = [];
    for (const spec of [
      {
        kind: "series" as const,
        title: "Tiny Heroes Club",
        duration: 1.5,
        trackingSceneNumber: AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      },
      {
        kind: "episode" as const,
        title: "Pip Waves Hello",
        duration: 2,
        trackingSceneNumber: AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      },
    ]) {
      const paths = agnesKeyArtPaths({ outputDir, seriesId: 1, episodeNumber: 1, kind: spec.kind });
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.audioPath, "title-audio");
      await writeFile(paths.normalizedVideoPath, "title-video");
      await writeFile(paths.audioMetadataPath, JSON.stringify({
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: createNarrationAudioRequestDigest({
          text: spec.title,
          model: CONFIG.groqTtsModel,
          voice: CONFIG.groqTtsVoice,
        }),
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: spec.title.length,
        spokenWordCount: 3,
        durationSeconds: spec.duration,
        durationStatus: "ready",
      }));
      introRows.push({
        sceneNumber: spec.trackingSceneNumber,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        normalizedOutputPath: paths.normalizedVideoPath,
        requestedDurationSeconds: spec.duration,
      });
    }

    const seriesState = {
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 1,
        title: "  Pip Waves Hello  ",
        scriptJson: { scenes: [{ sceneNumber: 1 }] },
      }),
      getSeriesInfo: vi.fn().mockResolvedValue({ conceptName: "  Tiny Heroes Club  " }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 300 }),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([
        ...introRows,
        {
          sceneNumber: 1,
          variant: "text",
          status: "completed",
          downloadStatus: "downloaded",
          normalizedOutputPath: scenePath,
          requestedDurationSeconds: 2.25,
        },
      ]),
      upsertEpisodeVideoOutput: vi.fn().mockResolvedValue({}),
      updateEpisodeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const previewPath = path.join(outputDir, "key_art_preview.mp4");
    const tool = buildVideoAssemblyTool(seriesState as any, {
      outputPath: previewPath,
      workDir: path.join(outputDir, "work"),
      includeKeyArt: true,
      includeOutro: false,
    });

    try {
      const result = JSON.parse(await (tool as any).func({
        seriesId: 1,
        seriesTitle: "Tiny Heroes Club",
        episodeNumber: 1,
        scenes: [{ sceneNumber: 1, narrationAudioPath: narrationPath }],
        captionsSrtPath: captionsPath,
        burnSubtitles: true,
      }));

      expect(result.keyArtClipCount).toBe(2);
      expect(result.keyArtDurationSeconds).toBe(3.5);
      expect(result.storyDurationSeconds).toBe(2.25);
      expect(result.expectedDurationSeconds).toBe(5.75);
      const calls = await readFile(ffmpegLog, "utf8");
      expect(calls.indexOf("series_key_art_narrator.wav")).toBeLessThan(calls.indexOf("episode_key_art_narrator.wav"));
      expect(calls.indexOf("episode_key_art_narrator.wav")).toBeLessThan(calls.indexOf("scene_001_narrator.wav"));
      expect(calls).toContain("captions_with_key_art_offset.srt");
    } finally {
      (CONFIG as { outputDir: string }).outputDir = priorOutputDir;
      (CONFIG as { ffmpegPath: string }).ffmpegPath = priorFfmpegPath;
      (CONFIG as { ffprobePath: string }).ffprobePath = priorFfprobePath;
    }
  });

  it("rejects empty scene manifests in the public schema", () => {
    const tool = buildVideoAssemblyTool();
    expect(() => (tool as any).schema.parse({
      seriesId: 1,
      seriesTitle: "Tiny Heroes Club",
      episodeNumber: 1,
      scenes: [],
    })).toThrow();
  });

  it("uses canonical Agnes video, measures narration, holds its final frame for outro, and persists completion", async () => {
    const priorOutputDir = CONFIG.outputDir;
    const priorFfmpegPath = CONFIG.ffmpegPath;
    const priorFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "assembly-duration-"));
    const ffmpegLog = path.join(outputDir, "ffmpeg.log");
    const fakeFfmpeg = path.join(outputDir, "fake-ffmpeg.sh");
    const fakeFfprobe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeFfmpeg, [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> '${ffmpegLog}'`,
      "last=''",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf 'fake-video-data' > \"$last\"",
    ].join("\n"), "utf8");
    await writeFile(fakeFfprobe, [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *first_5_preview*) printf '5.25\\n' ;;",
      "  *outro_subscribe.mp4*) printf '3.0\\n' ;;",
      "  *) printf '2.25\\n' ;;",
      "esac",
    ].join("\n"), "utf8");
    await chmod(fakeFfmpeg, 0o755);
    await chmod(fakeFfprobe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffmpegPath: string }).ffmpegPath = fakeFfmpeg;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeFfprobe;

    const episodeDir = path.join(outputDir, "series_1", "episode_1");
    const scenePath = path.join(episodeDir, "agnes_text", "scenes", "scene_001.mp4");
    const narrationPath = path.join(episodeDir, "audio", "scene_001_narrator.wav");
    const outroAudio = path.join(outputDir, "shared", "outro_subscribe.wav");
    for (const filePath of [
      scenePath,
      narrationPath,
      outroAudio,
    ]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from("asset"));
    }

    const upsertEpisodeVideoOutput = vi.fn().mockResolvedValue({});
    const seriesState = {
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 1,
        scriptJson: { scenes: [{ sceneNumber: 1 }] },
      }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 300 }),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([{
        sceneNumber: 1,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        normalizedOutputPath: scenePath,
        requestedDurationSeconds: 2.25,
      }]),
      upsertEpisodeVideoOutput,
      updateEpisodeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const previewPath = path.join(outputDir, "evaluation", "first_5_preview.mp4");
    const previewWorkDir = path.join(outputDir, "evaluation", "work");
    const tool = buildVideoAssemblyTool(seriesState as any, {
      outputPath: previewPath,
      workDir: previewWorkDir,
    });

    try {
      const result = JSON.parse(await (tool as any).func({
        seriesId: 1,
        seriesTitle: "Tiny Heroes Club",
        episodeNumber: 1,
        scenes: [{
          sceneNumber: 1,
          narrationAudioPath: narrationPath,
        }],
      }));

      expect(result.storyDurationSeconds).toBe(2.25);
      expect(result.expectedDurationSeconds).toBe(5.25);
      expect(result.encodedClipTimelineSeconds).toBe(5.25);
      expect(result.durationSeconds).toBe(5.25);
      expect(result.durationDeltaSeconds).toBe(0);
      expect(result.allowedDurationDeltaSeconds).toBe(0.15);
      expect(result.path).toBe(previewPath);
      expect(await readFile(previewPath, "utf8")).toBe("fake-video-data");
      const ffmpegCalls = await readFile(ffmpegLog, "utf8");
      const sceneCall = ffmpegCalls.split("\n").find((line) => line.includes("clip_001.mp4"));
      expect(sceneCall).toContain("-t 2.25");
      expect(sceneCall).toContain(scenePath);
      expect(sceneCall).not.toContain("tpad=");
      const outroCall = ffmpegCalls.split("\n").find((line) => line.includes("outro_subscribe.mp4"));
      expect(outroCall).toContain(`-sseof -0.1 -i ${scenePath}`);
      expect(outroCall).toContain("select=eq(n\\,0)");
      expect(outroCall).toContain("tpad=stop_mode=clone");
      expect(ffmpegCalls).not.toContain("key_art");
      expect(upsertEpisodeVideoOutput).toHaveBeenLastCalledWith(expect.objectContaining({
        variant: "agnes_text",
        status: "completed",
        durationSeconds: 5.25,
      }));
      expect(seriesState.updateEpisodeStatus).toHaveBeenCalledWith(
        1,
        "assembly",
        { outputPath: previewPath },
      );
    } finally {
      (CONFIG as { outputDir: string }).outputDir = priorOutputDir;
      (CONFIG as { ffmpegPath: string }).ffmpegPath = priorFfmpegPath;
      (CONFIG as { ffprobePath: string }).ffprobePath = priorFfprobePath;
    }
  });

  it("rejects an appended final timeline and atomically preserves an existing deliverable", async () => {
    const priorOutputDir = CONFIG.outputDir;
    const priorFfmpegPath = CONFIG.ffmpegPath;
    const priorFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "assembly-appended-"));
    const fakeFfmpeg = path.join(outputDir, "fake-ffmpeg.sh");
    const fakeFfprobe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeFfmpeg, [
      "#!/bin/sh",
      "last=''",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf 'bad-appended-video' > \"$last\"",
    ].join("\n"), "utf8");
    await writeFile(fakeFfprobe, [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *bad_preview*) printf '4.5\\n' ;;",
      "  *) printf '2.25\\n' ;;",
      "esac",
    ].join("\n"), "utf8");
    await chmod(fakeFfmpeg, 0o755);
    await chmod(fakeFfprobe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffmpegPath: string }).ffmpegPath = fakeFfmpeg;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeFfprobe;

    const episodeDir = path.join(outputDir, "series_1", "episode_1");
    const scenePath = path.join(episodeDir, "agnes_text", "scenes", "scene_001.mp4");
    const narrationPath = path.join(episodeDir, "audio", "scene_001_narrator.wav");
    for (const filePath of [scenePath, narrationPath]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from("asset"));
    }

    const upsertEpisodeVideoOutput = vi.fn().mockResolvedValue({});
    const seriesState = {
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 1,
        scriptJson: { scenes: [{ sceneNumber: 1 }] },
      }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 300 }),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([{
        sceneNumber: 1,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        normalizedOutputPath: scenePath,
        requestedDurationSeconds: 2.25,
      }]),
      upsertEpisodeVideoOutput,
      updateEpisodeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const previewPath = path.join(outputDir, "evaluation", "bad_preview.mp4");
    await mkdir(path.dirname(previewPath), { recursive: true });
    await writeFile(previewPath, "known-good-video", "utf8");
    const tool = buildVideoAssemblyTool(seriesState as any, {
      outputPath: previewPath,
      workDir: path.join(outputDir, "evaluation", "work"),
      includeOutro: false,
    });

    try {
      await expect((tool as any).func({
        seriesId: 1,
        seriesTitle: "Tiny Heroes Club",
        episodeNumber: 1,
        scenes: [{
          sceneNumber: 1,
          narrationAudioPath: narrationPath,
        }],
      })).rejects.toThrow(
        "Refusing to publish a missing, duplicated, or appended scene timeline",
      );

      expect(await readFile(previewPath, "utf8")).toBe("known-good-video");
      expect(upsertEpisodeVideoOutput).toHaveBeenLastCalledWith(expect.objectContaining({
        variant: "agnes_text",
        status: "failed",
        error: expect.stringContaining("duration (4.500s) does not match the expected 2.250s timeline"),
      }));
      expect(seriesState.updateEpisodeStatus).not.toHaveBeenCalled();
    } finally {
      (CONFIG as { outputDir: string }).outputDir = priorOutputDir;
      (CONFIG as { ffmpegPath: string }).ffmpegPath = priorFfmpegPath;
      (CONFIG as { ffprobePath: string }).ffprobePath = priorFfprobePath;
    }
  });
});
