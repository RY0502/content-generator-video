import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(flag: string): number {
  const raw = valueAfter(flag);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be followed by a positive integer.`);
  }
  return value;
}

async function main(): Promise<void> {
  const seriesId = positiveInteger("--series");
  const episodeNumber = positiveInteger("--episode");
  const undo = process.argv.includes("--undo");
  const reason = valueAfter("--reason") ?? "Operator chose to retain this assembled episode without automatic upload.";
  const state = new SeriesState();
  try {
    const episode = undo
      ? await state.unskipEpisodeFromScheduler(seriesId, episodeNumber)
      : await state.skipEpisodeFromScheduler(seriesId, episodeNumber, reason);
    const next = await state.getNextEpisodeAvailability(seriesId);
    console.log(JSON.stringify({
      status: undo ? "scheduler_skip_removed" : "scheduler_skipped",
      episode: {
        seriesId: episode.seriesId,
        episodeNumber: episode.episodeNumber,
        productionStatus: episode.status,
        outputPath: episode.outputPath,
        schedulerSkippedAt: episode.schedulerSkippedAt,
        schedulerSkipReason: episode.schedulerSkipReason,
        youtubeVideoId: episode.youtubeVideoId,
        uploadedAt: episode.uploadedAt,
        completedAt: episode.completedAt,
      },
      next: next.kind === "ready"
        ? {
            kind: next.kind,
            episodeNumber: next.episode.episodeNumber,
            productionStatus: next.episode.status,
          }
        : { kind: next.kind, message: next.message },
    }, null, 2));
  } finally {
    await state.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
