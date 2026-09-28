import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { SeriesState } from "../state/seriesState.js";
import { CONFIG } from "../config.js";

function createMemoryClient() {
  return createClient({ url: ":memory:" });
}

describe("Offline Episode Completion (YouTube upload disabled)", () => {
  const openStates: SeriesState[] = [];

  afterEach(async () => {
    await Promise.all(openStates.splice(0).map((state) => state.close()));
  });

  async function createFixture() {
    const state = new SeriesState("file::memory:?cache=shared", "test-token");
    openStates.push(state);
    await state.initialize();

    const seriesId = await state.getOrCreateSeries("Test Series", [], [], "A gentle adventure series.");
    const season = Array.from({ length: 25 }, (_, index) => ({
      episodeNumber: index + 1,
      title: `Episode ${index + 1}`,
      premise: `Adventure ${index + 1}.`,
    }));
    await state.bulkInsertEpisodesIfEmpty(seriesId, season);

    return { state, seriesId };
  }

  it("completes episode in DB without upload and advances to the next episode", async () => {
    const { state, seriesId } = await createFixture();

    // Mark episode 1 as completed without upload
    const completedEp1 = await state.completeEpisodeWithoutUpload({
      seriesId,
      episodeNumber: 1,
      outputPath: "/disk/output/series_test/episode_1/video.mp4",
    });

    expect(completedEp1.status).toBe("done");
    expect(completedEp1.outputPath).toBe("/disk/output/series_test/episode_1/video.mp4");
    expect(completedEp1.completedAt).toBeTruthy();
    expect(completedEp1.uploadedAt).toBeNull();
    expect(completedEp1.youtubeVideoId).toBeNull();

    // With YouTube upload disabled, getNextEpisodeAvailability should advance to Episode 2
    const originalSetting = CONFIG.youtubeUploadEnabled;
    try {
      (CONFIG as any).youtubeUploadEnabled = false;

      const availability = await state.getNextEpisodeAvailability(seriesId);
      expect(availability.kind).toBe("ready");
      expect(availability.episode?.episodeNumber).toBe(2);
    } finally {
      (CONFIG as any).youtubeUploadEnabled = originalSetting;
    }
  });

  it("updates episode status to done when youtubeUploadEnabled is false", async () => {
    const { state, seriesId } = await createFixture();

    const originalSetting = CONFIG.youtubeUploadEnabled;
    try {
      (CONFIG as any).youtubeUploadEnabled = false;

      const ep1 = await state.getEpisodeByNumber(seriesId, 1);
      expect(ep1).toBeTruthy();

      await state.updateEpisodeStatus(ep1!.id, "done", {
        outputPath: "/disk/output/episode_1.mp4",
      });

      const updated = await state.getEpisodeByNumber(seriesId, 1);
      expect(updated?.status).toBe("done");
      expect(updated?.outputPath).toBe("/disk/output/episode_1.mp4");
      expect(updated?.completedAt).toBeTruthy();
      expect(updated?.uploadedAt).toBeNull();
    } finally {
      (CONFIG as any).youtubeUploadEnabled = originalSetting;
    }
  });
});
