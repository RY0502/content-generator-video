import { afterEach, describe, expect, it } from "vitest";
import {
  ONE_EPISODE_PER_DAY_MESSAGE,
  SeriesState,
} from "../state/seriesState.js";

const openStates: SeriesState[] = [];

function stateClient(state: SeriesState): {
  execute(statement: string | { sql: string; args: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
} {
  return (state as unknown as { client: ReturnType<typeof stateClient> }).client;
}

function season() {
  return Array.from({ length: 25 }, (_unused, index) => ({
    episodeNumber: index + 1,
    title: `Episode ${index + 1}`,
    premise: `A gentle adventure numbered ${index + 1}.`,
  }));
}

async function createState(withEpisodes = true): Promise<{ state: SeriesState; seriesId: number }> {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  const seriesId = await state.getOrCreateSeries("Daily Gate Stories", [], [], "Gentle adventures");
  if (withEpisodes) await state.bulkInsertEpisodesIfEmpty(seriesId, season());
  return { state, seriesId };
}

async function markComplete(
  state: SeriesState,
  seriesId: number,
  episodeNumber: number,
  timestamp: string,
): Promise<void> {
  await stateClient(state).execute({
    sql: `UPDATE episodes
          SET status = 'done', youtube_video_id = ?, youtube_url = ?,
              uploaded_at = ?, completed_at = ?, completion_local_date = NULL
          WHERE series_id = ? AND episode_number = ?`,
    args: [
      `video-${episodeNumber}`,
      `https://www.youtube.com/watch?v=video-${episodeNumber}`,
      timestamp,
      timestamp,
      seriesId,
      episodeNumber,
    ],
  });
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("SeriesState one-episode-per-day selection", () => {
  it("advances past an intentionally skipped assembled episode without marking it complete", async () => {
    const { state, seriesId } = await createState();
    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'assembly', script_json = '{}', output_path = '/tmp/episode-1.mp4'
            WHERE series_id = ? AND episode_number = 1`,
      args: [seriesId],
    });

    const skipped = await state.skipEpisodeFromScheduler(
      seriesId,
      1,
      "Keep the evaluated render but do not publish it.",
    );
    expect(skipped).toMatchObject({
      episodeNumber: 1,
      status: "assembly",
      outputPath: "/tmp/episode-1.mp4",
      schedulerSkipReason: "Keep the evaluated render but do not publish it.",
      youtubeVideoId: null,
      uploadedAt: null,
      completedAt: null,
    });
    expect(skipped.schedulerSkippedAt).toBeTruthy();
    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-07T12:00:00.000Z"),
      timeZone: "UTC",
    })).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 2, status: "pending" },
    });
    await expect(state.assertEpisodeUploadAllowedToday(seriesId, 1, {
      now: new Date("2026-09-07T12:00:00.000Z"),
      timeZone: "UTC",
    })).rejects.toThrow("intentionally skipped");
    await expect(state.recordYoutubeUploadReceipt({
      seriesId,
      episodeNumber: 1,
      videoId: "must-not-upload",
      url: "https://www.youtube.com/watch?v=must-not-upload",
    })).rejects.toThrow("intentionally skipped");

    const restored = await state.unskipEpisodeFromScheduler(seriesId, 1);
    expect(restored.schedulerSkippedAt).toBeNull();
    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-07T12:00:00.000Z"),
      timeZone: "UTC",
    })).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 1, status: "assembly" },
    });
  });

  it("allows scheduler skipping only for assembled episodes with no upload evidence", async () => {
    const { state, seriesId } = await createState();
    await expect(state.skipEpisodeFromScheduler(seriesId, 1, "Skip this one."))
      .rejects.toThrow("only after assembly");

    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'assembly', output_path = '/tmp/episode-1.mp4'
            WHERE series_id = ? AND episode_number = 1`,
      args: [seriesId],
    });
    await state.recordYoutubeUploadReceipt({
      seriesId,
      episodeNumber: 1,
      videoId: "video-1",
      url: "https://www.youtube.com/watch?v=video-1",
    });
    await expect(state.skipEpisodeFromScheduler(seriesId, 1, "Skip this one."))
      .rejects.toThrow("recovery receipt");
  });

  it("uses the configured local calendar day across the UTC/IST boundary", async () => {
    const { state, seriesId } = await createState();
    // Both instants are September 5 in India, although the stored UTC date is September 4.
    await markComplete(state, seriesId, 1, "2026-09-04 18:45:00");

    const blocked = await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-04T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(blocked).toMatchObject({
      kind: "daily_limit",
      episode: null,
      localDate: "2026-09-05",
      completedEpisodeNumber: 1,
      message: ONE_EPISODE_PER_DAY_MESSAGE,
    });
    expect(await state.getNextEpisode(seriesId, {
      now: new Date("2026-09-04T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toBeNull();

    // The same UTC timestamp belongs to the previous local day in New York.
    const allowed = await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-05T12:00:00.000Z"),
      timeZone: "America/New_York",
    });
    expect(allowed).toMatchObject({ kind: "ready", episode: { episodeNumber: 2 } });
  });

  it("returns an already-started episode before applying today's gate", async () => {
    const { state, seriesId } = await createState();
    await markComplete(state, seriesId, 1, "2026-09-04T06:00:00.000Z");
    await stateClient(state).execute({
      sql: `UPDATE episodes SET status = 'script', script_json = '{}'
            WHERE series_id = ? AND episode_number = 2`,
      args: [seriesId],
    });

    const availability = await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-04T12:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(availability).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 2, status: "script" },
    });
  });

  it("finds resumable work before an earlier untouched future episode", async () => {
    const { state, seriesId } = await createState();
    await markComplete(state, seriesId, 1, "2026-09-04T06:00:00.000Z");
    await stateClient(state).execute({
      sql: `UPDATE episodes SET status = 'audio', script_json = '{}'
            WHERE series_id = ? AND episode_number = 3`,
      args: [seriesId],
    });

    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-04T12:00:00.000Z"),
      timeZone: "UTC",
    })).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 3, status: "audio" },
    });
  });

  it("does not count a local done flag without a complete YouTube identity", async () => {
    const { state, seriesId } = await createState();
    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'done', uploaded_at = '2026-09-04T06:00:00.000Z',
                youtube_video_id = 'video-1', youtube_url = NULL
            WHERE series_id = ? AND episode_number = 1`,
      args: [seriesId],
    });

    const availability = await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-04T12:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(availability).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 1 },
    });
  });

  it("distinguishes a missing manifest, a missing series, and a completed season", async () => {
    const { state, seriesId } = await createState(false);
    const options = { now: new Date("2026-09-04T12:00:00.000Z"), timeZone: "UTC" };
    expect(await state.getNextEpisodeAvailability(seriesId, options)).toMatchObject({
      kind: "no_episodes",
      episode: null,
    });
    expect(await state.getNextEpisodeAvailability(999, options)).toMatchObject({
      kind: "series_missing",
      episode: null,
    });

    await state.bulkInsertEpisodesIfEmpty(seriesId, season());
    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'done', youtube_video_id = 'video-' || episode_number,
                youtube_url = 'https://youtube.test/' || episode_number,
                uploaded_at = '2026-09-03 10:00:00', completed_at = '2026-09-03 10:00:00'`,
      args: [],
    });
    expect(await state.getNextEpisodeAvailability(seriesId, options)).toMatchObject({
      kind: "series_complete",
      episode: null,
    });
  });

  it("prevents a stale runner from uploading a second episode on the same local day", async () => {
    const { state, seriesId } = await createState();
    await markComplete(state, seriesId, 1, "2026-09-04T18:45:00.000Z");

    await expect(state.assertEpisodeUploadAllowedToday(seriesId, 2, {
      now: new Date("2026-09-04T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).rejects.toThrow(ONE_EPISODE_PER_DAY_MESSAGE);

    await expect(state.assertEpisodeUploadAllowedToday(seriesId, 2, {
      now: new Date("2026-09-05T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).resolves.toBeUndefined();
  });

  it("counts another episode's durable YouTube outbox before local finalization", async () => {
    const { state, seriesId } = await createState();
    await state.recordYoutubeUploadReceipt({
      seriesId,
      episodeNumber: 1,
      videoId: "outbox-video-1",
      url: "https://www.youtube.com/watch?v=outbox-video-1",
    });
    await stateClient(state).execute({
      sql: `UPDATE youtube_upload_receipts SET created_at = '2026-09-04 18:45:00'
            WHERE series_id = ? AND episode_number = 1`,
      args: [seriesId],
    });

    await expect(state.assertEpisodeUploadAllowedToday(seriesId, 2, {
      now: new Date("2026-09-04T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).rejects.toThrow(ONE_EPISODE_PER_DAY_MESSAGE);
    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-04T19:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toMatchObject({
      kind: "ready",
      episode: { episodeNumber: 1 },
    });
  });

  it("fails closed when persisted completion time is in the future", async () => {
    const { state, seriesId } = await createState();
    await markComplete(state, seriesId, 1, "2026-09-06T00:00:00.000Z");
    const options = { now: new Date("2026-09-05T12:00:00.000Z"), timeZone: "UTC" };

    expect(await state.getNextEpisodeAvailability(seriesId, options)).toMatchObject({
      kind: "daily_limit",
      message: ONE_EPISODE_PER_DAY_MESSAGE,
    });
    await expect(
      state.assertEpisodeUploadAllowedToday(seriesId, 2, options),
    ).rejects.toThrow(ONE_EPISODE_PER_DAY_MESSAGE);
  });

  it("fails closed on a malformed completion even when another timestamp sorts first", async () => {
    const { state, seriesId } = await createState();
    await markComplete(state, seriesId, 1, "2026-09-03T12:00:00.000Z");
    await markComplete(state, seriesId, 2, "not-a-timestamp");

    await expect(state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-05T12:00:00.000Z"),
      timeZone: "UTC",
    })).rejects.toThrow("Episode completion timestamp is not a valid UTC/ISO timestamp");
  });
});
