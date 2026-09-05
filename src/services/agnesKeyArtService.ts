import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { CONFIG } from "../config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  countNarrationSpokenWords,
} from "./narrationContract.js";
import { canonicalizeKeyArtTitle } from "./keyArtTitleContract.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  readNarrationAudioMetadata,
  writeNarrationAudioMetadata,
  type NarrationAudioGenerator,
  type NarrationAudioMetadata,
} from "../tools/ttsTool.js";

/** Reserved internal row keys; real script scenes are always positive. */
export const AGNES_SERIES_KEY_ART_TRACKING_SCENE = -2;
export const AGNES_EPISODE_KEY_ART_TRACKING_SCENE = -1;

export type AgnesKeyArtKind = "series" | "episode";

export interface AgnesKeyArtPaths {
  kind: AgnesKeyArtKind;
  trackingSceneNumber: number;
  directory: string;
  audioPath: string;
  audioMetadataPath: string;
  normalizedVideoPath: string;
  promptDirectory: string;
  rawDirectory: string;
  stem: string;
}

export interface AgnesKeyArtAudioAsset extends AgnesKeyArtPaths {
  text: string;
  durationSeconds: number;
  requestDigest: string;
}

export interface EnsureAgnesKeyArtAudioOptions {
  outputDir?: string;
  audioGenerator?: NarrationAudioGenerator;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  retryDelayMs?: (attempt: number) => number;
}

export function agnesKeyArtPaths(params: {
  outputDir?: string;
  seriesId: number;
  episodeNumber: number;
  kind: AgnesKeyArtKind;
}): AgnesKeyArtPaths {
  const stem = params.kind === "series" ? "series_key_art" : "episode_key_art";
  const directory = path.resolve(
    params.outputDir ?? CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
    "agnes_text",
    "key_art",
    params.kind,
  );
  const audioPath = path.join(directory, `${stem}_narrator.wav`);
  return {
    kind: params.kind,
    trackingSceneNumber: params.kind === "series"
      ? AGNES_SERIES_KEY_ART_TRACKING_SCENE
      : AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    directory,
    audioPath,
    audioMetadataPath: narrationAudioMetadataPath(audioPath),
    normalizedVideoPath: path.join(directory, `${stem}.mp4`),
    promptDirectory: path.join(directory, "prompts"),
    rawDirectory: path.join(directory, "raw"),
    stem,
  };
}

function defaultProbeDurationSeconds(filePath: string): Promise<number> {
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
      else reject(new Error(`Invalid key-art audio duration for ${filePath}: ${stderr.slice(-500)}`));
    });
  });
}

async function validAudioDuration(
  filePath: string,
  probeDurationSeconds: (filePath: string) => Promise<number>,
): Promise<number> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0) throw new Error(`Key-art audio is empty: ${filePath}`);
  const durationSeconds = await probeDurationSeconds(filePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Key-art audio has an invalid duration: ${filePath}`);
  }
  return durationSeconds;
}

let defaultAudioGenerator: NarrationAudioGenerator | undefined;

function getDefaultAudioGenerator(): NarrationAudioGenerator {
  defaultAudioGenerator ??= createAudioGenTool();
  return defaultAudioGenerator;
}

async function ensureOneAudio(params: {
  seriesId: number;
  episodeNumber: number;
  kind: AgnesKeyArtKind;
  text: string;
  options: EnsureAgnesKeyArtAudioOptions;
}): Promise<AgnesKeyArtAudioAsset> {
  const text = canonicalizeKeyArtTitle(params.text, params.kind);
  const paths = agnesKeyArtPaths({
    outputDir: params.options.outputDir,
    seriesId: params.seriesId,
    episodeNumber: params.episodeNumber,
    kind: params.kind,
  });
  const requestDigest = createNarrationAudioRequestDigest({
    text,
    model: CONFIG.groqTtsModel,
    voice: CONFIG.groqTtsVoice,
  });
  const probeDurationSeconds = params.options.probeDurationSeconds ?? defaultProbeDurationSeconds;
  await mkdir(paths.directory, { recursive: true });

  if (existsSync(paths.audioPath) && existsSync(paths.audioMetadataPath)) {
    const metadata = await readNarrationAudioMetadata(paths.audioMetadataPath);
    if (metadata?.requestDigest === requestDigest) {
      try {
        const durationSeconds = await validAudioDuration(paths.audioPath, probeDurationSeconds);
        if (Math.abs(durationSeconds - metadata.durationSeconds) <= 0.05) {
          if (metadata.durationStatus !== "ready" || durationSeconds > NARRATION_MAX_AUDIO_SECONDS) {
            throw new Error(
              `${params.kind} key-art title audio is ${durationSeconds.toFixed(3)}s; ` +
              `Agnes supports at most ${NARRATION_MAX_AUDIO_SECONDS}s. Shorten the title.`,
            );
          }
          return { ...paths, text, durationSeconds, requestDigest };
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Shorten the title")) throw error;
      }
    }
  }

  await Promise.all([
    rm(paths.audioPath, { force: true }),
    rm(paths.audioMetadataPath, { force: true }),
  ]);
  const audioGenerator = params.options.audioGenerator ?? getDefaultAudioGenerator();
  const retryDelayMs = params.options.retryDelayMs ?? ((attempt: number) => attempt * 1_000);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryPath = `${paths.audioPath}.${process.pid}.${randomUUID()}.tmp.wav`;
    try {
      await rm(temporaryPath, { force: true });
      const result = await audioGenerator.invoke({
        input: text,
        outputPath: temporaryPath,
        voice: CONFIG.groqTtsVoice,
        model: CONFIG.groqTtsModel,
        responseFormat: "wav",
      });
      if (typeof result === "string" && result.startsWith("Error generating audio:")) {
        throw new Error(result);
      }
      const durationSeconds = await validAudioDuration(temporaryPath, probeDurationSeconds);
      const durationStatus = durationSeconds <= NARRATION_MAX_AUDIO_SECONDS
        ? "ready" as const
        : "duration_exceeded" as const;
      const metadata: NarrationAudioMetadata = {
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: text.length,
        spokenWordCount: countNarrationSpokenWords(text),
        durationSeconds,
        durationStatus,
      };
      await rename(temporaryPath, paths.audioPath);
      await writeNarrationAudioMetadata(paths.audioMetadataPath, metadata);
      if (durationStatus !== "ready") {
        throw new Error(
          `${params.kind} key-art title audio is ${durationSeconds.toFixed(3)}s; ` +
          `Agnes supports at most ${NARRATION_MAX_AUDIO_SECONDS}s. Shorten the title.`,
        );
      }
      return { ...paths, text, durationSeconds, requestDigest };
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true });
      if (error instanceof Error && error.message.includes("Shorten the title")) throw error;
      if (attempt < 3) {
        const waitMs = retryDelayMs(attempt);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw new Error(`Failed to generate ${params.kind} key-art title audio: ${String(lastError)}`);
}

/** Ensures both title WAVs exist before the two matching Agnes jobs are prepared. */
export async function ensureAgnesKeyArtAudioAssets(params: {
  seriesId: number;
  episodeNumber: number;
  seriesTitle: string;
  episodeTitle: string;
  options?: EnsureAgnesKeyArtAudioOptions;
}): Promise<[AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset]> {
  const options = params.options ?? {};
  // Validate both titles before either concurrent branch can make a paid TTS
  // request. ensureOneAudio repeats this at its direct provenance boundary.
  const seriesTitle = canonicalizeKeyArtTitle(params.seriesTitle, "series");
  const episodeTitle = canonicalizeKeyArtTitle(params.episodeTitle, "episode");
  return Promise.all([
    ensureOneAudio({
      seriesId: params.seriesId,
      episodeNumber: params.episodeNumber,
      kind: "series",
      text: seriesTitle,
      options,
    }),
    ensureOneAudio({
      seriesId: params.seriesId,
      episodeNumber: params.episodeNumber,
      kind: "episode",
      text: episodeTitle,
      options,
    }),
  ]);
}
