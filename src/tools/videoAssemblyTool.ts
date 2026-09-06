import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import { CONFIG } from "../config.js";
import type { SeriesState } from "../state/seriesState.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
  type AgnesKeyArtKind,
} from "../services/agnesKeyArtService.js";
import { canonicalizeKeyArtTitle } from "../services/keyArtTitleContract.js";
import {
  createNarrationAudioRequestDigest,
  readNarrationAudioMetadata,
} from "./ttsTool.js";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { startTimer, endTimer, logVideoAssembled, logTimingSummary, logStep } from "../utils/logger.js";

ffmpeg.setFfprobePath(CONFIG.ffprobePath);

const OUTPUT_FPS = 30;
const VIDEO_DURATION_TOLERANCE_SECONDS = (1 / OUTPUT_FPS) + 0.005;
/**
 * Once each encoded clip's bounded frame rounding has been measured, the final
 * concat/mux may still differ by one AAC packet/edit-list and one video frame.
 * Anything larger than 150 ms beyond that measured clip timeline indicates
 * missing, duplicated, or appended material.
 */
export const FINAL_DURATION_TOLERANCE_SECONDS = 0.15;

/** Gets the duration of an audio or video file in seconds using ffprobe. */
function getMediaDuration(mediaPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      mediaPath,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
          reject(new Error(`Invalid duration from ffprobe: ${stdout}`));
        } else {
          resolve(duration);
        }
      } else {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function requireNonEmptyFile(filePath: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`${label} is empty or is not a file: ${filePath}`);
  }
}

function buildSubtitleFilter(filePath: string): string {
  const normalizedPath = path.resolve(filePath).replaceAll("\\", "/");
  const escapedPath = normalizedPath
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `subtitles='${escapedPath}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,MarginV=35,Alignment=2'`;
}

function parseSrtTimestamp(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1_000;
}

function formatSrtTimestamp(totalSeconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(totalSeconds * 1_000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

async function createOffsetCaptions(
  sourcePath: string,
  destinationPath: string,
  offsetSeconds: number,
): Promise<string> {
  if (offsetSeconds <= 0) return sourcePath;
  const content = await readFile(sourcePath, "utf8");
  const shifted = content.replace(
    /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/gu,
    (_match, start: string, end: string) => (
      `${formatSrtTimestamp(parseSrtTimestamp(start) + offsetSeconds)} --> ` +
      formatSrtTimestamp(parseSrtTimestamp(end) + offsetSeconds)
    ),
  );
  await writeFile(destinationPath, shifted, "utf8");
  return destinationPath;
}

function resolveSceneAssetPath(params: {
  providedPath: string;
  seriesId: number;
  episodeNumber: number;
  sceneNumber: number;
}): string {
  const providedPath = path.resolve(params.providedPath);
  const fileName = `scene_${String(params.sceneNumber).padStart(3, "0")}_narrator.wav`;
  const canonicalPath = path.resolve(
    CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
    "audio",
    fileName
  );
  if (providedPath !== canonicalPath) {
    throw new Error(
      `Scene ${params.sceneNumber} narration must use its canonical exact-text WAV: ${canonicalPath}. ` +
      `Received: ${providedPath}`
    );
  }
  if (existsSync(canonicalPath)) return canonicalPath;

  throw new Error(
    `Missing narration audio for scene ${params.sceneNumber}. ` +
    `Provided path: ${params.providedPath}; resolved path: ${providedPath}; ` +
    `canonical path checked: ${canonicalPath}`
  );
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.ffmpegPath, ["-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/** The fixed subscribe/outro text spoken at the end of every episode. */
const OUTRO_SUBSCRIBE_TEXT = "Tap the like button or subscribe for more content, made just for you..";

/** Lazily initialized so previews that omit the outro do not initialize audio generation. */
let outroAudioGenTool: ReturnType<typeof createAudioGenTool> | undefined;

function getOutroAudioGenTool(): ReturnType<typeof createAudioGenTool> {
  outroAudioGenTool ??= createAudioGenTool();
  return outroAudioGenTool;
}

/**
 * Probes an audio file's duration in seconds via ffprobe (fluent-ffmpeg).
 * Used by ensureOutroAudio to measure generated audio length.
 */
function probeOutroDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

/**
 * Ensures the shared outro subscribe audio exists at output/shared/outro_subscribe.wav.
 * Generated once via TTS and reused across all episodes and all series.
 * Returns { audioPath, durationSeconds }.
 */
async function ensureOutroAudio(): Promise<{ audioPath: string; durationSeconds: number }> {
  const sharedDir = path.join(CONFIG.outputDir, "shared");
  await mkdir(sharedDir, { recursive: true });
  const audioPath = path.join(sharedDir, "outro_subscribe.wav");

  // Reuse existing audio if valid
  if (existsSync(audioPath)) {
    try {
      const fileStat = await stat(audioPath);
      if (fileStat.size > 0) {
        const duration = await probeOutroDuration(audioPath);
        if (Number.isFinite(duration) && duration > 0) {
          logStep(`Reusing existing outro audio: ${audioPath} (${duration.toFixed(1)}s)`);
          return { audioPath, durationSeconds: duration };
        }
      }
    } catch {
      await rm(audioPath, { force: true });
    }
  }

  // Generate TTS audio with retry
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rm(audioPath, { force: true });
      const result = await getOutroAudioGenTool().invoke({
        input: OUTRO_SUBSCRIBE_TEXT,
        outputPath: audioPath,
        voice: CONFIG.groqTtsVoice,
        model: CONFIG.groqTtsModel,
        responseFormat: "wav",
      });
      if (typeof result === "string" && result.startsWith("Error generating audio:")) {
        throw new Error(result);
      }
      const fileStat = await stat(audioPath);
      if (fileStat.size === 0) throw new Error("Outro audio output is empty");
      const duration = await probeOutroDuration(audioPath);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Outro audio has invalid duration");
      }
      logStep(`Outro subscribe audio generated: ${audioPath} (${duration.toFixed(1)}s)`);
      return { audioPath, durationSeconds: duration };
    } catch (error) {
      lastError = error;
      await rm(audioPath, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`Outro audio generation failed after 3 attempts: ${String(lastError)}`);
}

let sharedOutroAudio: Promise<{ audioPath: string; durationSeconds: number }> | undefined;

/** Prevent concurrent episode assemblies from racing on one shared WAV. */
function ensureSharedOutroAudio(): Promise<{ audioPath: string; durationSeconds: number }> {
  if (!sharedOutroAudio) {
    sharedOutroAudio = ensureOutroAudio().catch((error) => {
      sharedOutroAudio = undefined;
      throw error;
    });
  }
  return sharedOutroAudio;
}

interface SceneInput {
  sceneNumber: number;
  narrationAudioPath: string;
  sfxPath?: string | null;
}

export interface VideoAssemblyToolOptions {
  /** Internal override for isolated previews; normal episode assembly keeps its canonical filename. */
  outputPath?: string;
  /** Internal override that prevents preview work from colliding with a full assembly. */
  workDir?: string;
  /** Defaults to true for normal episodes. Focused evaluation previews can omit the subscribe outro. */
  includeOutro?: boolean;
  /** Production prepends the series and episode Agnes key-art clips. */
  includeKeyArt?: boolean;
}

interface PreparedSceneInput extends SceneInput {
  visualPath: string;
  resolvedNarrationAudioPath: string;
  resolvedSfxPath: string | null;
  measuredDurationSeconds: number;
}

interface PreparedKeyArtInput {
  kind: AgnesKeyArtKind;
  visualPath: string;
  audioPath: string;
  measuredDurationSeconds: number;
}

function parseEpisodeSceneNumbers(scriptJson: unknown): number[] {
  let root = scriptJson;
  if (typeof root === "string") {
    try { root = JSON.parse(root) as unknown; } catch { root = null; }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Episode script_json is missing or invalid; assembly cannot verify its scene manifest.");
  }
  let scenes = (root as Record<string, unknown>).scenes;
  if (typeof scenes === "string") {
    try { scenes = JSON.parse(scenes) as unknown; } catch { scenes = null; }
  }
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Episode script_json has no scenes; assembly cannot continue.");
  }
  const numbers = scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new Error(`Episode script scene ${index + 1} is invalid.`);
    }
    const sceneNumber = Number((scene as Record<string, unknown>).sceneNumber ?? index + 1);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) {
      throw new Error(`Episode script scene ${index + 1} has an invalid sceneNumber.`);
    }
    return sceneNumber;
  });
  if (new Set(numbers).size !== numbers.length) {
    throw new Error("Episode script contains duplicate scene numbers.");
  }
  return numbers;
}

function safeVideoFileStem(seriesTitle: string): string {
  const sanitized = seriesTitle
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .replace(/_+/g, "_");
  if (!sanitized) throw new Error("seriesTitle does not contain a safe filename character.");
  return sanitized;
}

const sceneInputSchema = z.object({
  sceneNumber: z.number().int().positive(),
  narrationAudioPath: z.string().min(1),
  sfxPath: z.string().nullable().optional(),
});

const scenesInputSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z.array(sceneInputSchema).min(1)
);

/**
 * Deep-agent tool: assembles the full episode from canonical, normalized Agnes
 * text-to-video scene MP4s plus per-scene narration audio, optional sfx/music,
 * and optional burned-in captions. Each scene MP4 is revalidated against the
 * measured narration duration before it is joined in persisted script order.
 */
export function buildVideoAssemblyTool(
  seriesState?: SeriesState,
  options: VideoAssemblyToolOptions = {},
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "assemble_episode_video",
    description:
      "Prepends the canonical series and episode Agnes key-art videos, then combines all canonical scene MP4s with their matching Groq audio, " +
      "optional sound effects/background music, and captions.srt via ffmpeg. Call once after every " +
      "required key-art and scene video has completed and been exact-duration normalized. No still images or alternate visual variants are accepted.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      seriesTitle: z.string().min(1).describe("Series title (used for video filename; spaces will be converted to underscores)."),
      episodeNumber: z.number().int().positive(),
      scenes: scenesInputSchema.describe(
        "Scenes in playback order as an array of scene objects. A JSON-encoded array string is also accepted and normalized."
      ),
      musicPath: z.string().nullable().optional().describe("Optional single background-music track for the whole episode."),
      captionsSrtPath: z.string().nullable().optional(),
      burnSubtitles: z.boolean().default(CONFIG.burnSubtitles ?? false).describe("Whether to burn subtitles directly into video frames. Defaults to CONFIG.burnSubtitles (false)."),
    }),
    func: async ({
      seriesId,
      seriesTitle,
      episodeNumber,
      scenes,
      musicPath,
      captionsSrtPath,
      burnSubtitles = CONFIG.burnSubtitles,
    }: {
      seriesId: number;
      seriesTitle: string;
      episodeNumber: number;
      scenes: SceneInput[];
      musicPath?: string | null;
      captionsSrtPath?: string | null;
      burnSubtitles?: boolean;
    }) => {
      const outputVariant = "agnes_text" as const;
      const timerName = `video_assembly_episode_${episodeNumber}_${outputVariant}`;
      startTimer(timerName);

      const episodeDir = path.resolve(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`);
      const workDir = options.workDir
        ? path.resolve(options.workDir)
        : path.join(episodeDir, `work_${outputVariant}`);
      const videoFileName = `${safeVideoFileStem(seriesTitle)}_episode_${episodeNumber}_${outputVariant}.mp4`;
      const finalPath = options.outputPath
        ? path.resolve(options.outputPath)
        : path.join(episodeDir, videoFileName);
      // Keep the candidate beside the destination so rename() is an atomic
      // publication on the same filesystem. A failed rerun must never truncate
      // a previously completed canonical episode.
      const temporaryFinalPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp.mp4`;

      try {
        await rm(temporaryFinalPath, { force: true });
        if (seriesState) {
          await seriesState.upsertEpisodeVideoOutput({
            seriesId,
            episodeNumber,
            variant: outputVariant,
            status: "pending",
            outputPath: null,
            durationSeconds: null,
            error: null,
            completedAt: null,
          });
        }

        const suppliedSceneNumbers = scenes.map((scene) => scene.sceneNumber);
        if (suppliedSceneNumbers.length === 0 || new Set(suppliedSceneNumbers).size !== suppliedSceneNumbers.length) {
          throw new Error("Assembly requires a non-empty scene list with unique scene numbers.");
        }

        let persistedAgnesRows: Awaited<ReturnType<SeriesState["listAgnesSceneGenerations"]>> = [];
        let persistedEpisode: Awaited<ReturnType<SeriesState["getEpisodeByNumber"]>> = null;
        if (seriesState) {
          persistedEpisode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
          if (!persistedEpisode) throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
          await seriesState.assertEpisodeAudioReady(persistedEpisode.id);
          const expectedSceneNumbers = parseEpisodeSceneNumbers(persistedEpisode.scriptJson);
          const exactManifest = expectedSceneNumbers.length === suppliedSceneNumbers.length &&
            expectedSceneNumbers.every((sceneNumber, index) => sceneNumber === suppliedSceneNumbers[index]);
          if (!exactManifest) {
            throw new Error(
              `Assembly scene manifest does not match persisted script order. ` +
              `Expected [${expectedSceneNumbers.join(", ")}], received [${suppliedSceneNumbers.join(", ")}].`
            );
          }
          persistedAgnesRows = await seriesState.listAgnesSceneGenerations(
            seriesId,
            episodeNumber,
            "text"
          );
        }

        const preparedKeyArt: PreparedKeyArtInput[] = [];
        if (options.includeKeyArt) {
          if (!seriesState || !persistedEpisode) {
            throw new Error("Key-art assembly requires durable series state.");
          }
          const seriesInfo = await seriesState.getSeriesInfo(seriesId);
          if (!seriesInfo) throw new Error(`Series ${seriesId} was not found while assembling key art.`);
          const specs: Array<{
            kind: AgnesKeyArtKind;
            title: string;
            trackingSceneNumber: number;
          }> = [
            {
              kind: "series",
              title: canonicalizeKeyArtTitle(seriesInfo.conceptName, "series"),
              trackingSceneNumber: AGNES_SERIES_KEY_ART_TRACKING_SCENE,
            },
            {
              kind: "episode",
              title: canonicalizeKeyArtTitle(persistedEpisode.title, "episode"),
              trackingSceneNumber: AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
            },
          ];
          for (const spec of specs) {
            const paths = agnesKeyArtPaths({
              seriesId,
              episodeNumber,
              kind: spec.kind,
            });
            await requireNonEmptyFile(paths.audioPath, `${spec.kind} key-art audio`);
            await requireNonEmptyFile(paths.normalizedVideoPath, `${spec.kind} key-art video`);
            const audioDuration = await getMediaDuration(paths.audioPath);
            const metadata = await readNarrationAudioMetadata(paths.audioMetadataPath);
            const expectedAudioDigest = createNarrationAudioRequestDigest({
              text: spec.title,
              model: CONFIG.groqTtsModel,
              voice: CONFIG.groqTtsVoice,
            });
            if (
              !metadata
              || metadata.requestDigest !== expectedAudioDigest
              || metadata.durationStatus !== "ready"
              || Math.abs(metadata.durationSeconds - audioDuration) > 0.05
            ) {
              throw new Error(`${spec.kind} key-art audio metadata is missing, stale, or belongs to a different title.`);
            }
            const row = persistedAgnesRows.find(
              (entry) => entry.sceneNumber === spec.trackingSceneNumber && entry.variant === "text",
            );
            if (!row || row.status !== "completed" || row.downloadStatus !== "downloaded") {
              throw new Error(`${spec.kind} key-art Agnes video is not completed in Turso.`);
            }
            if (
              !row.normalizedOutputPath
              || path.resolve(row.normalizedOutputPath) !== path.resolve(paths.normalizedVideoPath)
            ) {
              throw new Error(`${spec.kind} key-art Agnes row does not reference its canonical normalized file.`);
            }
            const visualDuration = await getMediaDuration(paths.normalizedVideoPath);
            if (
              Math.abs(visualDuration - audioDuration) > VIDEO_DURATION_TOLERANCE_SECONDS
              || Math.abs(row.requestedDurationSeconds - audioDuration) > VIDEO_DURATION_TOLERANCE_SECONDS
            ) {
              throw new Error(
                `${spec.kind} key-art video duration (${visualDuration.toFixed(3)}s) does not match ` +
                `its title audio (${audioDuration.toFixed(3)}s).`,
              );
            }
            preparedKeyArt.push({
              kind: spec.kind,
              visualPath: paths.normalizedVideoPath,
              audioPath: paths.audioPath,
              measuredDurationSeconds: audioDuration,
            });
          }
        }

        const preparedScenes: PreparedSceneInput[] = [];
        for (const scene of scenes) {
          const sceneStem = `scene_${String(scene.sceneNumber).padStart(3, "0")}`;
          const canonicalVisualPath = path.join(
            episodeDir,
            "agnes_text",
            "scenes",
            `${sceneStem}.mp4`
          );
          if (!existsSync(canonicalVisualPath)) {
            throw new Error(
              `Missing canonical Agnes text video for scene ${scene.sceneNumber}: ${canonicalVisualPath}`
            );
          }

          const narrationAudioPath = resolveSceneAssetPath({
            providedPath: scene.narrationAudioPath,
            seriesId,
            episodeNumber,
            sceneNumber: scene.sceneNumber,
          });
          const measuredDurationSeconds = await getMediaDuration(narrationAudioPath);
          const sfxPath = scene.sfxPath ? path.resolve(scene.sfxPath) : null;
          if (sfxPath && !existsSync(sfxPath)) {
            throw new Error(`Missing sound-effect asset for scene ${scene.sceneNumber}: ${sfxPath}`);
          }

          if (seriesState) {
            const row = persistedAgnesRows.find((entry) => entry.sceneNumber === scene.sceneNumber);
            if (!row || row.status !== "completed" || row.downloadStatus !== "downloaded") {
              throw new Error(`Agnes text scene ${scene.sceneNumber} is not completed in Turso.`);
            }
            if (!row.normalizedOutputPath || path.resolve(row.normalizedOutputPath) !== canonicalVisualPath) {
              throw new Error(
                `Agnes text scene ${scene.sceneNumber} does not point to its canonical normalized file.`
              );
            }
            if (Math.abs(row.requestedDurationSeconds - measuredDurationSeconds) > VIDEO_DURATION_TOLERANCE_SECONDS) {
              throw new Error(
                `Agnes text scene ${scene.sceneNumber} was generated for ` +
                `${row.requestedDurationSeconds.toFixed(3)}s, but narration is ${measuredDurationSeconds.toFixed(3)}s.`
              );
            }
          }
          const visualDuration = await getMediaDuration(canonicalVisualPath);
          if (Math.abs(visualDuration - measuredDurationSeconds) > VIDEO_DURATION_TOLERANCE_SECONDS) {
            throw new Error(
              `Agnes text scene ${scene.sceneNumber} duration ` +
              `(${visualDuration.toFixed(3)}s) does not match narration (${measuredDurationSeconds.toFixed(3)}s).`
            );
          }

          preparedScenes.push({
            ...scene,
            visualPath: canonicalVisualPath,
            resolvedNarrationAudioPath: narrationAudioPath,
            resolvedSfxPath: sfxPath,
            measuredDurationSeconds,
          });
        }

        await Promise.all([
          mkdir(workDir, { recursive: true }),
          mkdir(path.dirname(finalPath), { recursive: true }),
        ]);

        const clipPaths: string[] = [];
        let outroDurationSeconds = 0;
        let encodedClipTimelineSeconds = 0;

        // 1a. The two key-art videos are real synchronized clips, not still
        //     images or frozen padding. Their fixed order is series, episode.
        for (const keyArt of preparedKeyArt) {
          const clipDuration = keyArt.measuredDurationSeconds;
          const clipPath = path.join(workDir, `${keyArt.kind}_key_art.mp4`);
          await runFfmpeg([
            "-i", keyArt.visualPath,
            "-i", keyArt.audioPath,
            "-filter_complex",
            `[0:v]fps=${OUTPUT_FPS},scale=1920:1080:force_original_aspect_ratio=decrease,` +
              `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
              `trim=start=0:duration=${clipDuration},setpts=PTS-STARTPTS,format=yuv420p[vout];` +
              "[1:a]anull[aout]",
            "-map", "[vout]",
            "-map", "[aout]",
            "-t", String(clipDuration),
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-video_track_timescale", "90000",
            clipPath,
          ]);
          const renderedClipDuration = await getMediaDuration(clipPath);
          if (Math.abs(renderedClipDuration - clipDuration) > VIDEO_DURATION_TOLERANCE_SECONDS) {
            throw new Error(
              `Encoded ${keyArt.kind} key-art duration (${renderedClipDuration.toFixed(3)}s) ` +
              `does not match title audio (${clipDuration.toFixed(3)}s).`,
            );
          }
          encodedClipTimelineSeconds += renderedClipDuration;
          clipPaths.push(clipPath);
        }

        // 1b. Per-scene clip: use the normalized Agnes scene exactly once for
        //    exactly the narration duration, muxed with narration and optional sfx.
        for (const sceneIdx of preparedScenes.keys()) {
        const scene = preparedScenes[sceneIdx];
        const clipPath = path.join(workDir, `clip_${String(scene.sceneNumber).padStart(3, "0")}.mp4`);
        const visualPath = scene.visualPath;
        const narrationAudioPath = scene.resolvedNarrationAudioPath;
        const sfxPath = scene.resolvedSfxPath;

        const clipDuration = scene.measuredDurationSeconds;

        const inputs = ["-i", visualPath, "-i", narrationAudioPath];
        let audioFilter = "[1:a]anull[aout]";

        if (sfxPath) {
          inputs.push("-i", sfxPath);
          audioFilter = "[1:a][2:a]amix=inputs=2:duration=first:weights=1 0.3[aout]";
        }

        await runFfmpeg([
          ...inputs,
          "-filter_complex",
          `[0:v]fps=${OUTPUT_FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
            `trim=start=0:duration=${clipDuration},setpts=PTS-STARTPTS,format=yuv420p[vout];${audioFilter}`,
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          "-t",
          String(clipDuration),
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-video_track_timescale",
          "90000",
          clipPath,
        ]);
        const renderedClipDuration = await getMediaDuration(clipPath);
        if (Math.abs(renderedClipDuration - clipDuration) > VIDEO_DURATION_TOLERANCE_SECONDS) {
          throw new Error(
            `Encoded scene ${scene.sceneNumber} duration (${renderedClipDuration.toFixed(3)}s) ` +
            `does not match narration (${clipDuration.toFixed(3)}s).`
          );
        }
        encodedClipTimelineSeconds += renderedClipDuration;
        clipPaths.push(clipPath);
        }

      // 1c. Create outro subscribe clip for normal full episodes. Focused
      //     evaluation previews disable this to use only already-generated audio.
        if (options.includeOutro !== false) {
        try {
          const { audioPath: outroAudioPath, durationSeconds: outroDuration } = await ensureSharedOutroAudio();
          outroDurationSeconds = outroDuration;
          const outroClipPath = path.join(workDir, "outro_subscribe.mp4");
          const finalSceneVideoPath = preparedScenes.at(-1)!.visualPath;
          logStep(
            `Creating outro subscribe clip (${outroDuration.toFixed(1)}s) by holding the final Agnes scene frame`
          );
          await runFfmpeg([
            // Seek close to the end, select the first decoded frame, then hold it
            // for the complete outro. This avoids creating a separate still image.
            "-sseof", "-0.1",
            "-i", finalSceneVideoPath,
            "-i", outroAudioPath,
            "-filter_complex",
            `[0:v]select=eq(n\\,0),setpts=PTS-STARTPTS,` +
              `scale=1920:1080:force_original_aspect_ratio=decrease,` +
              `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
              `tpad=stop_mode=clone:stop_duration=${outroDuration},` +
              `trim=start=0:duration=${outroDuration},setpts=PTS-STARTPTS,format=yuv420p[vout];` +
              `[1:a]anull[aout]`,
            "-map", "[vout]",
            "-map", "[aout]",
            "-t", String(outroDuration),
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-video_track_timescale", "90000",
            outroClipPath,
          ]);
          const renderedOutroDuration = await getMediaDuration(outroClipPath);
          if (Math.abs(renderedOutroDuration - outroDuration) > VIDEO_DURATION_TOLERANCE_SECONDS) {
            throw new Error(
              `Encoded outro duration (${renderedOutroDuration.toFixed(3)}s) does not match ` +
              `its narration (${outroDuration.toFixed(3)}s).`
            );
          }
          encodedClipTimelineSeconds += renderedOutroDuration;
          clipPaths.push(outroClipPath);
          logStep("Outro subscribe clip appended using the held final Agnes scene frame");
        } catch (outroError) {
          const message = outroError instanceof Error ? outroError.message : String(outroError);
          logStep(`Outro subscribe clip creation failed: ${message}`);
          throw outroError;
        }
        }

      // 2. Concatenate the ordered scene clips exactly once with clean hard
      //    cuts. There is deliberately no crossfade, overlap, frozen-frame
      //    transition, or other inter-scene padding that could desynchronize
      //    the canonical one-WAV/one-clip pairs.
      const concatListPath = path.join(workDir, "concat_list.txt");
      const concatEntries = clipPaths.map((clipPath) => {
        const portablePath = path.resolve(clipPath).replaceAll("\\", "/").replaceAll("'", "'\\''");
        return `file '${portablePath}'`;
      });
      // ffmpeg concat demuxer requires a trailing newline after the last entry
      await writeFile(concatListPath, concatEntries.join("\n") + "\n", "utf8");

      const concatenatedPath = path.join(workDir, "concatenated.mp4");
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", concatenatedPath]);

      // 3. Mix in background music (looped/trimmed to episode length, low volume) if provided.
      let withMusicPath = concatenatedPath;
      // Validate musicPath: reject invalid string values like "None", "null", "undefined"
      const validMusicPath = musicPath &&
        musicPath !== "None" &&
        musicPath !== "null" &&
        musicPath !== "undefined" &&
        existsSync(musicPath);

      if (validMusicPath) {
        withMusicPath = path.join(workDir, "with_music.mp4");
        await runFfmpeg([
          "-i",
          concatenatedPath,
          "-stream_loop",
          "-1",
          "-i",
          musicPath,
          "-filter_complex",
          "[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.25[aout]",
          "-map",
          "0:v",
          "-map",
          "[aout]",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-shortest",
          withMusicPath,
        ]);
      } else if (musicPath && musicPath !== "None" && musicPath !== "null" && musicPath !== "undefined") {
        console.warn(`[VideoAssembly] Background music file not found: ${musicPath}, skipping music track`);
      }

      // 4. Burn in captions directly onto video frames if burnSubtitles is enabled (defaults to false).
      // When false, video frames remain clean and YouTube relies on auto-captions / closed captions (CC).
      let captionsEmbedded = false;
      let assemblyWarning: string | undefined;
      const keyArtDurationSeconds = preparedKeyArt.reduce(
        (sum, item) => sum + item.measuredDurationSeconds,
        0,
      );
      let effectiveCaptionsPath = captionsSrtPath ?? null;
      if (burnSubtitles && effectiveCaptionsPath && existsSync(effectiveCaptionsPath) && keyArtDurationSeconds > 0) {
        effectiveCaptionsPath = await createOffsetCaptions(
          effectiveCaptionsPath,
          path.join(workDir, "captions_with_key_art_offset.srt"),
          keyArtDurationSeconds,
        );
      }
      const shouldBurnCaptions = burnSubtitles && Boolean(effectiveCaptionsPath && existsSync(effectiveCaptionsPath));

      if (shouldBurnCaptions) {
        try {
          logStep("Burning in captions onto video frames (visible by default on YouTube and all players)");
          await runFfmpeg([
            "-i",
            withMusicPath,
            "-vf",
            buildSubtitleFilter(effectiveCaptionsPath!),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-video_track_timescale",
            "90000",
            temporaryFinalPath,
          ]);
          captionsEmbedded = true;
          logStep("✅ Subtitles successfully burned into video frames");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logStep(`Caption burn-in failed: ${message}`);
          assemblyWarning = `Captions could not be burned in (${message}); video created without burned-in captions.`;
          await rm(temporaryFinalPath, { force: true });
          await runFfmpeg(["-i", withMusicPath, "-c", "copy", temporaryFinalPath]);
        }
      } else {
        if (!burnSubtitles) {
          logStep("Subtitles burn-in disabled (burnSubtitles=false); generating clean video without burned captions.");
        } else {
          logStep("No captions.srt found to burn; generating clean video.");
        }
        await runFfmpeg(["-i", withMusicPath, "-c", "copy", temporaryFinalPath]);
      }

      const storyDuration = preparedScenes.reduce(
        (sum, scene) => sum + scene.measuredDurationSeconds,
        0,
      );
      const expectedDuration = keyArtDurationSeconds + storyDuration + outroDurationSeconds;
      const renderedDuration = await getMediaDuration(temporaryFinalPath);
      const durationDelta = Math.abs(renderedDuration - expectedDuration);
      const clipRoundingDelta = Math.abs(encodedClipTimelineSeconds - expectedDuration);
      const allowedDurationDelta = clipRoundingDelta + FINAL_DURATION_TOLERANCE_SECONDS;
      const concatDelta = Math.abs(renderedDuration - encodedClipTimelineSeconds);
      if (
        durationDelta > allowedDurationDelta ||
        concatDelta > FINAL_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `Final assembled video duration (${renderedDuration.toFixed(3)}s) does not match the ` +
          `expected ${expectedDuration.toFixed(3)}s timeline (delta ${durationDelta.toFixed(3)}s; ` +
          `maximum ${allowedDurationDelta.toFixed(3)}s after measured frame/AAC rounding). ` +
          `Its concat delta is ${concatDelta.toFixed(3)}s (maximum ` +
          `${FINAL_DURATION_TOLERANCE_SECONDS.toFixed(3)}s). Refusing to publish a missing, ` +
          "duplicated, or appended scene timeline."
        );
      }

      // All fallible rendering and validation completed against the temporary
      // candidate. Remove intermediates before atomically publishing it.
      await rm(workDir, { recursive: true, force: true });
      await rename(temporaryFinalPath, finalPath);
      logVideoAssembled({
        episodeNumber,
        sceneCount: scenes.length,
        totalDuration: renderedDuration,
        path: finalPath,
      });
      logTimingSummary();

      if (seriesState) {
        await seriesState.upsertEpisodeVideoOutput({
          seriesId,
          episodeNumber,
          variant: outputVariant,
          status: "completed",
          outputPath: finalPath,
          durationSeconds: renderedDuration,
          error: null,
        });
        await seriesState.updateEpisodeStatus(
          (await seriesState.getEpisodeByNumber(seriesId, episodeNumber))!.id,
          "assembly",
          { outputPath: finalPath },
        );
      }

      endTimer(timerName);

      return JSON.stringify({
        path: finalPath,
        variant: outputVariant,
        durationSeconds: renderedDuration,
        storyDurationSeconds: storyDuration,
        keyArtDurationSeconds,
        keyArtClipCount: preparedKeyArt.length,
        expectedDurationSeconds: expectedDuration,
        encodedClipTimelineSeconds,
        durationDeltaSeconds: durationDelta,
        allowedDurationDeltaSeconds: allowedDurationDelta,
        captionsEmbedded,
        warning: assemblyWarning,
      });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rm(temporaryFinalPath, { force: true });
        if (seriesState) {
          try {
            await seriesState.upsertEpisodeVideoOutput({
              seriesId,
              episodeNumber,
              variant: outputVariant,
              status: "failed",
              outputPath: null,
              durationSeconds: null,
              error: message,
              completedAt: null,
            });
          } catch (persistenceError) {
            logStep(
              `Failed to persist ${outputVariant} assembly error: ` +
              `${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`
            );
          }
        }
        endTimer(timerName);
        throw error;
      }
    },
  });
}
