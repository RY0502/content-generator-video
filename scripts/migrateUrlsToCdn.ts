import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const OLD_ORIGIN = "https://beloved-seahorse-139.convex.cloud";
const NEW_CDN_ORIGIN = (process.env.CONVEX_CDN_URL || "https://convex-portrait-cache.ravi-y0102.workers.dev").replace(/\/+$/gu, "");

async function main() {
  console.log(`Migrating URLs from ${OLD_ORIGIN} to ${NEW_CDN_ORIGIN} in Turso DB...\n`);

  // 1. character_sheets
  const csRes = await client.execute({
    sql: "SELECT id, series_id, character_name, reference_image_paths FROM character_sheets WHERE reference_image_paths LIKE ?",
    args: [`%${OLD_ORIGIN}%`],
  });

  console.log(`Found ${csRes.rows.length} character_sheet(s) to migrate.`);
  for (const row of csRes.rows) {
    const rawPaths = row.reference_image_paths as string;
    const updatedPaths = rawPaths.replaceAll(OLD_ORIGIN, NEW_CDN_ORIGIN);
    await client.execute({
      sql: "UPDATE character_sheets SET reference_image_paths = ? WHERE id = ?",
      args: [updatedPaths, row.id as number],
    });
    console.log(`  - Updated character_sheet id=${row.id} (Series ${row.series_id}: ${row.character_name})`);
  }

  // 2. agnes_scene_generations
  const asgRes = await client.execute({
    sql: "SELECT id, series_id, episode_number, scene_number, public_reference_url FROM agnes_scene_generations WHERE public_reference_url LIKE ?",
    args: [`%${OLD_ORIGIN}%`],
  });

  console.log(`\nFound ${asgRes.rows.length} agnes_scene_generation(s) to migrate.`);
  for (const row of asgRes.rows) {
    const rawUrl = row.public_reference_url as string;
    const updatedUrl = rawUrl.replaceAll(OLD_ORIGIN, NEW_CDN_ORIGIN);
    await client.execute({
      sql: "UPDATE agnes_scene_generations SET public_reference_url = ?, updated_at = datetime('now') WHERE id = ?",
      args: [updatedUrl, row.id as number],
    });
    console.log(`  - Updated scene id=${row.id} (Series ${row.series_id} Ep ${row.episode_number} Scene ${row.scene_number})`);
  }

  // 3. Verification
  const verifyCs = await client.execute({
    sql: "SELECT count(*) as cnt FROM character_sheets WHERE reference_image_paths LIKE ?",
    args: [`%${OLD_ORIGIN}%`],
  });
  const verifyAsg = await client.execute({
    sql: "SELECT count(*) as cnt FROM agnes_scene_generations WHERE public_reference_url LIKE ?",
    args: [`%${OLD_ORIGIN}%`],
  });

  console.log("\n=================================");
  console.log("Migration Complete!");
  console.log(`Remaining with old origin in character_sheets: ${verifyCs.rows[0]?.cnt}`);
  console.log(`Remaining with old origin in agnes_scene_generations: ${verifyAsg.rows[0]?.cnt}`);
  console.log("=================================");
}

main().catch(console.error);
