import { describe, expect, it, vi } from "vitest";
import { buildSeriesStateTools } from "../tools/seriesStateTools.js";

function buildSeason() {
  return Array.from({ length: 25 }, (_unused, index) => ({
    episodeNumber: index + 1,
    title: `Episode ${index + 1}`,
    premise: `Pip solves gentle problem ${index + 1}.`,
  }));
}

describe("seriesStateTools", () => {
  it("normalizes stringified characters and environments for get_or_create_series", async () => {
    const getOrCreateSeries = vi.fn().mockResolvedValue(42);
    const tools = buildSeriesStateTools({
      getOrCreateSeries,
    } as any);

    const tool = tools.find((entry) => entry.name === "get_or_create_series");
    expect(tool).toBeDefined();

    const result = await (tool as any).call({
      conceptName: "Tiny Heroes Club",
      characters: JSON.stringify([
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ]),
      environments: JSON.stringify([
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
      ]),
      episodeFormula: "Teamwork rescue",
    });

    expect(getOrCreateSeries).toHaveBeenCalledWith(
      "Tiny Heroes Club",
      [
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ],
      [
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
      ],
      "Teamwork rescue"
    );
    expect(JSON.parse(result).seriesId).toEqual(42);
  });

  it("repairs malformed stringified environments for get_or_create_series", async () => {
    const getOrCreateSeries = vi.fn().mockResolvedValue(42);
    const tools = buildSeriesStateTools({
      getOrCreateSeries,
    } as any);

    const tool = tools.find((entry) => entry.name === "get_or_create_series");
    expect(tool).toBeDefined();

    const result = await (tool as any).call({
      conceptName: "Tiny Heroes Club",
      characters: JSON.stringify([
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ]),
      environments:
        '[{"name": "Meadow Clearing", "description": "A sunny open grass area dotted with wildflowers."}, {name: "Pond Edge", description: "A peaceful pond with lily pads and reeds."}]',
      episodeFormula: "Teamwork rescue",
    });

    expect(getOrCreateSeries).toHaveBeenCalledWith(
      "Tiny Heroes Club",
      [
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ],
      [
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
        {
          name: "Pond Edge",
          description: "A peaceful pond with lily pads and reeds.",
        },
      ],
      "Teamwork rescue"
    );
    expect(JSON.parse(result).seriesId).toEqual(42);
  });

  it("normalizes stringified episodes for bulk_insert_episode_list", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      bulkInsertEpisodesIfEmpty,
    } as any);

    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");
    expect(tool).toBeDefined();

    const episodes = buildSeason();

    const result = await (tool as any).call({
      seriesId: 12,
      episodes: JSON.stringify(episodes),
    });

    expect(bulkInsertEpisodesIfEmpty).toHaveBeenCalledWith(12, episodes);
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });

  it("normalizes preprise to premise for bulk_insert_episode_list", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      bulkInsertEpisodesIfEmpty,
    } as any);

    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");
    expect(tool).toBeDefined();

    const expectedEpisodes = buildSeason();
    expectedEpisodes[15] = {
      episodeNumber: 16,
      title: "Sunny's Dawn Chorus",
      premise: "Sunny learns that every voice matters in the choir.",
    };
    const suppliedEpisodes = expectedEpisodes.map((episode) =>
      episode.episodeNumber === 16
        ? {
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            preprise: episode.premise,
          }
        : episode,
    );

    const result = await (tool as any).call({
      seriesId: 12,
      episodes: JSON.stringify(suppliedEpisodes),
    });

    expect(bulkInsertEpisodesIfEmpty).toHaveBeenCalledWith(12, expectedEpisodes);
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });

  it.each([
    {
      name: "a short season",
      mutate: (episodes: ReturnType<typeof buildSeason>) => episodes.slice(0, 24),
    },
    {
      name: "duplicate and non-sequential numbers",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[15] = { ...episodes[15], episodeNumber: 15 };
        return episodes;
      },
    },
    {
      name: "a blank title",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[8] = { ...episodes[8], title: "   " };
        return episodes;
      },
    },
    {
      name: "a blank premise",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[8] = { ...episodes[8], premise: "   " };
        return episodes;
      },
    },
  ])("rejects $name before calling SeriesState", async ({ mutate }) => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({ bulkInsertEpisodesIfEmpty } as any);
    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");

    await expect((tool as any).call({
      seriesId: 12,
      episodes: mutate(buildSeason()),
    })).rejects.toThrow();
    expect(bulkInsertEpisodesIfEmpty).not.toHaveBeenCalled();
  });

  it("returns the discriminated ready result from get_next_episode", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: { title: "The Windy Picnic", scenes: [] },
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const tools = buildSeriesStateTools({ getNextEpisodeAvailability } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(getNextEpisodeAvailability).toHaveBeenCalledOnce();
    expect(getNextEpisodeAvailability).toHaveBeenCalledWith(12);
    expect(JSON.parse(result)).toEqual(availability);
  });

  it("preserves the exact one-episode-per-day terminal response", async () => {
    const availability = {
      kind: "daily_limit",
      episode: null,
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
      completedEpisodeNumber: 2,
      completedAt: "2026-09-04 12:30:00",
      message: "Only 1 episode per day can be generated.",
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const tools = buildSeriesStateTools({ getNextEpisodeAvailability } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(JSON.parse(result)).toEqual(availability);
    expect(JSON.parse(result).message).toBe("Only 1 episode per day can be generated.");
  });

  it.each([
    {
      kind: "no_episodes",
      message: "The series has no episode manifest yet.",
    },
    {
      kind: "series_complete",
      message: "Every episode in the series is complete.",
    },
    {
      kind: "series_missing",
      message: "Series 12 was not found.",
    },
  ])("preserves the $kind terminal result from get_next_episode", async ({ kind, message }) => {
    const availability = {
      kind,
      episode: null,
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
      message,
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const tools = buildSeriesStateTools({ getNextEpisodeAvailability } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(JSON.parse(result)).toEqual(availability);
  });

  it("parses stringified scriptJson for update_episode_status", async () => {
    const updateEpisodeStatus = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      updateEpisodeStatus,
    } as any);

    const tool = tools.find((entry) => entry.name === "update_episode_status");
    expect(tool).toBeDefined();

    const result = await (tool as any).call({
      episodeId: 7,
      status: "script",
      scriptJson: JSON.stringify({
        title: "The Ant Saves the Picnic",
        premise: "Pip rallies the club to save a picnic before the rain comes.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Pip sees the picnic blanket flutter in the breeze.",
          },
        ],
      }),
    });

    expect(updateEpisodeStatus).toHaveBeenCalledWith(7, "script", {
      scriptJson: {
        title: "The Ant Saves the Picnic",
        premise: "Pip rallies the club to save a picnic before the rain comes.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Pip sees the picnic blanket flutter in the breeze.",
          },
        ],
      },
      outputPath: undefined,
    });
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });
});
