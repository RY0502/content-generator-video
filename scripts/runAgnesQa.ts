import dotenv from "dotenv";
dotenv.config();
import { SeriesState } from "../src/state/seriesState.js";
import { buildAgnesVideoQaTool } from "../src/tools/agnesVideoQaTool.js";

async function main(): Promise<void> {
  const seriesId = parseInt(process.argv[2] ?? "19", 10);
  const episodeNumber = parseInt(process.argv[3] ?? "1", 10);

  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error(`Invalid seriesId: ${process.argv[2]}`);
  }
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error(`Invalid episodeNumber: ${process.argv[3]}`);
  }

  console.log(`[AgnesVideoQA] Starting static QA for Series ${seriesId} Episode ${episodeNumber}...`);
  const seriesState = new SeriesState();
  await seriesState.initialize();

  try {
    const qaTool = buildAgnesVideoQaTool(seriesState);
    const resultJson = await (qaTool as any).call({ seriesId, episodeNumber });
    const result = typeof resultJson === "string" ? JSON.parse(resultJson) : resultJson;
    console.log("[AgnesVideoQA] Result:", JSON.stringify(result, null, 2));
  } finally {
    await seriesState.close();
  }
}

main().catch((error) => {
  console.error("[AgnesVideoQA] Error:", error);
  process.exitCode = 1;
});
