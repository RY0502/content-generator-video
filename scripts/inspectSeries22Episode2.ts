import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";

function probe(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(CONFIG.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("close", code => {
      if (code === 0) resolve(Number(out.trim()));
      else reject(new Error("ffprobe failed"));
    });
  });
}

async function main() {
  const epDir = path.join("output", "series_22", "episode_2");
  const videoPath = path.join(epDir, "Tiny_Heroes_Club_episode_2_agnes_text.mp4");
  
  if (fs.existsSync(videoPath)) {
    const dur = await probe(videoPath);
    console.log(`Video total duration: ${dur.toFixed(2)}s (${(dur/60).toFixed(2)} min)`);
  } else {
    console.log("Video does not exist at:", videoPath);
  }

  const state = new SeriesState();
  try {
    await state.initialize();
    const ep = await state.getEpisodeByNumber(22, 2);
    if (!ep) {
      console.log("Episode not found in DB");
      return;
    }
    console.log("Episode title:", ep.title);
    console.log("Episode status:", ep.status);
    const script = ep.scriptJson as any;
    console.log(`Scenes count: ${script?.scenes?.length}`);
    
    let totalWavDuration = 0;
    console.log("\n--- SCENES BREAKDOWN ---");
    for (const sc of (script?.scenes || [])) {
      const wavPath = path.join(epDir, "audio", `scene_${String(sc.sceneNumber).padStart(3, "0")}_narrator.wav`);
      let wavDur = 0;
      if (fs.existsSync(wavPath)) {
        wavDur = await probe(wavPath);
        totalWavDuration += wavDur;
      }
      const promptFile = fs.readdirSync(path.join(epDir, "agnes_text", "prompts"))
        .find(f => f.startsWith(`scene_${String(sc.sceneNumber).padStart(3, "0")}`));
      let promptSnippet = "";
      if (promptFile) {
        promptSnippet = fs.readFileSync(path.join(epDir, "agnes_text", "prompts", promptFile), "utf8");
      }
      
      console.log(`\n[Scene ${sc.sceneNumber}] (WAV: ${wavDur.toFixed(2)}s, words: ${sc.narrationText?.split(/\s+/).length})`);
      console.log(`  Narration: "${sc.narrationText}"`);
      console.log(`  Location: ${sc.location}`);
      console.log(`  Environment: ${sc.environmentDescription}`);
      console.log(`  ContinuityAnchors: ${JSON.stringify(sc.continuityAnchors)}`);
      console.log(`  Action: ${sc.action}`);
      console.log(`  Agnes Prompt: ${promptSnippet}`);
    }
    console.log(`\nTotal narration audio duration: ${totalWavDuration.toFixed(2)}s (${(totalWavDuration/60).toFixed(2)} min)`);
  } finally {
    await state.close();
  }
}

main().catch(console.error);
