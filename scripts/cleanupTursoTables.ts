import "dotenv/config";
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN ?? "";

if (!url) {
  console.error("Error: TURSO_DATABASE_URL environment variable is not set.");
  process.exit(1);
}

async function cleanupTursoTables(): Promise<void> {
  const client = createClient({ url, authToken });

  try {
    console.log(`Connecting to Turso database: ${url}`);
    console.log("Starting cleanup of content-generator domain tables...\n");

    // Domain tables only (order matters for foreign keys).
    const tables = [
      "youtube_upload_receipts",
      "episode_video_outputs",
      "agnes_scene_generations",
      "episode_script_drafts",
      "key_art",
      "character_sheets",
      "episodes",
      "series",
    ];

    for (const table of tables) {
      try {
        const before = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
        const countBefore = before.rows[0]?.count ?? 0;
        console.log(`Deleting ${countBefore} rows from table: ${table}`);
        const result = await client.execute(`DELETE FROM ${table}`);
        const after = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
        const remaining = after.rows[0]?.count ?? "unknown";
        if (Number(remaining) !== 0) throw new Error(`Cleanup verification failed: ${remaining} rows remain in ${table}`);
        console.log(`  ✓ Deleted ${result.rowsAffected} rows from ${table}; remaining: ${remaining}\n`);
      } catch (error) {
        const err = error as { message?: string };
        if (err.message?.includes("no such table")) {
          console.log(`  ⚠ Table ${table} does not exist (skipped)\n`);
        } else {
          console.error(`  ✗ Error deleting from ${table}:`, err.message);
          throw error;
        }
      }
    }

    // Drop deprecated table.
    try {
      console.log("Dropping deprecated table: environment_sheets");
      await client.execute("DROP TABLE IF EXISTS environment_sheets");
      console.log("  ✓ Dropped environment_sheets (if it existed)\n");
    } catch (error) {
      const err = error as { message?: string };
      console.error("  ✗ Error dropping environment_sheets:", err.message);
      throw error;
    }

    console.log("✅ Cleanup completed successfully!");
    console.log("All content-generator domain tables were verified empty in the Turso database.");
  } catch (error) {
    console.error("❌ Cleanup failed:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

cleanupTursoTables();
