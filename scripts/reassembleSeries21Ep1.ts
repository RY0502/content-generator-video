import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";
import { buildVideoAssemblyTool } from "../src/tools/videoAssemblyTool.js";

function probeMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const dur = Number(stdout.trim());
      if (code === 0 && Number.isFinite(dur) && dur > 0) resolve(dur);
      else reject(new Error(`ffprobe failed for ${filePath}: ${stderr}`));
    });
  });
}

async function main() {
  const seriesId = 21;
  const episodeNumber = 1;
  const state = new SeriesState();

  try {
    await state.initialize();
    const seriesInfo = await state.getSeriesInfo(seriesId);
    if (!seriesInfo) throw new Error(`Series ${seriesId} not found.`);
    const episode = await state.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode) throw new Error(`Episode ${episodeNumber} not found.`);

    console.log(`\n======================================================`);
    console.log(`Reassembling Series ${seriesId} (${seriesInfo.conceptName}), Episode ${episodeNumber}`);
    console.log(`Effective ASSEMBLY_PLAYBACK_SPEED config: ${CONFIG.assemblyPlaybackSpeed}`);
    console.log(`Target playback speed: 0.95 (5% subtle slowdown)`);
    console.log(`======================================================\n`);

    const episodeDir = path.resolve(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`);
    const existingVideo = path.join(episodeDir, "Adventures_Inside_Everyday_Objects_episode_1_agnes_text.mp4");
    if (fs.existsSync(existingVideo)) {
      const oldDuration = await probeMediaDuration(existingVideo);
      console.log(`Current video file on disk: ${existingVideo}`);
      console.log(`Current video duration: ${oldDuration.toFixed(2)}s`);
    }

    const manifest = await state.getEpisodeNarrationAudioManifest(episode.id);
    const scenes = manifest.scenes.map(({ sceneNumber }) => ({
      sceneNumber,
      narrationAudioPath: path.join(
        episodeDir,
        "audio",
        `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`
      ),
    }));

    console.log(`Preparing assembly for ${scenes.length} scenes with key art & outro...`);

    const assemblyTool = buildVideoAssemblyTool(state, {
      includeKeyArt: true,
      playbackSpeed: 0.95,
    });

    const resultStr = await (assemblyTool as any).func({
      seriesId,
      seriesTitle: seriesInfo.conceptName,
      episodeNumber,
      scenes,
      playbackSpeed: 0.95,
      burnSubtitles: CONFIG.burnSubtitles ?? false,
    });

    const result = typeof resultStr === "string" ? JSON.parse(resultStr) : resultStr;
    console.log("\nAssembly completed successfully!");
    console.log("Result:", result);

    if (fs.existsSync(result.path)) {
      const newDuration = await probeMediaDuration(result.path);
      const stat = fs.statSync(result.path);
      console.log(`\n>>> Verification:`);
      console.log(`Output Path: ${result.path}`);
      console.log(`New Duration: ${newDuration.toFixed(2)}s`);
      console.log(`File Size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Playback Speed Factor: 0.95x applied`);
    }

  } finally {
    await state.close();
  }
}

main().catch((err) => {
  console.error("Reassembly failed:", err);
  process.exitCode = 1;
});
