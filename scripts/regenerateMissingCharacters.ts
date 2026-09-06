import { DeepAgentRunner, DatabaseClient, CustomStateStore, hashUserPrompt, CONFIG as FRAMEWORK_CONFIG } from "freetier-deepagent-framework";
import path from "node:path";
import { CONFIG, validateProjectConfig } from "../src/config.js";
import { installDeepAgentBackend } from "../src/services/deepAgentBackend.js";
import { SeriesState } from "../src/state/seriesState.js";
import { buildCharacterSheetTool } from "../src/tools/characterSheetTool.js";

/**
 * Script to regenerate missing character sheets for a series.
 * Usage: tsx scripts/regenerateMissingCharacters.ts <seriesId> <characterName1> <characterName2> ...
 * Example: tsx scripts/regenerateMissingCharacters.ts 15 "Chip the Squirrel"
 */
async function main(): Promise<void> {
  validateProjectConfig();

  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: tsx scripts/regenerateMissingCharacters.ts <seriesId> <characterName1> [characterName2] ...");
    console.error("Example: tsx scripts/regenerateMissingCharacters.ts 15 'Chip the Squirrel'");
    process.exitCode = 1;
    return;
  }

  const seriesId = parseInt(args[0], 10);
  const characterNames = args.slice(1);

  if (isNaN(seriesId)) {
    console.error("Error: seriesId must be a number");
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseClient(FRAMEWORK_CONFIG.NEON_DATABASE_URL);
  const seriesState = new SeriesState(CONFIG.neonDatabaseUrl());

  try {
    // Fetch series data to get character descriptions
    const seriesResult = await (seriesState as any).pool.query(
      "SELECT id, concept_name, characters_json FROM series WHERE id = $1",
      [seriesId]
    );

    if (!seriesResult.rows[0]) {
      console.error(`\n❌ Series ${seriesId} not found`);
      process.exitCode = 1;
      return;
    }

    const series = seriesResult.rows[0];
    const charactersData = series.characters_json || [];
    
    // Build character descriptions from series data
    const characterDescriptions: Record<string, string> = {};
    for (const char of charactersData) {
      characterDescriptions[char.name] = char.description || "";
    }

    console.log(`\n🔄 Regenerating character sheets for series ${seriesId}:`);
    characterNames.forEach((name, i) => {
      const desc = characterDescriptions[name] || "No description found";
      console.log(`  ${i + 1}. ${name}: ${desc.substring(0, 60)}...`);
    });
    console.log();

    // Use a dummy prompt hash for this standalone operation
    const dummyPrompt = `Regenerate character sheets for series ${seriesId}: ${characterNames.join(", ")}`;
    const promptHash = hashUserPrompt(dummyPrompt);
    const customState = new CustomStateStore(db);

    const runner = new DeepAgentRunner(db, {
      extraTools: [buildCharacterSheetTool(seriesState, customState, promptHash)],
      extraSubagents: [],
      systemPromptExtension: `
You are a character sheet regeneration assistant. Your ONLY task is to call generate_character_sheet for each character provided, in order.
Do NOT call any other tools. Do NOT generate scripts or episodes. Just regenerate the character sheets.
After all characters are done, report completion and stop.

Character descriptions:
${characterNames.map(name => `- ${name}: ${characterDescriptions[name] || "No description"}`).join("\n")}
`,
      recursionLimit: 100,
    });
    installDeepAgentBackend(
      runner,
      path.join(CONFIG.outputDir, "_deep_agent_state"),
    );

    const prompt = `Regenerate character sheets for the following characters in series ${seriesId}: ${characterNames.join(", ")}. Call generate_character_sheet for each one. Use the character descriptions provided in the system prompt.`;
    const result = await runner.run(prompt);
    
    console.log("\n✅ Character sheet regeneration complete!");
    console.log(result.finalText);
  } catch (error) {
    console.error("\n❌ Character sheet regeneration failed:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
