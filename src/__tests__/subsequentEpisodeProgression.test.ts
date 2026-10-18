import { describe, expect, it, afterEach } from "vitest";
import { SeriesState } from "../state/seriesState.js";
import { CONFIG } from "../config.js";
import { buildSeriesStateTools } from "../tools/seriesStateTools.js";

describe("Subsequent Episode Progression (YouTube upload disabled)", () => {
  const openStates: SeriesState[] = [];

  afterEach(async () => {
    await Promise.all(openStates.splice(0).map((state) => state.close()));
  });

  async function createFixture() {
    const state = new SeriesState("file::memory:?cache=shared", "test-token");
    openStates.push(state);
    await state.initialize();

    const seriesId = await state.getOrCreateSeries("Everyday Adventures", [], [], "Adventure formula.");
    const season = Array.from({ length: 25 }, (_, index) => ({
      episodeNumber: index + 1,
      title: `Episode ${index + 1}`,
      premise: `Adventure in place ${index + 1}.`,
    }));
    await state.bulkInsertEpisodesIfEmpty(seriesId, season);

    return { state, seriesId };
  }

  it("advances from Episode 1 to Episode 2 on subsequent run and cannot revert completed episodes", async () => {
    const { state, seriesId } = await createFixture();
    const originalSetting = CONFIG.youtubeUploadEnabled;

    try {
      (CONFIG as any).youtubeUploadEnabled = false;

      // 1. Initial run: Episode 1 is available
      const avail1 = await state.getNextEpisodeAvailability(seriesId);
      expect(avail1.kind).toBe("ready");
      expect(avail1.episode?.episodeNumber).toBe(1);

      // 2. Episode 1 is assembled and completed offline
      const completedEp1 = await state.completeEpisodeWithoutUpload({
        seriesId,
        episodeNumber: 1,
        outputPath: "/disk/output/series_1/episode_1/video.mp4",
      });
      expect(completedEp1.status).toBe("done");
      expect(completedEp1.outputPath).toBe("/disk/output/series_1/episode_1/video.mp4");

      // 3. Verify updateEpisodeStatus cannot downgrade a completed episode back to 'assembly'
      await state.updateEpisodeStatus(completedEp1.id, "assembly", {
        outputPath: "/disk/output/series_1/episode_1/video.mp4",
      });
      const checkEp1 = await state.getEpisodeByNumber(seriesId, 1);
      expect(checkEp1?.status).toBe("done");

      // 4. Subsequent run: getNextEpisodeAvailability advances to Episode 2
      const avail2 = await state.getNextEpisodeAvailability(seriesId);
      expect(avail2.kind).toBe("ready");
      expect(avail2.episode?.episodeNumber).toBe(2);
      expect(avail2.episode?.status).toBe("pending");

      // 5. get_next_episode tool provides correct resumeAction for Episode 2
      const tools = buildSeriesStateTools(state, { youtubeUploadEnabled: false });
      const getNextTool = tools.find((t) => t.name === "get_next_episode")!;
      const toolResultJson = JSON.parse(await getNextTool.invoke({ seriesId }));

      expect(toolResultJson.kind).toBe("ready");
      expect(toolResultJson.episode.episodeNumber).toBe(2);
      expect(toolResultJson.resumeAction).toBe("script_and_audio");
      expect(toolResultJson.scriptValidation.status).toBe("not_started");

      // 6. Complete Episode 2 offline as well
      await state.completeEpisodeWithoutUpload({
        seriesId,
        episodeNumber: 2,
        outputPath: "/disk/output/series_1/episode_2/video.mp4",
      });

      // 7. Third run: advances to Episode 3
      const avail3 = await state.getNextEpisodeAvailability(seriesId);
      expect(avail3.kind).toBe("ready");
      expect(avail3.episode?.episodeNumber).toBe(3);
      expect(avail3.episode?.status).toBe("pending");
    } finally {
      (CONFIG as any).youtubeUploadEnabled = originalSetting;
    }
  });
});
