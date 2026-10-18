import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";
import { buildEpisodeTtsTool } from "../src/tools/ttsTool.js";

async function main() {
  const seriesId = Number(process.argv[2] || 19);
  const episodeNumber = Number(process.argv[3] || 1);

  console.log(`[RepairAudio] Checking and repairing audio for Series ${seriesId}, Episode ${episodeNumber}...`);
  const seriesState = new SeriesState();

  try {
    const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${episodeNumber} for series ${seriesId} not found.`);
    }

    const ttsTool = buildEpisodeTtsTool({ seriesState });
    const resultJson = await ttsTool.func({ seriesId, episodeNumber });
    const result = JSON.parse(resultJson);

    console.log("[RepairAudio] TTS Tool Result:", result);

    const ready = await seriesState.assertEpisodeAudioReady(episode.id);
    console.log(`[RepairAudio] Episode audio is ready! Total duration: ${ready.totalDurationSeconds.toFixed(2)}s`);
  } catch (error) {
    console.error("[RepairAudio] Failed with error:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main();
