import "dotenv/config";
import { selectiveCleanupTurso } from "../src/state/selectiveCleanup.js";

async function main(): Promise<void> {
  try {
    console.log("Starting selective Turso cleanup...");
    await selectiveCleanupTurso({
      keepLatestCompletedScript: true,
      clearCompletedOutputPaths: false,
    });
    console.log("✅ Selective Turso cleanup completed.");
    console.log("Preserved: durable series/episode receipts, character sheets, and unfinished Agnes state");
    console.log("Legacy cleanup: cleared older completed scripts while retaining the latest completed script per series");
  } catch (error) {
    console.error("❌ Selective Turso cleanup failed:", error);
    process.exit(1);
  }
}

main();
