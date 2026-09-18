import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

async function main() {
  const seriesState = new SeriesState();
  const client = (seriesState as any).client;

  try {
    console.log("=== Checking Series 15 Episode 1 (id 176) ===");
    const epRow = await client.execute({
      sql: "SELECT id, series_id, episode_number, title, status FROM episodes WHERE id = 176",
      args: [],
    });

    if (epRow.rows.length === 0) {
      console.log("Episode 176 not found!");
      return;
    }
    console.log("Current episode state:", epRow.rows[0]);

    const sRow = await client.execute({
      sql: "SELECT * FROM series WHERE id = 15",
      args: [],
    });
    console.log("Series 15:", sRow.rows[0]);

    console.log("=== Resetting Episode 1 in Turso DB ===");
    await client.execute({
      sql: `UPDATE episodes SET
        status = 'pending',
        script_json = NULL,
        output_path = NULL,
        audio_revision = 0,
        audio_mutation_token = NULL,
        audio_mutation_scene_number = NULL,
        audio_mutation_expires_at_ms = NULL,
        youtube_video_id = NULL,
        uploaded_at = NULL,
        completed_at = NULL
      WHERE id = 176`,
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM episode_script_drafts WHERE episode_id = 176",
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM episode_script_pending_chunks WHERE episode_id = 176",
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM episode_video_outputs WHERE series_id = 15 AND episode_number = 1",
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM agnes_scene_generations WHERE series_id = 15 AND episode_number = 1",
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM agnes_scene_generation_history WHERE series_id = 15 AND episode_number = 1",
      args: [],
    });

    await client.execute({
      sql: "DELETE FROM youtube_upload_receipts WHERE series_id = 15 AND episode_number = 1",
      args: [],
    });

    console.log("=== Cleaning local disk output directory ===");
    const epDir = path.resolve("output/series_15/episode_1");
    if (existsSync(epDir)) {
      console.log(`Removing stale files in ${epDir}`);
      await rm(epDir, { recursive: true, force: true });
      await mkdir(epDir, { recursive: true });
      console.log("Cleaned and recreated output/series_15/episode_1");
    }

    console.log("✅ Successfully reset Series 15 Episode 1!");

    const nextEp = await seriesState.getNextEpisode(15);
    console.log("Verified getNextEpisode(15):", nextEp ? { id: nextEp.id, seriesId: nextEp.seriesId, episodeNumber: nextEp.episodeNumber, title: nextEp.title, status: nextEp.status } : null);
  } catch (error) {
    console.error("Error resetting episode:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main();
