import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  try {
    const series = await client.execute("SELECT id, concept_name, episode_formula FROM series ORDER BY id ASC");
    console.log("=== SERIES ===");
    for (const s of series.rows) {
      console.log(`ID: ${s.id} | Concept: "${s.concept_name}"`);
      const episodes = await client.execute({
        sql: "SELECT id, episode_number, title, status, output_path, completed_at FROM episodes WHERE series_id = ? ORDER BY episode_number ASC",
        args: [s.id],
      });
      console.log(`  Episodes count: ${episodes.rows.length}`);
      const nonPending = episodes.rows.filter(e => e.status !== "pending" || e.completed_at || e.output_path);
      for (const ep of nonPending) {
        console.log(`    Ep ${ep.episode_number}: "${ep.title}" | Status: ${ep.status} | Output: ${ep.output_path} | CompletedAt: ${ep.completed_at}`);
      }
    }
  } catch (err) {
    console.error("Error inspecting series:", err);
  } finally {
    client.close();
    process.exit(0);
  }
}

main();
