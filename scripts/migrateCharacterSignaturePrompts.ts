import "dotenv/config";
import { createClient } from "@libsql/client";
import { chatText } from "../src/providers/aiClient.js";
import {
  buildCharacterSignatureDistillSystemPrompt,
  buildCharacterSignatureDistillUserText,
} from "../src/promptBuilder.js";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN ?? "";

if (!url) {
  console.error("Error: TURSO_DATABASE_URL environment variable is not set.");
  process.exit(1);
}

/**
 * Migrates existing character `generation_prompt` fields from full exhaustive
 * descriptions to compact ≤260 character "signature prompts" by calling an LLM
 * distillation step. Useful when characters were generated before the
 * distillation feature was added.
 */
async function migrateCharacterSignaturePrompts(): Promise<void> {
  const client = createClient({ url, authToken });

  try {
    console.log(`Connecting to Turso database: ${url}`);
    console.log("Fetching all characters with generation_prompt...\n");
    const res = await client.execute(
      `SELECT id, series_id, character_name, generation_prompt
       FROM character_sheets
       WHERE generation_prompt IS NOT NULL AND generation_prompt != ''
       ORDER BY series_id, character_name`
    );

    const characters = res.rows;
    if (characters.length === 0) {
      console.log("No characters found with generation_prompt. Nothing to migrate.");
      return;
    }

    console.log(`Found ${characters.length} character(s) to migrate.\n`);

    let successCount = 0;
    let skipCount = 0;

    for (const row of characters) {
      const id = row.id as number;
      const series_id = row.series_id as number;
      const character_name = row.character_name as string;
      const generation_prompt = row.generation_prompt as string;

      // Skip if already a short signature (≤260 chars, likely already distilled).
      if (generation_prompt.length <= 260) {
        console.log(
          `⊘ Skipping "${character_name}" (series ${series_id}): already compact (${generation_prompt.length} chars)`
        );
        skipCount++;
        continue;
      }

      try {
        console.log(
          `→ Distilling "${character_name}" (series ${series_id}): ${generation_prompt.length} chars → ≤260 chars`
        );

        // Call LLM to distill the detailed description into a compact signature.
        const rawSignature = await chatText({
          systemPrompt: buildCharacterSignatureDistillSystemPrompt(),
          userText: buildCharacterSignatureDistillUserText(generation_prompt),
        });

        // Hard-cap at 260 characters in case the LLM overshoots.
        const compactSignature = rawSignature.replace(/\s+/g, " ").trim().slice(0, 260);

        // Update the DB with the new compact signature.
        await client.execute({
          sql: `UPDATE character_sheets SET generation_prompt = ? WHERE id = ?`,
          args: [compactSignature, id],
        });

        console.log(`  ✓ Updated to: "${compactSignature}" (${compactSignature.length} chars)\n`);
        successCount++;
      } catch (error) {
        const err = error as { message?: string };
        console.error(
          `  ✗ Error distilling "${character_name}": ${err.message}\n`
        );
        throw error;
      }
    }

    console.log(`\n✅ Migration completed!`);
    console.log(`  • Distilled: ${successCount}`);
    console.log(`  • Skipped (already compact): ${skipCount}`);
    console.log(`  • Total: ${characters.length}`);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrateCharacterSignaturePrompts();
