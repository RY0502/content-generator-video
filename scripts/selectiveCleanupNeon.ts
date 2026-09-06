import "dotenv/config";
import { selectiveCleanupNeon } from "../src/state/selectiveCleanup.js";

async function main(): Promise<void> {
  try {
    console.log("Starting selective Neon cleanup...");
    await selectiveCleanupNeon({
      preserveAgentRuns: true,
      preserveCustomState: true,
    });
    console.log("✅ Selective Neon cleanup completed.");
    console.log("Preserved: agent_runs, agent_custom_state");
    console.log("Deleted: checkpoints, checkpoint_writes, agent_events, agent_todos");
  } catch (error) {
    console.error("❌ Selective Neon cleanup failed:", error);
    process.exit(1);
  }
}

main();
