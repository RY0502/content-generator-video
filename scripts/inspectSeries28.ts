import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const seriesState = new SeriesState();
  try {
    const allSeries = await (seriesState as any).client.execute({
      sql: "SELECT id, concept_name FROM series",
      args: [],
    });
    console.log("=== All Series ===");
    console.log(allSeries.rows);

    const allEps = await (seriesState as any).client.execute({
      sql: "SELECT id, series_id, episode_number, title, status FROM episodes",
      args: [],
    });
    console.log("=== All Episodes ===");
    console.log(allEps.rows);

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await seriesState.close();
  }
}

main();
