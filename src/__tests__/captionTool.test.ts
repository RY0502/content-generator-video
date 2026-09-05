import { describe, expect, it } from "vitest";
import { buildCaptionTool } from "../tools/captionTool.js";

describe("captionTool", () => {
  it("normalizes scenes from a JSON string via the tool schema", () => {
    const tool = buildCaptionTool();

    const parsed = (tool as any).schema.parse({
      seriesId: 3,
      episodeNumber: 1,
      scenes: '[{"sceneNumber":1,"text":"Hello there","durationSeconds":3.5}]',
    });

    expect(parsed.scenes).toEqual([
      {
        sceneNumber: 1,
        text: "Hello there",
        durationSeconds: 3.5,
      },
    ]);
  });

  it("extracts scenes from wrapped string content via the tool schema", () => {
    const tool = buildCaptionTool();

    const parsed = (tool as any).schema.parse({
      seriesId: 3,
      episodeNumber: 1,
      scenes: 'Here are the scenes: [{"sceneNumber":1,"text":"Hello there","durationSeconds":3.5}] thanks!',
    });

    expect(parsed.scenes).toEqual([
      {
        sceneNumber: 1,
        text: "Hello there",
        durationSeconds: 3.5,
      },
    ]);
  });

  it("defaults captions to time zero with no transition gap", async () => {
    const tool = buildCaptionTool();

    const resultStr = await (tool as any).func({
      seriesId: 99,
      episodeNumber: 1,
      scenes: [
        { sceneNumber: 1, text: "[cheerful] It was a bright morning.", durationSeconds: 4.0 },
        { sceneNumber: 2, text: "Leo smiled happily.", durationSeconds: 3.0 },
      ],
    });

    const result = JSON.parse(resultStr);
    expect(result.initialOffsetSeconds).toBe(0);
    expect(result.totalDurationSeconds).toBe(4.0 + 3.0);
  });

  it("strips obsolete key-art offsets and transition gaps from public input", async () => {
    const tool = buildCaptionTool();

    const resultStr = await (tool as any).func({
      seriesId: 99,
      episodeNumber: 1,
      scenes: [
        { sceneNumber: 1, text: "[cheerful] It was a bright morning.", durationSeconds: 4.0 },
        { sceneNumber: 2, text: "Leo smiled happily.", durationSeconds: 3.0 },
      ],
      initialOffsetSeconds: 6.5,
      transitionSeconds: 0.5,
    });

    const result = JSON.parse(resultStr);
    expect(result.initialOffsetSeconds).toBe(0);
    expect(result.totalDurationSeconds).toBe(4.0 + 3.0);
  });

  it("does not expose legacy key-art audio inputs", () => {
    const tool = buildCaptionTool();

    const parsed = (tool as any).schema.parse({
      seriesId: 3,
      episodeNumber: 1,
      scenes: [{ sceneNumber: 1, text: "Hello", durationSeconds: 2 }],
      seriesKeyArtAudioPath: "/tmp/series.wav",
      episodeKeyArtAudioPath: "/tmp/episode.wav",
    });

    expect(parsed).not.toHaveProperty("initialOffsetSeconds");
    expect(parsed).not.toHaveProperty("transitionSeconds");
    expect(parsed).not.toHaveProperty("seriesKeyArtAudioPath");
    expect(parsed).not.toHaveProperty("episodeKeyArtAudioPath");
  });
});
