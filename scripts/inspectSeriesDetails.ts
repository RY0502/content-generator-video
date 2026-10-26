import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  try {
    for (const id of [19, 20, 21, 22]) {
      const episodes = await client.execute({
        sql: "SELECT id, episode_number, title, status, output_path, completed_at FROM episodes WHERE series_id = ? ORDER BY episode_number ASC",
        args: [id],
      });
      console.log(`\n=== SERIES ${id} ===`);
      for (const ep of episodes.rows.slice(0, 5)) {
        console.log(`  Ep ${ep.episode_number}: "${ep.title}" | Status: ${ep.status} | Output: ${ep.output_path} | CompletedAt: ${ep.completed_at}`);
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
