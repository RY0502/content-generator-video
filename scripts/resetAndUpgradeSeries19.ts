import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@libsql/client";
import {
  configuredConvexCharacterReferenceStoreOptions,
} from "../src/services/seriesCharacterPortraitService.js";
import {
  deleteConvexSeriesCharacterReferences,
  uploadConvexCharacterReference,
} from "../src/providers/convexCharacterReferenceStore.js";
import { compressPortraitImage } from "../src/utils/imageCompressor.js";
import { SeriesState } from "../src/state/seriesState.js";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION = 1;
const MODEL = "agnes-image-2.5-flash";
const SERIES_ID = 19;

function createCharacterPortraitRequestDigest(characterDescription: string, model: string): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: CHARACTER_PORTRAIT_REQUEST_SCHEMA_VERSION,
    characterDescription: characterDescription.trim(),
    model,
  })).digest("hex");
}

function safeCharacterPathSegment(characterName: string): string {
  const normalized = characterName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+|\.+$/gu, "")
    .replace(/^_+|_+$/gu, "");
  return normalized || "unnamed_character";
}

const characters = [
  {
    name: "Toby the Teddy Bear",
    richDescription: "A lovable, courageous honey-gold vintage plush teddy bear living toy with soft fuzzy fleece texture, charming hand-stitched seams, warm brown glossy button eyes, a stitched smile, wearing a handsome little red knitted adventurer scarf and a tiny golden star badge on his chest. Brave, kind, endearing leader.",
    filename: "toby_the_teddy_bear.png",
  },
  {
    name: "Pip the Toy Robot",
    richDescription: "An adorable retro tin-toy wind-up robot with shiny turquoise-blue and cream enamel, a cheerful smiling digital LED face, glowing warm amber eyes, rounded child-friendly edges, a polished brass wind-up key on his back, a tiny flexible tool arm holding a miniature glowing screwdriver, and a cute little chest gauge. Playful, inventive, enthusiastic.",
    filename: "pip_the_toy_robot.png",
  },
  {
    name: "Lulu the Doll",
    richDescription: "A delightful, enchanting classic storybook ragdoll living toy with soft rosy cheeks, sunny spun-yarn blonde hair styled in two cute low pigtails tied with satin ribbon bows, large kind expressive embroidered blue eyes, wearing a charming pastel mint-green and lavender floral dress with white lace pinafore and little cloth shoes. Gentle, caring, imaginative.",
    filename: "lulu_the_doll.png",
  },
  {
    name: "Zoom the Toy Car",
    richDescription: "An energetic, charming retro die-cast toy racecar with glossy candy-apple red finish, a bold lightning-bolt yellow racing stripe, friendly rounded cartoon headlights that double as big expressive cartoon eyes, a cheerful bumper smile, cute chunky rubber tires with gleaming silver hubcaps, and a playful mini racing spoiler. Bouncy, spirited, fast.",
    filename: "zoom_the_toy_car.png",
  },
  {
    name: "Buttons the Plush Bunny",
    richDescription: "An endearing, sweet little lavender-cream plush toy bunny with long floppy velvet ears, mismatched shiny vintage button eyes (one turquoise, one amber), cute pink embroidered nose and whiskers, visible cozy patchwork stitching on one paw, wearing a tiny warm mustard-yellow knit cardigan sweater with mismatched little buttons. Timid, lovable, surprisingly courageous.",
    filename: "buttons_the_plush_bunny.png",
  },
];

async function main() {
  console.log(`=== Starting Reset & Upgrade for Series ${SERIES_ID} ===\n`);

  const storeOptions = configuredConvexCharacterReferenceStoreOptions();
  const seriesState = new SeriesState();
  await seriesState.initialize();

  // 1. Delete old portraits from Convex CDN
  console.log("1. Cleaning old character reference objects from Convex CDN...");
  try {
    const convexResult = await deleteConvexSeriesCharacterReferences(
      { seriesId: SERIES_ID, characterNames: characters.map((c) => c.name) },
      storeOptions,
    );
    console.log(`   Convex deleted ${convexResult.deletedObjectKeys.length} object(s):`, convexResult.deletedObjectKeys);
  } catch (err: any) {
    console.warn(`   Convex deletion warning: ${err.message}`);
  }

  // 2. Clean local assets for series 19
  console.log("\n2. Cleaning local disk assets for Series 19...");
  const localAssetsDir = path.resolve("assets", `series_${SERIES_ID}`);
  const localOutputDir = path.resolve("output", `series_${SERIES_ID}`);
  if (existsSync(localAssetsDir)) {
    await rm(localAssetsDir, { recursive: true, force: true });
    console.log(`   Removed local directory: ${localAssetsDir}`);
  } else {
    console.log(`   Local assets directory not present: ${localAssetsDir}`);
  }
  if (existsSync(localOutputDir)) {
    await rm(localOutputDir, { recursive: true, force: true });
    console.log(`   Removed local output directory: ${localOutputDir}`);
  }

  // 3. Reset database records in Turso
  console.log("\n3. Resetting Turso DB records for Series 19...");

  // Delete scene generations and video outputs
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
    sql: "DELETE FROM key_art WHERE series_id = ?",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM character_sheets WHERE series_id = ?",
    args: [SERIES_ID],
  });
  console.log("   Cleared agnes_scene_generations, key_art, and character_sheets for series 19");

  // Clear script drafts and pending chunks for series 19 episodes
  await client.execute({
    sql: "DELETE FROM episode_script_pending_chunks WHERE episode_id IN (SELECT id FROM episodes WHERE series_id = ?)",
    args: [SERIES_ID],
  });
  await client.execute({
    sql: "DELETE FROM episode_script_drafts WHERE episode_id IN (SELECT id FROM episodes WHERE series_id = ?)",
    args: [SERIES_ID],
  });
  console.log("   Cleared episode_script_drafts and pending chunks");

  // Reset episodes for series 19: reset episode 1 (and all episodes) to pending status
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
  console.log("   Reset all episodes in Series 19 to status='pending' with clean state");

  // 4. Process and upload upgraded 2K character portraits
  console.log("\n4. Uploading upgraded 2K character portraits and creating canonical character sheets...");
  const updatedRoster: Array<{ name: string; description: string }> = [];

  for (const c of characters) {
    console.log(`\n   --- Processing ${c.name} ---`);
    const sourcePath = path.resolve(`output/test_series19_characters/${c.filename}`);
    const rawBytes = await readFile(sourcePath);
    console.log(`   Read source image (${rawBytes.length} bytes)`);

    // Compress
    const compressedBytes = compressPortraitImage(rawBytes);
    console.log(`   Compressed to ${compressedBytes.length} bytes`);

    // Upload to Convex CDN
    console.log(`   Uploading to Convex CDN...`);
    const publicRef = await uploadConvexCharacterReference(
      { seriesId: SERIES_ID, characterName: c.name },
      compressedBytes,
      storeOptions,
    );
    console.log(`   Convex Public URL: ${publicRef.publicUrl}`);
    console.log(`   Convex SHA256: ${publicRef.sha256}`);

    // Compute canonical storage path
    const requestDigest = createCharacterPortraitRequestDigest(c.richDescription, MODEL);
    const charDir = path.resolve(
      "assets",
      `series_${SERIES_ID}`,
      "characters",
      safeCharacterPathSegment(c.name),
      requestDigest,
    );
    await mkdir(charDir, { recursive: true });
    const localTarget = path.join(charDir, c.filename);
    await writeFile(localTarget, compressedBytes);
    console.log(`   Saved canonical local portrait: ${localTarget}`);

    // Update Turso DB character_sheets table
    const referenceImagePaths = {
      portrait: {
        path: localTarget,
        canonicalFileName: c.filename,
        requestDigest,
        sha256: publicRef.sha256,
        model: MODEL,
        publicUrl: publicRef.publicUrl,
        publicObjectKey: publicRef.objectKey,
        contentType: "image/png",
        publicVerifiedAt: new Date().toISOString(),
      },
    };

    await seriesState.upsertCharacterSheet(
      SERIES_ID,
      c.name,
      c.richDescription,
      referenceImagePaths,
      c.name,
    );
    console.log(`   Upserted character_sheets row for "${c.name}"`);

    updatedRoster.push({
      name: c.name,
      description: c.richDescription,
    });
  }

  // 5. Update series table characters_json
  console.log("\n5. Updating series characters_json in Turso...");
  await client.execute({
    sql: "UPDATE series SET characters_json = ? WHERE id = ?",
    args: [JSON.stringify(updatedRoster), SERIES_ID],
  });
  console.log("   Updated series table characters_json successfully");

  // 6. Verify final state
  console.log("\n6. Verifying Series 19 character sheets and Episode 1 state:");
  for (const c of characters) {
    const sheet = await seriesState.getCharacterSheet(SERIES_ID, c.name);
    console.log(`   ${c.name}:`);
    console.log(`     Description: ${sheet?.description.slice(0, 75)}...`);
    console.log(`     Portrait URL: ${sheet?.referenceImagePaths?.portrait?.publicUrl}`);
    console.log(`     SHA256: ${sheet?.referenceImagePaths?.portrait?.sha256}`);
  }

  const ep1 = await client.execute({
    sql: "SELECT id, series_id, episode_number, status, title, script_json FROM episodes WHERE series_id = ? AND episode_number = 1",
    args: [SERIES_ID],
  });
  console.log("\n   Episode 1 State in DB:", ep1.rows[0]);

  console.log(`\n🎉 Series ${SERIES_ID} successfully reset and upgraded with fresh 2K characters! Ready for Episode 1.`);
  await seriesState.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
