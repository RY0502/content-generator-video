import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import type { SeriesState } from "../state/seriesState.js";

type CaptionScene = {
  sceneNumber: number;
  text: string;
  durationSeconds: number;
};

type CaptionState = Pick<
  SeriesState,
  "getEpisodeByNumber" | "getEpisodeNarrationAudioManifest"
>;

function parseSceneArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    const trimmed = value.trim();
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function formatSrtTimestamp(totalSeconds: number): string {
  const ms = Math.round(totalSeconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/**
 * Strips vocal directions like [cheerful], [whisper], etc. from text.
 * These are used by Orpheus TTS for expressiveness but shouldn't appear in captions.
 */
function stripVocalDirections(text: string): string {
  // Remove vocal directions: [word], [multiple words], etc.
  return text.replace(/\[\s*[a-zA-Z][a-zA-Z\s]*\]/g, '').trim();
}

async function writeEpisodeCaptions(params: {
  seriesId: number;
  episodeNumber: number;
  scenes: CaptionScene[];
}): Promise<string> {
  let cursor = 0;
  const lines: string[] = [];
  params.scenes.forEach((scene, idx) => {
    const start = cursor;
    const end = cursor + scene.durationSeconds;
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
    lines.push(stripVocalDirections(scene.text));
    lines.push("");
    cursor = end;
  });

  const destDir = path.join(
    CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
  );
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, "captions.srt");
  await writeFile(destPath, lines.join("\n"), "utf8");
  return JSON.stringify({
    path: destPath,
    sceneCount: params.scenes.length,
    totalDurationSeconds: cursor,
    initialOffsetSeconds: 0,
  });
}

/**
 * Deep-agent tool: builds the episode's SRT captions file directly from the
 * already-known narration text + per-scene audio durations (no ASR needed,
 * since the exact text and timing were produced in earlier pipeline steps).
 * Captions remain zero-relative to the story scenes and contiguous. Final
 * assembly shifts a private copy by the exact duration of both key-art intros
 * when subtitles are burned into the full episode.
 */
export function buildCaptionTool(seriesState?: CaptionState): DynamicStructuredTool {
  if (seriesState) {
    return new DynamicStructuredTool({
      name: "generate_episode_captions",
      description:
        "Creates or restores captions.srt from the persisted production script and validated exact-text WAV metadata. " +
        "Pass only seriesId and episodeNumber; never retransmit scene text or durations.",
      schema: z.object({
        seriesId: z.number().int().positive(),
        episodeNumber: z.number().int().positive(),
      }).strict(),
      func: async ({ seriesId, episodeNumber }) => {
        const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
        if (!episode) {
          throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
        }
        const manifest = await seriesState.getEpisodeNarrationAudioManifest(episode.id);
        return writeEpisodeCaptions({
          seriesId,
          episodeNumber,
          scenes: manifest.scenes.map((scene) => ({
            sceneNumber: scene.sceneNumber,
            text: scene.narrationText,
            durationSeconds: scene.durationSeconds,
          })),
        });
      },
    });
  }

  return new DynamicStructuredTool({
    name: "generate_episode_captions",
    description:
      "Builds the episode's captions.srt file from an ordered list of scenes, each with its narration " +
      "text and audio duration in seconds (as returned by synthesize_narration_audio). Call once, after " +
      "all scene audio has been generated for the episode.",
    schema: z.object({
      seriesId: z.number(),
      episodeNumber: z.number(),
      scenes: z.preprocess(
        parseSceneArrayInput,
        z
          .array(
            z.object({
              sceneNumber: z.number(),
              text: z.string(),
              durationSeconds: z.number(),
            })
          )
      ).describe("Scenes in playback order. A JSON-encoded array string is also accepted and normalized."),
    }),
    func: ({ seriesId, episodeNumber, scenes }) => writeEpisodeCaptions({
      seriesId,
      episodeNumber,
      scenes,
    }),
  });
}
