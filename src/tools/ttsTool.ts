import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import ffmpeg from "fluent-ffmpeg";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { CONFIG } from "../config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
  inspectNarrationDuration,
  inspectNarrationText,
} from "../services/narrationContract.js";

ffmpeg.setFfprobePath(CONFIG.ffprobePath);

export const NARRATION_METADATA_SCHEMA_VERSION = 1 as const;
export const NARRATION_METADATA_KIND = "narration-audio" as const;
const NARRATION_RESPONSE_FORMAT = "wav" as const;
const AUDIO_DURATION_METADATA_TOLERANCE_SECONDS = 0.05;

export interface NarrationAudioGenerator {
  invoke(input: {
    input: string;
    outputPath: string;
    voice: string;
    model: string;
    responseFormat: typeof NARRATION_RESPONSE_FORMAT;
  }): Promise<unknown>;
}

export interface NarrationAudioMetadata {
  schemaVersion: typeof NARRATION_METADATA_SCHEMA_VERSION;
  kind: typeof NARRATION_METADATA_KIND;
  requestDigest: string;
  model: string;
  voice: string;
  responseFormat: typeof NARRATION_RESPONSE_FORMAT;
  textLength: number;
  spokenWordCount: number;
  durationSeconds: number;
  durationStatus: "ready" | "duration_exceeded";
}

export interface TtsToolOptions {
  audioGenerator?: NarrationAudioGenerator;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  outputDir?: string;
  /** Test hook; production retains the existing one/two-second outer retry delays. */
  retryDelayMs?: (attempt: number) => number;
}

/** Stable sidecar path used to prove that a WAV belongs to the current narration request. */
export function narrationAudioMetadataPath(audioPath: string): string {
  const extension = path.extname(audioPath);
  return extension
    ? `${audioPath.slice(0, -extension.length)}.metadata.json`
    : `${audioPath}.metadata.json`;
}

/**
 * Fingerprints every input that can change the generated speech. Output paths
 * and scene numbers are deliberately excluded so identical generation inputs
 * have one stable identity.
 */
export function createNarrationAudioRequestDigest(params: {
  text: string;
  model: string;
  voice: string;
  responseFormat?: typeof NARRATION_RESPONSE_FORMAT;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
    text: params.text,
    model: params.model,
    voice: params.voice,
    responseFormat: params.responseFormat ?? NARRATION_RESPONSE_FORMAT,
  })).digest("hex");
}

/** Probes an audio file's duration in seconds via ffprobe. */
function defaultProbeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

/** Validates that an audio file exists, is non-empty, and has a usable duration. */
async function validateAudioOutput(
  filePath: string,
  probeDurationSeconds: (filePath: string) => Promise<number>,
): Promise<number> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size === 0) throw new Error(`Audio output is empty or not a file: ${filePath}`);
  const durationSeconds = await probeDurationSeconds(filePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Audio output has invalid duration: ${filePath}`);
  }
  return durationSeconds;
}

function isNarrationAudioMetadata(value: unknown): value is NarrationAudioMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === NARRATION_METADATA_SCHEMA_VERSION
    && item.kind === NARRATION_METADATA_KIND
    && typeof item.requestDigest === "string"
    && /^[a-f0-9]{64}$/u.test(item.requestDigest)
    && typeof item.model === "string"
    && typeof item.voice === "string"
    && item.responseFormat === NARRATION_RESPONSE_FORMAT
    && Number.isSafeInteger(item.textLength)
    && Number(item.textLength) >= 0
    && Number.isSafeInteger(item.spokenWordCount)
    && Number(item.spokenWordCount) >= 0
    && typeof item.durationSeconds === "number"
    && Number.isFinite(item.durationSeconds)
    && item.durationSeconds > 0
    && (item.durationStatus === "ready" || item.durationStatus === "duration_exceeded");
}

export async function readNarrationAudioMetadata(metadataPath: string): Promise<NarrationAudioMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    return isNarrationAudioMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeNarrationAudioMetadata(
  metadataPath: string,
  metadata: NarrationAudioMetadata,
): Promise<void> {
  const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(metadataPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function resultForAudio(params: {
  audioPath: string;
  metadataPath: string;
  metadata: NarrationAudioMetadata;
  reused: boolean;
  attempt?: number;
}): string {
  const durationInspection = inspectNarrationDuration(params.metadata.durationSeconds);
  if (params.metadata.durationStatus !== "ready" || !durationInspection.pass) {
    return JSON.stringify({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: params.reused,
      rejectedPath: params.audioPath,
      metadataPath: params.metadataPath,
      requestDigest: params.metadata.requestDigest,
      durationSeconds: params.metadata.durationSeconds,
      maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
      textLength: params.metadata.textLength,
      spokenWordCount: params.metadata.spokenWordCount,
      needsScriptSplit: true,
      error: durationInspection.message ??
        `Narration metadata marks this artifact as ${params.metadata.durationStatus}; split the script scene and regenerate it.`,
    });
  }

  return JSON.stringify({
    status: params.reused
      ? "already_generated"
      : params.attempt === 1 ? "generated" : "generated_after_retry",
    readyForAgnes: true,
    reused: params.reused,
    path: params.audioPath,
    metadataPath: params.metadataPath,
    requestDigest: params.metadata.requestDigest,
    durationSeconds: params.metadata.durationSeconds,
    maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
    textLength: params.metadata.textLength,
    spokenWordCount: params.metadata.spokenWordCount,
  });
}

/**
 * Synthesizes exactly one bounded narration request for one script scene.
 * Long narration is rejected before Groq instead of being concatenated into a
 * scene that Agnes would have to render as two unrelated clips.
 */
export function buildTtsTool(options: TtsToolOptions = {}): DynamicStructuredTool {
  const audioGenerator = options.audioGenerator ?? createAudioGenTool();
  const probeDurationSeconds = options.probeDurationSeconds ?? defaultProbeDurationSeconds;
  const outputDir = path.resolve(options.outputDir ?? CONFIG.outputDir);
  const retryDelayMs = options.retryDelayMs ?? ((attempt: number) => attempt * 1_000);

  return new DynamicStructuredTool({
    name: "synthesize_narration_audio",
    description:
      "Converts exactly one scene's bounded narration into exactly one Groq TTS request using the fixed " +
      "episode narrator. The input must be non-empty, no more than " +
      `${NARRATION_MAX_RAW_CHARACTERS} raw characters, and no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words. ` +
      `The measured WAV must be no longer than ${NARRATION_MAX_AUDIO_SECONDS} seconds. ` +
      "A duration_exceeded result requires splitting the script scene; do not retry or concatenate it. " +
      "Vocal directions and punctuation are preserved.",
    schema: z.object({
      seriesId: z.number().int().positive().describe("Series ID as a positive integer"),
      episodeNumber: z.number().int().positive().describe("Episode number as a positive integer"),
      sceneNumber: z.number().int().positive().describe("Scene number as a positive integer"),
      text: z.string().trim().min(1).max(NARRATION_MAX_RAW_CHARACTERS).describe(
        `The exact narration for one scene, at most ${NARRATION_MAX_RAW_CHARACTERS} raw characters and ${NARRATION_MAX_SPOKEN_WORDS} spoken words.`,
      ),
    }),
    func: async ({ seriesId, episodeNumber, sceneNumber, text }) => {
      if (![seriesId, episodeNumber, sceneNumber].every((value) => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("seriesId, episodeNumber, and sceneNumber must be positive integers.");
      }

      const narrationText = text.trim();
      const textInspection = inspectNarrationText(narrationText, { production: true });
      if (!textInspection.pass) {
        throw new Error(
          `Scene ${sceneNumber} narration violates the one-scene contract: ` +
          textInspection.issues.map((issue) => issue.message).join(" "),
        );
      }

      const destDir = path.join(outputDir, `series_${seriesId}`, `episode_${episodeNumber}`, "audio");
      const finalPath = path.join(destDir, `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`);
      const metadataPath = narrationAudioMetadataPath(finalPath);
      const requestDigest = createNarrationAudioRequestDigest({
        text: narrationText,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      });
      await mkdir(destDir, { recursive: true });

      if (existsSync(finalPath) && existsSync(metadataPath)) {
        const metadata = await readNarrationAudioMetadata(metadataPath);
        if (metadata?.requestDigest === requestDigest) {
          try {
            const durationSeconds = await validateAudioOutput(finalPath, probeDurationSeconds);
            if (Math.abs(durationSeconds - metadata.durationSeconds) <= AUDIO_DURATION_METADATA_TOLERANCE_SECONDS) {
              return resultForAudio({
                audioPath: finalPath,
                metadataPath,
                metadata: { ...metadata, durationSeconds },
                reused: true,
              });
            }
          } catch {
            // Invalid/missing media falls through to safe regeneration below.
          }
        }
      }

      // A WAV without matching provenance is unsafe after scene splitting or
      // renumbering. Remove both files before replacing them atomically enough
      // for the next run to either reuse the pair or regenerate it.
      await Promise.all([
        rm(finalPath, { force: true }),
        rm(metadataPath, { force: true }),
      ]);

      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await rm(finalPath, { force: true });
          const result = await audioGenerator.invoke({
            input: narrationText,
            outputPath: finalPath,
            voice: CONFIG.groqTtsVoice,
            model: CONFIG.groqTtsModel,
            responseFormat: NARRATION_RESPONSE_FORMAT,
          });
          if (typeof result === "string" && result.startsWith("Error generating audio:")) {
            throw new Error(result);
          }

          const durationSeconds = await validateAudioOutput(finalPath, probeDurationSeconds);
          const durationStatus = inspectNarrationDuration(durationSeconds).pass
            ? "ready" as const
            : "duration_exceeded" as const;
          const metadata: NarrationAudioMetadata = {
            schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
            kind: NARRATION_METADATA_KIND,
            requestDigest,
            model: CONFIG.groqTtsModel,
            voice: CONFIG.groqTtsVoice,
            responseFormat: NARRATION_RESPONSE_FORMAT,
            textLength: narrationText.length,
            spokenWordCount: textInspection.spokenWordCount,
            durationSeconds,
            durationStatus,
          };
          await writeNarrationAudioMetadata(metadataPath, metadata);
          return resultForAudio({
            audioPath: finalPath,
            metadataPath,
            metadata,
            reused: false,
            attempt,
          });
        } catch (error) {
          lastError = error;
          await Promise.all([
            rm(finalPath, { force: true }),
            rm(metadataPath, { force: true }),
          ]);
          if (attempt < 3) {
            const delayMs = retryDelayMs(attempt);
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      throw new Error(`Audio generation failed after 3 attempts for scene ${sceneNumber}: ${String(lastError)}`);
    },
  });
}
