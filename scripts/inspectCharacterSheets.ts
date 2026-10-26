import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  try {
    for (const id of [19, 20, 22]) {
      console.log(`\n=== Character Sheets for Series ${id} ===`);
      const sheets = await client.execute({
        sql: "SELECT character_name, reference_image_paths, approved_at FROM character_sheets WHERE series_id = ?",
        args: [id],
      });
      for (const cs of sheets.rows) {
        console.log(`  Character: ${cs.character_name} | ApprovedAt: ${cs.approved_at} | Paths: ${cs.reference_image_paths}`);
      }
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    client.close();
    process.exit(0);
  }
}

main();
