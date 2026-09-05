import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const seriesState = new SeriesState();
  try {
    const client = (seriesState as any).client;
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    console.log("Tables:", tables.rows.map((r: any) => r.name));

    for (const t of tables.rows) {
      const count = await client.execute(`SELECT count(*) as c FROM ${t.name}`);
      console.log(`Count for ${t.name}:`, count.rows[0].c);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await seriesState.close();
  }
}

main();
