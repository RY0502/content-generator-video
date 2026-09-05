import { afterEach, describe, expect, it } from "vitest";
import { SeriesState } from "../state/seriesState.js";

const openStates: SeriesState[] = [];

function createBlankState(): SeriesState {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  return state;
}

function buildSeason() {
  return Array.from({ length: 25 }, (_unused, index) => ({
    episodeNumber: index + 1,
    title: `Episode ${index + 1}`,
    premise: `Pip and friends solve gentle problem ${index + 1}.`,
  }));
}

function stateClient(state: SeriesState): {
  execute(
    statement: string | { sql: string; args: unknown[] }
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
} {
  return (state as unknown as { client: ReturnType<typeof stateClient> }).client;
}

async function domainTableNames(state: SeriesState): Promise<string[]> {
  const result = await stateClient(state).execute(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  );
  return result.rows.map((row) => String(row.name));
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("SeriesState blank database bootstrap", () => {
  it("automatically creates the complete schema before the first core operation", async () => {
    const state = createBlankState();

    expect(await domainTableNames(state)).toEqual([]);

    const seriesId = await state.getOrCreateSeries(
      "Blank Database Stories",
      [{ name: "Pip", description: "A curious red ant." }],
      [{ name: "Meadow", description: "A sunny wildflower meadow." }],
      "Friends solve one gentle problem together."
    );

    expect(await domainTableNames(state)).toEqual([
      "agnes_account_rate_state",
      "agnes_scene_generations",
      "character_sheets",
      "episode_video_outputs",
      "episodes",
      "key_art",
      "series",
      "youtube_upload_receipts",
    ]);
    expect(await state.getSeriesCharacters(seriesId)).toEqual([
      { name: "Pip", description: "A curious red ant." },
    ]);
    expect(await state.getSeriesEnvironments(seriesId)).toEqual([
      { name: "Meadow", description: "A sunny wildflower meadow." },
    ]);

    const season = buildSeason();
    season[0] = {
      episodeNumber: 1,
      title: "The Windy Picnic",
      premise: "Pip and friends save a picnic from the wind.",
    };
    await state.bulkInsertEpisodesIfEmpty(seriesId, season);
    const episode = await state.getNextEpisode(seriesId);
    expect(episode).toMatchObject({
      seriesId,
      episodeNumber: 1,
      title: "The Windy Picnic",
      status: "pending",
    });

    await state.upsertCharacterSheet(
      seriesId,
      "Pip",
      "A curious red ant.",
      { portrait: { path: "/tmp/pip.png" } },
      "tiny red ant, round glasses"
    );
    expect(await state.getCharacterSheet(seriesId, "Pip")).toMatchObject({
      seriesId,
      characterName: "Pip",
      generationPrompt: "tiny red ant, round glasses",
    });

    // The legacy table remains bootstrap-compatible so upload cleanup can
    // remove old rows, but a new production run creates no key-art record.
    expect(await state.getKeyArt(seriesId, "episode", 1)).toBeNull();

    const sceneGeneration = await state.upsertAgnesSceneGeneration({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "completed",
      prompt: "Pip steadies a picnic basket in a breezy meadow.",
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      normalizedOutputPath: "/tmp/scene_001.mp4",
    });
    expect(sceneGeneration).toMatchObject({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "completed",
    });

    const videoOutput = await state.upsertEpisodeVideoOutput({
      seriesId,
      episodeNumber: 1,
      variant: "agnes_text",
      outputPath: "/tmp/episode_1_agnes_text.mp4",
      durationSeconds: 6,
    });
    expect(videoOutput).toMatchObject({
      seriesId,
      episodeNumber: 1,
      variant: "agnes_text",
      status: "completed",
    });
  });

  it("is idempotent and safely serializes concurrent initialization and first-use calls", async () => {
    const state = createBlankState();

    const [, , firstSeriesId, secondSeriesId] = await Promise.all([
      state.initialize(),
      state.initialize(),
      state.getOrCreateSeries("Concurrent A", [], [], "Formula A"),
      state.getOrCreateSeries("Concurrent B", [], [], "Formula B"),
    ]);

    expect(firstSeriesId).not.toBe(secondSeriesId);
    expect(await domainTableNames(state)).toEqual([
      "agnes_account_rate_state",
      "agnes_scene_generations",
      "character_sheets",
      "episode_video_outputs",
      "episodes",
      "key_art",
      "series",
      "youtube_upload_receipts",
    ]);

    await state.initialize();
    const rows = await stateClient(state).execute(
      "SELECT concept_name FROM series ORDER BY concept_name"
    );
    expect(rows.rows.map((row) => String(row.concept_name))).toEqual([
      "Concurrent A",
      "Concurrent B",
    ]);
  });

  it("returns one series id when concurrent callers create the same concept", async () => {
    const state = createBlankState();

    const ids = await Promise.all([
      state.getOrCreateSeries("Shared Concept", [], [], "Formula"),
      state.getOrCreateSeries("Shared Concept", [], [], "Formula"),
    ]);

    expect(ids[0]).toBe(ids[1]);
    const rows = await stateClient(state).execute(
      "SELECT id FROM series WHERE concept_name = 'Shared Concept'"
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("canonicalizes new titles and resolves a trim-equivalent series without duplicating it", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("  Trimmed Stories  ", [], [], "Formula");
    expect(await state.getOrCreateSeries("Trimmed Stories", [], [], "Formula"))
      .toBe(seriesId);

    const season = buildSeason();
    season[0] = { ...season[0], title: "  The Windy Picnic  " };
    await state.bulkInsertEpisodesIfEmpty(seriesId, season);
    expect((await state.getEpisodeByNumber(seriesId, 1))?.title).toBe("The Windy Picnic");

    const rows = await stateClient(state).execute(
      "SELECT concept_name FROM series WHERE trim(concept_name) = 'Trimmed Stories'",
    );
    expect(rows.rows).toEqual([expect.objectContaining({ concept_name: "Trimmed Stories" })]);
  });

  it("reuses one legacy whitespace-padded series instead of creating a canonical duplicate", async () => {
    const state = createBlankState();
    await state.initialize();
    await stateClient(state).execute({
      sql: `INSERT INTO series (concept_name, characters_json, environments_json, episode_formula)
            VALUES (?, '[]', '[]', 'Legacy formula')`,
      args: ["  Legacy Stories  "],
    });
    const existing = await stateClient(state).execute(
      "SELECT id FROM series WHERE concept_name = '  Legacy Stories  '",
    );

    expect(await state.getOrCreateSeries("Legacy Stories", [], [], "New formula"))
      .toBe(Number(existing.rows[0]?.id));
    const matches = await stateClient(state).execute(
      "SELECT id FROM series WHERE trim(concept_name) = 'Legacy Stories'",
    );
    expect(matches.rows).toHaveLength(1);
  });

  it("rejects oversized series and episode titles before persisting them", async () => {
    const state = createBlankState();
    await expect(state.getOrCreateSeries("word ".repeat(13), [], [], "Formula"))
      .rejects.toThrow("at most 12");
    const count = await stateClient(state).execute("SELECT COUNT(*) AS count FROM series");
    expect(Number(count.rows[0]?.count)).toBe(0);

    const seriesId = await state.getOrCreateSeries("Valid Stories", [], [], "Formula");
    const season = buildSeason();
    season[4] = { ...season[4], title: "x".repeat(101) };
    await expect(state.bulkInsertEpisodesIfEmpty(seriesId, season)).rejects.toThrow("at most 100");
    const episodes = await stateClient(state).execute({
      sql: "SELECT COUNT(*) AS count FROM episodes WHERE series_id = ?",
      args: [seriesId],
    });
    expect(Number(episodes.rows[0]?.count)).toBe(0);
  });

  it("inserts all 25 episodes atomically and verifies a complete season on rerun", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("Complete Season", [], [], "Formula");
    const season = buildSeason();

    await state.bulkInsertEpisodesIfEmpty(seriesId, season);
    await state.bulkInsertEpisodesIfEmpty(seriesId, season);

    const rows = await stateClient(state).execute({
      sql: `SELECT episode_number, title, premise
            FROM episodes
            WHERE series_id = ?
            ORDER BY episode_number`,
      args: [seriesId],
    });
    expect(rows.rows).toHaveLength(25);
    expect(rows.rows.map((row) => Number(row.episode_number))).toEqual(
      Array.from({ length: 25 }, (_unused, index) => index + 1),
    );
    expect(rows.rows.every((row) => String(row.title).trim() && String(row.premise).trim())).toBe(true);
  });

  it("rejects invalid input without writing any partial season", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("Invalid Season", [], [], "Formula");

    await expect(
      state.bulkInsertEpisodesIfEmpty(seriesId, buildSeason().slice(0, 24)),
    ).rejects.toThrow("must contain exactly 25 episodes");

    const rows = await stateClient(state).execute({
      sql: "SELECT COUNT(*) AS count FROM episodes WHERE series_id = ?",
      args: [seriesId],
    });
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it("rejects an incomplete persisted season instead of treating it as initialized", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("Interrupted Season", [], [], "Formula");
    await stateClient(state).execute({
      sql: `INSERT INTO episodes (series_id, episode_number, title, premise)
            VALUES (?, 1, 'Only One', 'An old interrupted insert.')`,
      args: [seriesId],
    });

    await expect(
      state.bulkInsertEpisodesIfEmpty(seriesId, buildSeason()),
    ).rejects.toThrow(`Stored season for series ${seriesId} must contain exactly 25 episodes`);
  });

  it("rejects 25 persisted rows unless their numbers are exactly 1 through 25", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("Misnumbered Season", [], [], "Formula");
    for (let episodeNumber = 2; episodeNumber <= 26; episodeNumber += 1) {
      await stateClient(state).execute({
        sql: `INSERT INTO episodes (series_id, episode_number, title, premise)
              VALUES (?, ?, ?, ?)`,
        args: [seriesId, episodeNumber, `Episode ${episodeNumber}`, `Premise ${episodeNumber}`],
      });
    }

    await expect(
      state.bulkInsertEpisodesIfEmpty(seriesId, buildSeason()),
    ).rejects.toThrow("must use unique sequential episode numbers 1-25");
  });

  it("rolls back every episode when one statement in the season insert fails", async () => {
    const state = createBlankState();
    const seriesId = await state.getOrCreateSeries("Atomic Season", [], [], "Formula");
    await stateClient(state).execute(`
      CREATE TRIGGER reject_episode_thirteen
      BEFORE INSERT ON episodes
      WHEN NEW.episode_number = 13
      BEGIN
        SELECT RAISE(ABORT, 'forced season insert failure');
      END
    `);

    await expect(
      state.bulkInsertEpisodesIfEmpty(seriesId, buildSeason()),
    ).rejects.toThrow("forced season insert failure");

    const rows = await stateClient(state).execute({
      sql: "SELECT COUNT(*) AS count FROM episodes WHERE series_id = ?",
      args: [seriesId],
    });
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it("adds supported legacy columns and requeues done episodes without an upload receipt", async () => {
    const state = createBlankState();
    const client = stateClient(state);
    await client.execute(`
      CREATE TABLE series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concept_name TEXT NOT NULL UNIQUE,
        characters_json TEXT NOT NULL DEFAULT '[]'
      )
    `);
    await client.execute(`
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        series_id INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE (series_id, episode_number)
      )
    `);
    await client.execute(
      "INSERT INTO series (id, concept_name) VALUES (1, 'Legacy Stories')",
    );
    await client.execute(
      "INSERT INTO episodes (series_id, episode_number, status) VALUES (1, 1, 'done')",
    );

    const next = await state.getNextEpisode(1);
    expect(next).toMatchObject({
      episodeNumber: 1,
      status: "pending",
      title: "",
      premise: "",
      uploadedAt: null,
    });

    const seriesColumns = await client.execute("PRAGMA table_info('series')");
    expect(seriesColumns.rows.map((row) => String(row.name))).toEqual(
      expect.arrayContaining(["environments_json", "episode_formula", "agnes_seed"]),
    );
    const episodeColumns = await client.execute("PRAGMA table_info('episodes')");
    expect(episodeColumns.rows.map((row) => String(row.name))).toEqual(
      expect.arrayContaining([
        "title",
        "premise",
        "script_json",
        "output_path",
        "youtube_video_id",
        "youtube_url",
        "uploaded_at",
        "completed_at",
        "completion_local_date",
        "updated_at",
      ]),
    );
  });
});
