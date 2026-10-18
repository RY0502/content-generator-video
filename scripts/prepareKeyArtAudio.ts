import dotenv from "dotenv";
dotenv.config();
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";
import { ensureAgnesKeyArtAudioAssets } from "../src/services/agnesKeyArtService.js";

async function main() {
  const seriesId = Number(process.argv[2] ?? 19);
  const episodeNumber = Number(process.argv[3] ?? 1);

  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error(`Invalid seriesId: ${process.argv[2]}`);
  }
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error(`Invalid episodeNumber: ${process.argv[3]}`);
  }

  const seriesState = new SeriesState();
  await seriesState.initialize();

  const seriesInfo = await seriesState.getSeriesInfo(seriesId);
  if (!seriesInfo) throw new Error(`Series ${seriesId} not found`);

  const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
  if (!episode) throw new Error(`Series ${seriesId} Episode ${episodeNumber} not found`);

  console.log(`Generating key art audio for Series ${seriesId} Episode ${episodeNumber}...`);
  console.log("Series:", seriesInfo.conceptName);
  console.log("Episode:", episode.title);

  // Note: audioMutationState is omitted so this script can restore/synthesize
  // missing key-art audio directly to disk even if submission claims exist in Turso DB.
  const [seriesAudio, episodeAudio] = await ensureAgnesKeyArtAudioAssets({
    seriesId,
    episodeNumber,
    seriesTitle: seriesInfo.conceptName,
    episodeTitle: episode.title,
    options: {
      outputDir: CONFIG.outputDir,
      allowMutation: true,
    },
  });

  console.log("✅ Series key art audio generated:", seriesAudio.audioPath, `${seriesAudio.durationSeconds}s`);
  console.log("✅ Episode key art audio generated:", episodeAudio.audioPath, `${episodeAudio.durationSeconds}s`);

  await seriesState.assertEpisodeKeyArtAudioReady(seriesId, episodeNumber);
  console.log("✅ assertEpisodeKeyArtAudioReady verified successfully!");

  await seriesState.close();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
