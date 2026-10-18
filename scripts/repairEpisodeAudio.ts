import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { SeriesState } from "../src/state/seriesState.js";
import { buildTtsTool, createNarrationAudioRequestDigest, narrationAudioMetadataPath, readNarrationAudioMetadata } from "../src/tools/ttsTool.js";
import { CONFIG } from "../src/config.js";

async function main() {
  const seriesId = Number(process.argv[2] || 19);
  const episodeNumber = Number(process.argv[3] || 1);

  console.log(`[RepairAudio] Inspecting and repairing audio for Series ${seriesId}, Episode ${episodeNumber}...`);
  const seriesState = new SeriesState();

  try {
    const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${episodeNumber} for series ${seriesId} not found.`);
    }

    const script = typeof episode.scriptJson === "string" ? JSON.parse(episode.scriptJson) : episode.scriptJson;
    const rawScenes: Array<{ sceneNumber: number; narrationText: string }> = script.scenes || [];
    console.log(`[RepairAudio] Episode "${episode.title}" has ${rawScenes.length} scenes.`);

    // Build standalone TTS tool that does not acquire the Turso mutation lock
    // (the lock prevents script-stage regeneration once Agnes has already started).
    const ttsTool = buildTtsTool({ outputDir: CONFIG.outputDir });

    const destDir = path.join(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`, "audio");

    let generatedCount = 0;
    let reusedCount = 0;

    for (const scene of rawScenes) {
      const sceneStem = `scene_${String(scene.sceneNumber).padStart(3, "0")}`;
      const finalWavPath = path.join(destDir, `${sceneStem}_narrator.wav`);
      const metaPath = narrationAudioMetadataPath(finalWavPath);

      const expectedDigest = createNarrationAudioRequestDigest({
        text: scene.narrationText.trim(),
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      });

      let needsGeneration = true;
      if (existsSync(finalWavPath) && existsSync(metaPath)) {
        const meta = await readNarrationAudioMetadata(metaPath);
        if (meta?.requestDigest === expectedDigest) {
          needsGeneration = false;
          reusedCount++;
        }
      }

      if (needsGeneration) {
        console.log(`[RepairAudio] Generating missing audio for scene ${scene.sceneNumber}...`);
        const resultJson = await ttsTool.func({
          seriesId,
          episodeNumber,
          sceneNumber: scene.sceneNumber,
          text: scene.narrationText.trim(),
        });
        const result = JSON.parse(resultJson);
        console.log(`[RepairAudio] Scene ${scene.sceneNumber} generated: ${result.durationSeconds?.toFixed(3)}s`);
        generatedCount++;
      } else {
        console.log(`[RepairAudio] Scene ${scene.sceneNumber} already exists and is valid. Reused.`);
      }
    }

    console.log(`[RepairAudio] Summary: ${generatedCount} generated, ${reusedCount} reused.`);

    // Verify readiness
    const readiness = await seriesState.assertEpisodeAudioReady(episode.id);
    console.log(`[RepairAudio] SUCCESS! All audio is verified and ready. Total duration: ${readiness.totalDurationSeconds.toFixed(3)}s.`);
  } catch (error) {
    console.error("[RepairAudio] Failed with error:", error);
    process.exitCode = 1;
  } finally {
    await seriesState.close();
  }
}

main();
