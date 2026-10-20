import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";
import {
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  writeNarrationAudioMetadata,
  NARRATION_METADATA_SCHEMA_VERSION,
  NARRATION_METADATA_KIND,
  type NarrationAudioMetadata,
} from "../src/tools/ttsTool.js";
import {
  countNarrationSpokenWords,
  NARRATION_MAX_AUDIO_SECONDS,
} from "../src/services/narrationContract.js";
import { canonicalizeKeyArtTitle } from "../src/services/keyArtTitleContract.js";
import { agnesKeyArtPaths } from "../src/services/agnesKeyArtService.js";
import { buildSeriesStateTools } from "../src/tools/seriesStateTools.js";

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
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const duration = Number(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`ffprobe failed for ${filePath}: ${stderr}`));
    });
  });
}

function normalizeVideo(inputPath: string, outputPath: string, durationSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const child = spawn(CONFIG.ffmpegPath, [
      "-y", "-i", inputPath, "-map", "0:v:0", "-vf",
      `fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,` +
        `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
        `trim=start=0:duration=${durationSeconds},setpts=PTS-STARTPTS,format=yuv420p`,
      "-t", String(durationSeconds), "-an", "-c:v", "libx264",
      "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
      "-video_track_timescale", "90000", outputPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg normalization failed: ${stderr.slice(-300)}`));
    });
  });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destPath, Buffer.from(arrayBuffer));
}

async function main() {
  console.log("=== Reconciling Series 21 Episode 1 Media Pipeline ===");
  const state = new SeriesState();
  const audioGen = createAudioGenTool();

  try {
    await state.initialize();
    const client = (state as any).client;

    const seriesResult = await client.execute({
      sql: "SELECT * FROM series WHERE id = 21",
      args: [],
    });
    const series = seriesResult.rows[0];
    if (!series) throw new Error("Series 21 not found.");

    const epResult = await client.execute({
      sql: "SELECT * FROM episodes WHERE series_id = 21 AND episode_number = 1",
      args: [],
    });
    const episode = epResult.rows[0];
    if (!episode) throw new Error("Episode 1 not found for series 21.");
    if (!episode.script_json) throw new Error("Episode 1 has no persisted script_json.");

    const script = JSON.parse(episode.script_json as string);
    const scenes = script.scenes as Array<{ sceneNumber: number; narrationText: string }>;
    console.log(`Loaded script: "${script.title}" with ${scenes.length} scenes.`);

    const outputDir = path.resolve(CONFIG.outputDir);
    const audioDir = path.join(outputDir, "series_21", "episode_1", "audio");
    await mkdir(audioDir, { recursive: true });

    // Step 1: Synthesize all 20 scene narration WAVs + metadata sidecars
    console.log("\n--- Step 1: Synthesizing Narration Audio (20 Scenes) ---");
    const sceneDurations = new Map<number, number>();

    for (const scene of scenes) {
      const sceneNum = scene.sceneNumber;
      const stem = `scene_${String(sceneNum).padStart(3, "0")}_narrator`;
      const audioPath = path.join(audioDir, `${stem}.wav`);
      const metaPath = narrationAudioMetadataPath(audioPath);
      const text = scene.narrationText.trim();

      console.log(`[Scene ${sceneNum}] Generating audio for: "${text.slice(0, 50)}..."`);
      await audioGen.invoke({
        input: text,
        outputPath: audioPath,
        voice: CONFIG.groqTtsVoice,
        model: CONFIG.groqTtsModel,
        responseFormat: "wav",
      });

      const duration = await probeMediaDuration(audioPath);
      sceneDurations.set(sceneNum, duration);
      console.log(`[Scene ${sceneNum}] Duration: ${duration.toFixed(3)}s`);

      const digest = createNarrationAudioRequestDigest({
        text,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      });

      const meta: NarrationAudioMetadata = {
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: digest,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: text.length,
        spokenWordCount: countNarrationSpokenWords(text),
        durationSeconds: duration,
        durationStatus: duration <= NARRATION_MAX_AUDIO_SECONDS ? "ready" : "duration_exceeded",
      };

      await writeNarrationAudioMetadata(metaPath, meta);
    }
    console.log("All 20 scene narration WAVs & sidecars generated successfully.");

    // Step 2: Synthesize Key Art Title Audios
    console.log("\n--- Step 2: Synthesizing Key Art Title Audios ---");
    const seriesTitle = canonicalizeKeyArtTitle(series.concept_name as string, "series");
    const epTitle = canonicalizeKeyArtTitle(episode.title as string, "episode");

    const seriesKeyArt = agnesKeyArtPaths({ seriesId: 21, episodeNumber: 1, kind: "series" });
    const epKeyArt = agnesKeyArtPaths({ seriesId: 21, episodeNumber: 1, kind: "episode" });

    // Series key art audio
    console.log(`Generating series key art audio: "${seriesTitle}"`);
    await mkdir(path.dirname(seriesKeyArt.audioPath), { recursive: true });
    await audioGen.invoke({
      input: seriesTitle,
      outputPath: seriesKeyArt.audioPath,
      voice: CONFIG.groqTtsVoice,
      model: CONFIG.groqTtsModel,
      responseFormat: "wav",
    });
    const seriesTitleDuration = await probeMediaDuration(seriesKeyArt.audioPath);
    await writeNarrationAudioMetadata(seriesKeyArt.audioMetadataPath, {
      schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
      kind: NARRATION_METADATA_KIND,
      requestDigest: createNarrationAudioRequestDigest({
        text: seriesTitle,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      }),
      model: CONFIG.groqTtsModel,
      voice: CONFIG.groqTtsVoice,
      responseFormat: "wav",
      textLength: seriesTitle.length,
      spokenWordCount: countNarrationSpokenWords(seriesTitle),
      durationSeconds: seriesTitleDuration,
      durationStatus: "ready",
    });

    // Episode key art audio
    console.log(`Generating episode key art audio: "${epTitle}"`);
    await mkdir(path.dirname(epKeyArt.audioPath), { recursive: true });
    await audioGen.invoke({
      input: epTitle,
      outputPath: epKeyArt.audioPath,
      voice: CONFIG.groqTtsVoice,
      model: CONFIG.groqTtsModel,
      responseFormat: "wav",
    });
    const epTitleDuration = await probeMediaDuration(epKeyArt.audioPath);
    await writeNarrationAudioMetadata(epKeyArt.audioMetadataPath, {
      schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
      kind: NARRATION_METADATA_KIND,
      requestDigest: createNarrationAudioRequestDigest({
        text: epTitle,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      }),
      model: CONFIG.groqTtsModel,
      voice: CONFIG.groqTtsVoice,
      responseFormat: "wav",
      textLength: epTitle.length,
      spokenWordCount: countNarrationSpokenWords(epTitle),
      durationSeconds: epTitleDuration,
      durationStatus: "ready",
    });
    console.log("Key art title audios generated successfully.");

    // Step 3: Re-download and normalize scenes 4..20
    console.log("\n--- Step 3: Downloading & Normalizing Passed Scenes 4-20 ---");
    const validRowsResult = await client.execute({
      sql: "SELECT scene_number, provider_video_url, raw_output_path, normalized_output_path FROM agnes_scene_generations WHERE series_id = 21 AND episode_number = 1 AND scene_number >= 4 ORDER BY scene_number ASC",
      args: [],
    });

    for (const r of validRowsResult.rows) {
      const sceneNum = Number(r.scene_number);
      const videoUrl = String(r.provider_video_url);
      const rawPath = String(r.raw_output_path);
      const normPath = String(r.normalized_output_path);
      const targetDuration = sceneDurations.get(sceneNum);
      if (!targetDuration) throw new Error(`Missing audio duration for scene ${sceneNum}`);

      console.log(`[Scene ${sceneNum}] Downloading raw video from CDN...`);
      await downloadFile(videoUrl, rawPath);

      console.log(`[Scene ${sceneNum}] Normalizing to audio duration (${targetDuration.toFixed(3)}s)...`);
      await normalizeVideo(rawPath, normPath, targetDuration);

      await client.execute({
        sql: "UPDATE agnes_scene_generations SET download_status = 'downloaded', error = NULL WHERE series_id = 21 AND episode_number = 1 AND scene_number = ?",
        args: [sceneNum],
      });
      console.log(`[Scene ${sceneNum}] Normalized and marked downloaded.`);
    }

    // Step 4: Delete failing rows (-2, -1, 1, 2, 3) so they will be regenerated cleanly
    console.log("\n--- Step 4: Resetting the 5 Failing Assets (-2, -1, 1, 2, 3) ---");
    const delGen = await client.execute({
      sql: "DELETE FROM agnes_scene_generations WHERE series_id = 21 AND episode_number = 1 AND scene_number IN (-2, -1, 1, 2, 3)",
      args: [],
    });
    console.log(`Deleted ${delGen.rowsAffected} generation rows.`);

    await client.execute({
      sql: "DELETE FROM agnes_scene_generation_history WHERE series_id = 21 AND episode_number = 1 AND scene_number IN (-2, -1, 1, 2, 3)",
      args: [],
    }).catch(() => {});

    // Reset episode audio mutation lock
    await client.execute({
      sql: `UPDATE episodes
            SET audio_status = 'ready',
                audio_mutation_token = NULL,
                audio_mutation_scene_number = NULL,
                audio_mutation_expires_at_ms = NULL,
                status = 'audio',
                updated_at = datetime('now')
            WHERE series_id = 21 AND episode_number = 1`,
      args: [],
    });
    console.log("Episode audio locks reset.");

    // Step 5: Verify readiness
    console.log("\n--- Step 5: Verifying Audio & Next Action ---");
    await state.assertEpisodeAudioReady(Number(episode.id));
    console.log("✅ assertEpisodeAudioReady: PASS");

    await state.assertEpisodeKeyArtAudioReady(21, 1);
    console.log("✅ assertEpisodeKeyArtAudioReady: PASS");

    const tools = buildSeriesStateTools(state);
    const getNext = tools.find((t) => t.name === "get_next_episode");
    const nextResult = await getNext?.invoke({ seriesId: 21 });
    console.log("get_next_episode result:", nextResult);

  } catch (err) {
    console.error("Reconciliation failed:", err);
  } finally {
    await state.close();
  }
}

main();
