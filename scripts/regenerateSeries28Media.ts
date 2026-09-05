import "dotenv/config";
import { rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SeriesState } from "../src/state/seriesState.js";
import { buildSeriesKeyArtTool, buildEpisodeKeyArtTool } from "../src/tools/keyArtTool.js";
import { buildSceneImageTool } from "../src/tools/sceneImageTool.js";
import { CONFIG } from "../src/config.js";
import { assertLegacyImageFlowOptIn } from "./legacyImageFlowGuard.js";

async function main() {
  assertLegacyImageFlowOptIn(
    "regenerateSeries28Media.ts",
    "historical Series 28 key-art/scene-image regeneration (including replacement of existing legacy files)",
  );
  const seriesState = new SeriesState();
  const seriesId = 28;
  const episodeNumber = 1;

  try {
    console.log("=== Backing up & Removing Old Images for Series 28 ===");
    const backupDir = path.join(CONFIG.outputDir, "series_28", "backup_old");
    await mkdir(backupDir, { recursive: true });

    const seriesKeyArtPath = path.join(CONFIG.outputDir, "series_28", "key_art", "series_key_art.png");
    if (existsSync(seriesKeyArtPath)) {
      await copyFile(seriesKeyArtPath, path.join(backupDir, "series_key_art_old.png"));
      await rm(seriesKeyArtPath, { force: true });
      console.log("Archived and removed old series key art");
    }

    const episodeKeyArtPath = path.join(CONFIG.outputDir, "series_28", "episode_1", "key_art", "episode_1_key_art.png");
    if (existsSync(episodeKeyArtPath)) {
      await copyFile(episodeKeyArtPath, path.join(backupDir, "episode_1_key_art_old.png"));
      await rm(episodeKeyArtPath, { force: true });
      console.log("Archived and removed old episode 1 key art");
    }

    const scenesDir = path.join(CONFIG.outputDir, "series_28", "episode_1", "scenes");
    for (let i = 1; i <= 5; i++) {
      const sceneFile = path.join(scenesDir, `scene_${String(i).padStart(3, "0")}.png`);
      if (existsSync(sceneFile)) {
        await copyFile(sceneFile, path.join(backupDir, `scene_${String(i).padStart(3, "0")}_old.png`));
        await rm(sceneFile, { force: true });
        console.log(`Archived and removed old scene ${i}`);
      }
    }

    console.log("\n=== 1. Generating Fresh Series Key Art ===");
    const seriesKeyArtTool = buildSeriesKeyArtTool(seriesState);
    const seriesKeyArtResult = await (seriesKeyArtTool as any).func({
      seriesId,
      conceptName: "Time-Travel Backpack",
      conceptSummary: "Three curious children discover a magical backpack that can open portals through time and space. Mia (curious girl with short brown hair), Leo (energetic boy with black hair), Tara (logical girl with long ponytail), and Bobo the Backpack.",
      characterNames: ["Mia", "Leo", "Tara", "Bobo the Backpack"],
    });
    console.log("Series Key Art Result:", seriesKeyArtResult);

    console.log("\n=== 2. Generating Fresh Episode 1 Key Art ===");
    const episodeKeyArtTool = buildEpisodeKeyArtTool(seriesState);
    const episodeKeyArtResult = await (episodeKeyArtTool as any).func({
      seriesId,
      episodeNumber,
      conceptName: "Time-Travel Backpack",
      episodeTitle: "The Dino's Lost Roar",
      episodePremise: "The children arrive in a prehistoric valley and help a young dinosaur find his voice.",
      mainCharacterName: "Mia",
    });
    console.log("Episode Key Art Result:", episodeKeyArtResult);

    console.log("\n=== 3. Generating Fresh Scenes 1 to 5 ===");
    const scriptPath = path.join(CONFIG.outputDir, "series_28", "episode_1", "script_refined.json");
    const scriptData = JSON.parse(readFileSync(scriptPath, "utf-8"));
    const sceneTool = buildSceneImageTool(seriesState);

    for (let i = 0; i < 5; i++) {
      const scene = scriptData.scenes[i];
      console.log(`\n--- Generating Scene ${scene.sceneNumber} ---`);
      const sceneResult = await (sceneTool as any).func({
        seriesId,
        episodeNumber,
        sceneNumber: scene.sceneNumber,
        environmentDescription: scene.environmentDescription,
        action: scene.action,
        narrationText: scene.narrationText,
        cameraAngle: scene.cameraAngle ?? "establishing",
        lighting: scene.lighting ?? "warm morning sunlight",
        characterNames: scene.characterNames,
        characterVisuals: scene.characterVisuals,
        supportingEntities: scene.supportingEntities,
        continuityAnchors: scene.continuityAnchors,
        sceneDetails: scene.sceneDetails,
      });
      console.log(`Scene ${scene.sceneNumber} Result:`, sceneResult);
    }

    console.log("\n🎉 All key arts and scenes successfully regenerated!");
  } catch (err) {
    console.error("Fatal error during regeneration:", err);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main();
