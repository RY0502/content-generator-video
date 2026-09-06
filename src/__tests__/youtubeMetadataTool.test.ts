import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const harness = vi.hoisted(() => ({
  outputDir: "",
  chatText: vi.fn(),
}));

vi.mock("../config.js", () => ({
  CONFIG: {
    get outputDir() {
      return harness.outputDir;
    },
  },
}));

vi.mock("../providers/aiClient.js", () => ({
  chatText: (...args: unknown[]) => harness.chatText(...args),
}));

import { SeriesState } from "../state/seriesState.js";
import {
  buildYoutubeEpisodeMetadataTool,
  buildYoutubeSeriesMetadataTool,
} from "../tools/youtubeMetadataTool.js";

let state: SeriesState;
let seriesId: number;

function buildSeason() {
  return Array.from({ length: 25 }, (_unused, index) => ({
    episodeNumber: index + 1,
    title: `Stored Episode ${index + 1}`,
    premise: `A gentle learning adventure numbered ${index + 1}.`,
  }));
}

function stateClient(seriesState: SeriesState): {
  execute(statement: { sql: string; args: unknown[] }): Promise<unknown>;
} {
  return (seriesState as unknown as {
    client: { execute(statement: { sql: string; args: unknown[] }): Promise<unknown> };
  }).client;
}

beforeEach(async () => {
  harness.chatText.mockReset();
  harness.outputDir = await mkdtemp(path.join(tmpdir(), "youtube-metadata-tool-"));
  state = new SeriesState("file::memory:", "");
  seriesId = await state.getOrCreateSeries(
    "Tiny Trailblazers",
    [
      { name: "Pip", description: "A curious red ant." },
      { name: "Mia", description: "A patient blue butterfly." },
    ],
    [{ name: "Meadow", description: "A sunny wildflower meadow." }],
    "Friends solve one gentle nature problem together.",
  );
  await state.bulkInsertEpisodesIfEmpty(seriesId, buildSeason());
});

afterEach(async () => {
  await state.close();
  await rm(harness.outputDir, { recursive: true, force: true });
});

describe("youtubeMetadataTool", () => {
  it("generates episode metadata from the current SeriesState schema", async () => {
    await stateClient(state).execute({
      sql: "UPDATE episodes SET script_json = ? WHERE series_id = ? AND episode_number = ?",
      args: [
        JSON.stringify({
          title: "The Breezy Picnic",
          scenes: [
            {
              sceneNumber: 1,
              characterNames: ["Pip", "Mia"],
              narrationText: "Pip and Mia carried their picnic basket into the sunny meadow.",
            },
            {
              sceneNumber: 2,
              characterNames: ["Pip"],
              narrationText: "A playful breeze lifted the napkins into the air.",
            },
          ],
        }),
        seriesId,
        3,
      ],
    });
    harness.chatText.mockResolvedValue(
      "```json\n" + JSON.stringify({
        title: "Tiny Trailblazers #3: The Breezy Picnic",
        description: "A gentle meadow adventure.",
        tags: ["friendship"],
        keywords: ["preschool nature story"],
      }) + "\n```",
    );

    const tool = buildYoutubeEpisodeMetadataTool(state);
    const result = JSON.parse(await (tool as any).call({ seriesId, episodeNumber: 3 }));

    expect(harness.chatText).toHaveBeenCalledOnce();
    const request = harness.chatText.mock.calls[0]![0] as { userText: string };
    expect(request.userText).toContain("Series: Tiny Trailblazers");
    expect(request.userText).toContain(
      "Series Description: Friends solve one gentle nature problem together.",
    );
    expect(request.userText).toContain("Episode Title: The Breezy Picnic");
    expect(request.userText).toContain("Characters: Pip, Mia");
    expect(request.userText).toContain("Number of Scenes: 2");
    expect(result).toMatchObject({
      status: "generated",
      metadata: {
        tags: ["kids stories", "educational", "friendship"],
      },
    });

    const stored = JSON.parse(await readFile(result.path, "utf8"));
    expect(stored).toMatchObject({
      seriesId,
      episodeNumber: 3,
      seriesName: "Tiny Trailblazers",
      episodeTitle: "The Breezy Picnic",
    });
  });

  it("generates series metadata from ordered episodes and current character JSON", async () => {
    await stateClient(state).execute({
      sql: "UPDATE episodes SET script_json = ? WHERE series_id = ? AND episode_number = ?",
      args: [JSON.stringify({ title: "A Scripted First Adventure" }), seriesId, 1],
    });
    harness.chatText.mockResolvedValue(JSON.stringify({
      playlistTitle: "Tiny Trailblazers - Complete Series",
      playlistDescription: "Twenty-five gentle nature adventures for preschoolers.",
      seriesTags: ["nature for kids"],
      seriesKeywords: ["preschool nature stories"],
    }));

    const tool = buildYoutubeSeriesMetadataTool(state);
    const result = JSON.parse(await (tool as any).call({ seriesId }));

    expect(harness.chatText).toHaveBeenCalledOnce();
    const request = harness.chatText.mock.calls[0]![0] as { userText: string };
    expect(request.userText).toContain("Series Name: Tiny Trailblazers");
    expect(request.userText).toContain("Number of Episodes: 25");
    expect(request.userText).toContain("Main Characters: Pip, Mia");
    expect(request.userText).toContain("1. A Scripted First Adventure");
    expect(request.userText).toContain("2. Stored Episode 2");
    expect(result.status).toBe("generated");
    expect(result.metadata.seriesTags).toEqual(expect.arrayContaining([
      "kids stories",
      "educational",
      "Children stories",
      "stories for kids",
      "stories for children",
      "nature for kids",
    ]));

    const stored = JSON.parse(await readFile(result.path, "utf8"));
    expect(stored).toMatchObject({
      seriesId,
      seriesName: "Tiny Trailblazers",
      episodeCount: 25,
    });
  });
});
