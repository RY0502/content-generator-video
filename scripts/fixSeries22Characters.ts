import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@libsql/client";
import {
  configuredConvexCharacterReferenceStoreOptions,
} from "../src/services/seriesCharacterPortraitService.js";
import {
  uploadConvexCharacterReference,
  canonicalCharacterImageName,
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
    name: "Pip the Ant",
    richDescription: "An adorable, brave tiny red ant hero with big expressive warm brown eyes, cheerful smile, wearing a miniature leafy-green adventurer tunic with tiny brass buttons, a cute acorn-cap helmet, and a tiny rolled scout map on his back. Heroic, confident, lovable leader.",
    filename: "pip_the_ant.png",
  },
  {
    name: "Nibbles the Hamster",
    richDescription: "An adorable chubby golden-brown hamster inventor with fluffy cheeks, bright curious eyes, wearing tiny brass aviator goggles pushed up on his forehead, a miniature brown leather tool vest with tiny spanner and gears tucked in the pockets, and cute little work gloves. Enthusiastic, inventive, friendly grin.",
    filename: "nibbles_the_hamster.png",
  },
  {
    name: "Sunny the Sparrow",
    richDescription: "A charming, cheerful little song sparrow aerial scout with warm golden-buff plumage, big bright curious eyes, wearing a tiny brown leather aviator flight cap, a miniature sky-blue scarf fluttering gently around her neck, and a tiny compass strap. Spirited, alert, friendly posture.",
    filename: "sunny_the_sparrow.png",
  },
  {
    name: "Pebble the Turtle",
    richDescription: "A wise, lovable little green box turtle with a beautifully patterned polished jade-green shell, large warm kind eyes, wearing tiny round brass spectacles perched on his nose, a cozy miniature knit explorer scarf, and a tiny shoulder satchel. Warm, patient, gentle smile.",
    filename: "pebble_the_turtle.png",
  },
  {
    name: "Luna the Firefly",
    richDescription: "An enchanting, adorable magical firefly sprite with a warm golden bioluminescent glowing abdomen emitting gentle magical ambient light and subtle sparkle motes, cute antennae with soft glowing tips, delicate iridescent translucent wings, large sweet expressive dark eyes, and a charming friendly smile.",
    filename: "luna_the_firefly.png",
  },
];

async function main() {
  console.log("=== Updating Series 22 Character Portraits to High-Quality 2K Agnes Assets ===");

  const storeOptions = configuredConvexCharacterReferenceStoreOptions();
  const seriesState = new SeriesState();
  await seriesState.initialize();

  const seriesId = 22;
  const updatedRoster: Array<{ name: string; description: string }> = [];

  for (const c of characters) {
    console.log(`\n--- Processing ${c.name} ---`);
    const sourcePath = path.resolve(`output/test_series22_characters/${c.filename}`);
    const rawBytes = await readFile(sourcePath);
    console.log(`Read ${sourcePath} (${rawBytes.length} bytes)`);

    // Compress
    const compressedBytes = compressPortraitImage(rawBytes);
    console.log(`Compressed from ${rawBytes.length} to ${compressedBytes.length} bytes`);

    // Upload to Convex
    console.log(`Uploading ${c.name} to Convex file storage...`);
    const publicRef = await uploadConvexCharacterReference(
      { seriesId, characterName: c.name },
      compressedBytes,
      storeOptions,
    );
    console.log(`Convex URL: ${publicRef.publicUrl}`);
    console.log(`Convex SHA256: ${publicRef.sha256}`);

    // Compute canonical storage path
    const requestDigest = createCharacterPortraitRequestDigest(c.richDescription, MODEL);
    const charDir = path.resolve(
      "assets",
      `series_${seriesId}`,
      "characters",
      safeCharacterPathSegment(c.name),
      requestDigest,
    );
    await mkdir(charDir, { recursive: true });
    const localTarget = path.join(charDir, c.filename);
    await writeFile(localTarget, compressedBytes);
    console.log(`Saved canonical local portrait to: ${localTarget}`);

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
      seriesId,
      c.name,
      c.richDescription,
      referenceImagePaths,
      c.name,
    );
    console.log(`Upserted character_sheets row for "${c.name}"`);

    updatedRoster.push({
      name: c.name,
      description: c.richDescription,
    });
  }

  // Update series table characters_json
  console.log("\nUpdating series 22 characters_json in Turso...");
  await client.execute({
    sql: "UPDATE series SET characters_json = ? WHERE id = ?",
    args: [JSON.stringify(updatedRoster), seriesId],
  });

  console.log(" Verifying character sheets for Series 22:");
  for (const c of characters) {
    const sheet = await seriesState.getCharacterSheet(seriesId, c.name);
    console.log(`  ${c.name}:`);
    console.log(`    Description: ${sheet?.description.slice(0, 70)}...`);
    console.log(`    Portrait URL: ${sheet?.referenceImagePaths?.portrait?.publicUrl}`);
    console.log(`    SHA256: ${sheet?.referenceImagePaths?.portrait?.sha256}`);
  }

  console.log("\n Series 22 characters successfully upgraded!");
  await seriesState.close();
}

main().catch(console.error);
