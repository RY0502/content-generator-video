import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@libsql/client";
import { selectiveCleanupNeon } from "../src/state/selectiveCleanup.js";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SERIES_ID = 22;

async function main() {
  console.log(`=== Starting Reset for Series ${SERIES_ID} (Tiny Heroes Club) ===\n`);

  // 1. Clean local output directory for series 22
  console.log("1. Cleaning local output directory...");
  const localOutputDir = path.resolve("output", `series_${SERIES_ID}`);
  if (existsSync(localOutputDir)) {
    await rm(localOutputDir, { recursive: true, force: true });
    console.log(`   Removed local output directory: ${localOutputDir}`);
  } else {
    console.log(`   Local output directory does not exist: ${localOutputDir}`);
  }

  // 2. Clear Turso downstream records
  console.log("\n2. Resetting Turso DB records for Series 22...");
  await client.execute({
    sql: "DELETE FROM agnes_scene_generation_history WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM agnes_scene_generations WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM episode_video_outputs WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM youtube_upload_receipts WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM key_art WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM episode_script_pending_chunks WHERE episode_id IN (SELECT id FROM episodes WHERE series_id = ?)",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM episode_script_drafts WHERE episode_id IN (SELECT id FROM episodes WHERE series_id = ?)",
    args: [SERIES_ID],
  });
  console.log("   Cleared agnes_scene_generations, video_outputs, drafts, and receipts");

  // 3. Reset all episodes for series 22 to clean 'pending' state
  console.log("\n3. Resetting episodes to clean pending state...");
  await client.execute({
    sql: `UPDATE episodes SET
      status = 'pending',
      script_json = NULL,
      output_path = NULL,
      youtube_video_id = NULL,
      youtube_url = NULL,
      uploaded_at = NULL,
      completed_at = NULL,
      completion_local_date = NULL,
      scheduler_skipped_at = NULL,
      scheduler_skip_reason = NULL,
      audio_revision = 0,
      audio_mutation_token = NULL,
      audio_mutation_scene_number = NULL,
      audio_mutation_expires_at_ms = NULL,
      audio_status = 'pending',
      updated_at = datetime('now')
    WHERE series_id = ?`,
    args: [SERIES_ID],
  });
  console.log("   All 25 episodes reset to status='pending' with null script/output/completedAt");

  // 4. Verify Episode 1 & 2 state
  const epCheck = await client.execute({
    sql: "SELECT id, series_id, episode_number, status, title, output_path, completed_at FROM episodes WHERE series_id = ? AND episode_number IN (1, 2)",
    args: [SERIES_ID],
  });
  console.log("\n4. Verified Episodes 1 & 2 in DB:", epCheck.rows);

  // 5. Clean Neon DB agent runs/checkpoints
  console.log("\n5. Cleaning Neon DB framework runs and checkpoints...");
  try {
    await selectiveCleanupNeon({ preserveCustomState: false, preserveAgentRuns: false });
    console.log("   Neon framework checkpoints and agent runs cleaned successfully");
  } catch (err: any) {
    console.warn("   Neon cleanup warning:", err.message);
  }

  console.log(`\n🎉 Series ${SERIES_ID} (Tiny Heroes Club) successfully reset to Episode 1!`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
}).finally(() => {
  client.close();
  process.exit(0);
});
