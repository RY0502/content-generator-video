import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

/**
 * Lists all series and their episodes in the database.
 */
async function main() {
  const seriesState = new SeriesState();

  try {
    const seriesResult = await (seriesState as any).pool.query(
      "SELECT id, concept_name FROM series ORDER BY id DESC LIMIT 10"
    );

    console.log("\n📚 Recent Series:\n");
    for (const series of seriesResult.rows) {
      console.log(`Series ${series.id}: ${series.concept_name}`);

      const episodesResult = await (seriesState as any).pool.query(
        "SELECT episode_number, title, status FROM episodes WHERE series_id = $1 ORDER BY episode_number",
        [series.id]
      );

      if (episodesResult.rows.length > 0) {
        for (const ep of episodesResult.rows) {
          console.log(`  Episode ${ep.episode_number}: ${ep.title} [${ep.status}]`);
        }
      } else {
        console.log(`  (no episodes)`);
      }
      console.log();
    }
  } catch (error) {
    console.error("Error:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
