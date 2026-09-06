import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const innerInvoke = vi.fn();
  return {
    innerInvoke,
    buildVideoAssemblyTool: vi.fn(() => ({ invoke: innerInvoke })),
  };
});
const { innerInvoke } = mocks;

vi.mock("../tools/videoAssemblyTool.js", () => ({
  buildVideoAssemblyTool: mocks.buildVideoAssemblyTool,
}));

import { CONFIG } from "../config.js";
import { buildEpisodeAssemblyTool } from "../tools/episodeAssemblyTool.js";

describe("compact episode assembly facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    innerInvoke.mockResolvedValue(JSON.stringify({ status: "completed" }));
  });

  it("derives the ordered media manifest from durable state", async () => {
    const state = {
      getSeriesInfo: vi.fn().mockResolvedValue({ conceptName: "Pocket Stars" }),
      getEpisodeByNumber: vi.fn().mockResolvedValue({ id: 71 }),
      listEpisodeVideoOutputs: vi.fn().mockResolvedValue([]),
      getEpisodeNarrationAudioManifest: vi.fn().mockResolvedValue({
        totalDurationSeconds: 301,
        scenes: [
          { sceneNumber: 1, narrationText: "First.", durationSeconds: 5.2 },
          { sceneNumber: 2, narrationText: "Second.", durationSeconds: 6.1 },
        ],
      }),
    };
    const tool = buildEpisodeAssemblyTool(state as any, { includeKeyArt: true });

    const result = await (tool as any).call({
      seriesId: 4,
      episodeNumber: 2,
      burnSubtitles: true,
    });

    expect(JSON.parse(result)).toEqual({ status: "completed" });
    expect(innerInvoke).toHaveBeenCalledOnce();
    const input = innerInvoke.mock.calls[0]![0];
    const episodeDir = path.resolve(CONFIG.outputDir, "series_4", "episode_2");
    expect(input).toEqual({
      seriesId: 4,
      seriesTitle: "Pocket Stars",
      episodeNumber: 2,
      scenes: [
        {
          sceneNumber: 1,
          narrationAudioPath: path.join(episodeDir, "audio", "scene_001_narrator.wav"),
        },
        {
          sceneNumber: 2,
          narrationAudioPath: path.join(episodeDir, "audio", "scene_002_narrator.wav"),
        },
      ],
      musicPath: null,
      captionsSrtPath: path.join(episodeDir, "captions.srt"),
      burnSubtitles: true,
    });
  });

  it("reuses a validated completed assembly after a crash before the coarse stage update", async () => {
    const state = {
      getSeriesInfo: vi.fn().mockResolvedValue({ conceptName: "Pocket Stars" }),
      getEpisodeByNumber: vi.fn().mockResolvedValue({ id: 71, status: "audio" }),
      listEpisodeVideoOutputs: vi.fn().mockResolvedValue([{
        variant: "agnes_text",
        status: "completed",
        outputPath: "/tmp/already-assembled.mp4",
      }]),
      assertEpisodeReadyForDone: vi.fn().mockResolvedValue({
        outputPath: "/tmp/already-assembled.mp4",
        durationSeconds: 318.4,
      }),
      getEpisodeNarrationAudioManifest: vi.fn(),
    };
    const tool = buildEpisodeAssemblyTool(state as any, { includeKeyArt: true });

    const result = JSON.parse(await (tool as any).call({
      seriesId: 4,
      episodeNumber: 2,
    }));

    expect(result).toEqual({
      status: "already_completed",
      reused: true,
      path: "/tmp/already-assembled.mp4",
      variant: "agnes_text",
      durationSeconds: 318.4,
    });
    expect(state.assertEpisodeReadyForDone).toHaveBeenCalledWith(71);
    expect(state.getEpisodeNarrationAudioManifest).not.toHaveBeenCalled();
    expect(innerInvoke).not.toHaveBeenCalled();
  });

  it("rejects unknown series or episodes before assembly", async () => {
    const missingSeries = buildEpisodeAssemblyTool({
      getSeriesInfo: vi.fn().mockResolvedValue(null),
      getEpisodeByNumber: vi.fn().mockResolvedValue({ id: 1 }),
      listEpisodeVideoOutputs: vi.fn().mockResolvedValue([]),
    } as any);
    await expect((missingSeries as any).call({ seriesId: 9, episodeNumber: 1 }))
      .rejects.toThrow("Series 9 was not found");

    const missingEpisode = buildEpisodeAssemblyTool({
      getSeriesInfo: vi.fn().mockResolvedValue({ conceptName: "Pocket Stars" }),
      getEpisodeByNumber: vi.fn().mockResolvedValue(null),
      listEpisodeVideoOutputs: vi.fn().mockResolvedValue([]),
    } as any);
    await expect((missingEpisode as any).call({ seriesId: 9, episodeNumber: 1 }))
      .rejects.toThrow("Episode 1 was not found");
    expect(innerInvoke).not.toHaveBeenCalled();
  });
});
