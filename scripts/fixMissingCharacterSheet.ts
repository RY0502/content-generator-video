import { SeriesState } from "../src/state/seriesState.js";
import { CONFIG, validateProjectConfig } from "../src/config.js";

/**
 * Script to check and fix missing character sheets in the database.
 * Usage: tsx scripts/fixMissingCharacterSheet.ts <seriesId> <characterName>
 * Example: tsx scripts/fixMissingCharacterSheet.ts 15 "Chip the Squirrel"
 */
async function main(): Promise<void> {
  validateProjectConfig();

  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: tsx scripts/fixMissingCharacterSheet.ts <seriesId> <characterName>");
    console.error("Example: tsx scripts/fixMissingCharacterSheet.ts 15 'Chip the Squirrel'");
    process.exitCode = 1;
    return;
  }

  const seriesId = parseInt(args[0], 10);
  const characterName = args.slice(1).join(" ");

  if (isNaN(seriesId)) {
    console.error("Error: seriesId must be a number");
    process.exitCode = 1;
    return;
  }

  const seriesState = new SeriesState(CONFIG.neonDatabaseUrl());

  try {
    console.log(`\n🔍 Checking character sheet for "${characterName}" in series ${seriesId}...`);

    const sheet = await seriesState.getCharacterSheet(seriesId, characterName);

    if (!sheet) {
      console.error(`\n❌ Character sheet not found for "${characterName}"`);
      console.log("\nTo fix this, you need to:");
      console.log("1. Run the main pipeline again: npm run dev -- \"<your prompt>\"");
      console.log("2. The pipeline will regenerate all character sheets including missing ones");
      console.log("3. Or manually insert the character sheet into the database");
      process.exitCode = 1;
      return;
    }

    console.log(`\n✅ Character sheet found for "${characterName}"`);
    console.log(`   Reference images: ${Object.keys(sheet.referenceImagePaths).length}`);
    console.log(`   Generation prompt: ${sheet.generationPrompt?.substring(0, 100)}...`);

    if (!sheet.generationPrompt) {
      console.error(`\n⚠️  WARNING: Character sheet exists but has NO generationPrompt!`);
      console.log("This is why scene generation is failing.");
      console.log("\nTo fix:");
      console.log("1. Delete the incomplete character sheet from the database");
      console.log("2. Run the main pipeline again to regenerate it");
      process.exitCode = 1;
      return;
    }

    console.log("\n✅ Character sheet is complete and ready for use!");
  } catch (error) {
    console.error("\n❌ Error checking character sheet:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
