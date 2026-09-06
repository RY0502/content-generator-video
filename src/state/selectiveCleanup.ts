import { createClient } from "@libsql/client";
import { Pool } from "pg";
import { CONFIG } from "../config.js";

export interface NeonSelectiveCleanupOptions {
  preserveCustomState?: boolean;
  preserveAgentRuns?: boolean;
}

export interface TursoSelectiveCleanupOptions {
  keepLatestCompletedScript?: boolean;
  clearCompletedOutputPaths?: boolean;
  seriesId?: number;
}

/**
 * Removes only the heavy or non-essential framework rows from Neon while preserving
 * prompt identity and optional caller-defined custom state.
 */
export async function selectiveCleanupNeon(options: NeonSelectiveCleanupOptions = {}): Promise<void> {
  const pool = new Pool({ connectionString: CONFIG.neonDatabaseUrl() });
  const preserveCustomState = options.preserveCustomState ?? true;
  const preserveAgentRuns = options.preserveAgentRuns ?? true;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM checkpoint_writes");
      await client.query("DELETE FROM checkpoints");
      await client.query("DELETE FROM agent_events");
      await client.query("DELETE FROM agent_todos");
      if (!preserveCustomState) {
        await client.query("DELETE FROM agent_custom_state");
      }
      if (!preserveAgentRuns) {
        await client.query("DELETE FROM agent_runs");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Legacy-compatible maintenance helper for databases created before production
 * upload finalization began clearing completed script payloads automatically.
 * It preserves durable series/episode receipts, character sheets, and every
 * unfinished episode's resumable Agnes state.
 */
export async function selectiveCleanupTurso(options: TursoSelectiveCleanupOptions = {}): Promise<void> {
  const client = createClient({
    url: CONFIG.tursoDatabaseUrl(),
    authToken: CONFIG.tursoAuthToken(),
  });

  const keepLatestCompletedScript = options.keepLatestCompletedScript ?? true;
  const clearCompletedOutputPaths = options.clearCompletedOutputPaths ?? false;
  const filterClause = options.seriesId ? " AND series_id = ?" : "";
  const filterArgs = options.seriesId ? [options.seriesId] : [];

  try {
    let latestCompletedEpisodeBySeries = new Map<number, number>();

    if (keepLatestCompletedScript) {
      const latestRows = await client.execute({
        sql:
          "SELECT series_id, MAX(episode_number) AS latest_episode_number FROM episodes WHERE status = 'done'" +
          filterClause +
          " GROUP BY series_id",
        args: filterArgs,
      });
      latestCompletedEpisodeBySeries = new Map(
        latestRows.rows.map((row) => [Number(row.series_id), Number(row.latest_episode_number)])
      );
    }

    const completedRows = await client.execute({
      sql:
        "SELECT id, series_id, episode_number FROM episodes WHERE status = 'done'" +
        filterClause +
        " ORDER BY series_id, episode_number",
      args: filterArgs,
    });

    for (const row of completedRows.rows) {
      const seriesId = Number(row.series_id);
      const episodeNumber = Number(row.episode_number);
      const episodeId = Number(row.id);
      const keepScript = keepLatestCompletedScript && latestCompletedEpisodeBySeries.get(seriesId) === episodeNumber;
      if (keepScript) {
        continue;
      }

      await client.execute({
        sql: `UPDATE episodes
              SET script_json = NULL,
                  output_path = CASE WHEN ? THEN NULL ELSE output_path END,
                  updated_at = datetime('now')
              WHERE id = ?`,
        args: [clearCompletedOutputPaths ? 1 : 0, episodeId],
      });
    }
  } finally {
    client.close();
  }
}
