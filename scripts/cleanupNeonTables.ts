import "dotenv/config";
import { cleanupNeonTables } from "../src/state/neonCleanup.js";

void cleanupNeonTables().catch((error) => {
  console.error("Neon cleanup failed:", error);
  process.exitCode = 1;
});
