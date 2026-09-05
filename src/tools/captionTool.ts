import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";

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

/**
 * Deep-agent tool: builds the episode's SRT captions file directly from the
 * already-known narration text + per-scene audio durations (no ASR needed,
 * since the exact text and timing were produced in earlier pipeline steps).
 * Captions remain zero-relative to the story scenes and contiguous. Final
 * assembly shifts a private copy by the exact duration of both key-art intros
 * when subtitles are burned into the full episode.
 */
export function buildCaptionTool(): DynamicStructuredTool {
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
    func: async ({ seriesId, episodeNumber, scenes }) => {
      let cursor = 0;
      const lines: string[] = [];
      scenes.forEach((scene: { sceneNumber: number; text: string; durationSeconds: number }, idx: number) => {
        const start = cursor;
        const end = cursor + scene.durationSeconds;
        lines.push(String(idx + 1));
        lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
        // Strip vocal directions from caption text
        const cleanText = stripVocalDirections(scene.text);
        lines.push(cleanText);
        lines.push("");
        cursor = end;
      });

      const destDir = path.join(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`);
      await mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, "captions.srt");
      await writeFile(destPath, lines.join("\n"), "utf8");
      return JSON.stringify({ path: destPath, totalDurationSeconds: cursor, initialOffsetSeconds: 0 });
    },
  });
}
