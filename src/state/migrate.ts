import { SeriesState } from "./seriesState.js";

/**
 * Idempotently creates every kids-video-agent domain table in Turso (libSQL),
 * including Agnes receipts and final-output records. Run via `npm run db:setup`.
 */
async function main(): Promise<void> {
  const state = new SeriesState();

  try {
    await state.initialize();
    console.log("✅ kids-video-agent Turso schema created/verified.");
  } finally {
    await state.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
