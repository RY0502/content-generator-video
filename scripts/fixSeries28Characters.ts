import "dotenv/config";
import { SeriesState } from "../src/state/seriesState.js";

async function main() {
  const seriesState = new SeriesState();
  const seriesId = 28;

  try {
    const updatedCharacters = [
      {
        name: "Mia",
        description: "A curious and imaginative 5-year-old girl with cute short chin-length chestnut brown hair (cute girl bob cut, no earrings), wearing a vibrant yellow t-shirt, cuffed blue jeans, red sneakers, and holding a brown notebook. Feminine young girl features.",
      },
      {
        name: "Leo",
        description: "A brave and energetic 5-year-old boy with short messy black hair, wearing a forest green t-shirt, earthy brown cargo shorts, and orange sneakers. Energetic young boy features.",
      },
      {
        name: "Tara",
        description: "An observant and logical 5-year-old girl with long jet-black hair tied in a high bouncy ponytail with a purple hairband, wearing a purple t-shirt, denim blue skirt, and yellow boots. Thoughtful young girl features.",
      },
      {
        name: "Bobo the Backpack",
        description: "A magical living backpack with bright sky-blue fabric, yellow straps, button eyes, stitched smile, and small blue cartoon arms and legs. Bobo is playful and expressive.",
      },
    ];

    console.log("1. Updating series 28 characters_json...");
    await (seriesState as any).client.execute({
      sql: "UPDATE series SET characters_json = ? WHERE id = ?",
      args: [JSON.stringify(updatedCharacters), seriesId],
    });

    console.log("2. Updating character_sheets for series 28...");
    const sheets = [
      {
        name: "Mia",
        desc: updatedCharacters[0].description,
        prompt: "Young girl (female child), short chin-length chestnut-brown bob hair, golden-brown almond eyes, vibrant yellow t-shirt, cuffed blue jeans, red sneakers, brown notebook, cute feminine girl smile, Always same colors.",
      },
      {
        name: "Leo",
        desc: updatedCharacters[1].description,
        prompt: "Young boy (male child), short messy black hair, golden-brown eyes, forest-green shirt, earthy-brown cargo shorts, vibrant-orange sneakers, energetic boy grin, Always same colors.",
      },
      {
        name: "Tara",
        desc: updatedCharacters[2].description,
        prompt: "Young girl (female child), long jet-black hair in high ponytail with purple band, dark chestnut eyes, purple t-shirt, denim blue skirt, yellow rain boots, thoughtful girl smile, Always same colors.",
      },
      {
        name: "Bobo the Backpack",
        desc: updatedCharacters[3].description,
        prompt: "Living sky-blue backpack companion, vivid yellow straps, chestnut brown button eyes, stitched cream smile, small blue cartoon arms and legs, Always same colors.",
      },
    ];

    for (const sheet of sheets) {
      await (seriesState as any).client.execute({
        sql: `UPDATE character_sheets 
              SET description = ?, generation_prompt = ?, approved_at = datetime('now')
              WHERE series_id = ? AND character_name = ?`,
        args: [sheet.desc, sheet.prompt, seriesId, sheet.name],
      });
      console.log(`Updated sheet for ${sheet.name}`);
    }

    console.log("3. Clearing key_art records for series 28 to allow fresh generation...");
    await (seriesState as any).client.execute({
      sql: "DELETE FROM key_art WHERE series_id = ?",
      args: [seriesId],
    });

    console.log("✅ Successfully updated Series 28 character definitions and reset key art.");
  } catch (err) {
    console.error("Error updating series 28:", err);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main();
