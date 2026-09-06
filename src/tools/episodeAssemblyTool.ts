import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { CONFIG } from "../config.js";
import type { SeriesState } from "../state/seriesState.js";
import {
  buildVideoAssemblyTool,
  type VideoAssemblyToolOptions,
} from "./videoAssemblyTool.js";

/**
 * Production assembly facade. The model supplies only episode identity; the
 * canonical script order and media paths are resolved from durable state.
 * This avoids copying a 40-60 item manifest through the agent conversation.
 */
export function buildEpisodeAssemblyTool(
  seriesState: SeriesState,
  options: VideoAssemblyToolOptions = {},
): DynamicStructuredTool {
  const assemblyTool = buildVideoAssemblyTool(seriesState, options);

  return new DynamicStructuredTool({
    name: "assemble_episode_video",
    description:
      "Assembles both persisted Agnes title clips and every persisted scene/WAV pair in canonical script order. " +
      "Pass only seriesId and episodeNumber, plus optional music/subtitle settings; never send a scene manifest.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
      musicPath: z.string().nullable().optional(),
      burnSubtitles: z.boolean().default(CONFIG.burnSubtitles ?? false),
    }).strict(),
    func: async ({ seriesId, episodeNumber, musicPath, burnSubtitles }) => {
      const [seriesInfo, episode] = await Promise.all([
        seriesState.getSeriesInfo(seriesId),
        seriesState.getEpisodeByNumber(seriesId, episodeNumber),
      ]);
      if (!seriesInfo) throw new Error(`Series ${seriesId} was not found.`);
      if (!episode) {
        throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
      }

      // The durable output receipt is written before the coarse episode stage.
      // If a process stops in that tiny window, validate and reuse the already
      // assembled video instead of spending minutes rendering it again.
      const completedOutput = (await seriesState.listEpisodeVideoOutputs(
        seriesId,
        episodeNumber,
      )).find((output) =>
        output.variant === "agnes_text"
        && output.status === "completed"
        && Boolean(output.outputPath)
      );
      if (completedOutput) {
        try {
          const ready = await seriesState.assertEpisodeReadyForDone(episode.id);
          return JSON.stringify({
            status: "already_completed",
            reused: true,
            path: ready.outputPath,
            variant: "agnes_text",
            durationSeconds: ready.durationSeconds,
          });
        } catch {
          // A stale/corrupt receipt is not reusable. Fall through to the
          // existing atomic candidate-render and validation path.
        }
      }

      const manifest = await seriesState.getEpisodeNarrationAudioManifest(episode.id);
      const episodeDir = path.resolve(
        CONFIG.outputDir,
        `series_${seriesId}`,
        `episode_${episodeNumber}`,
      );
      const scenes = manifest.scenes.map(({ sceneNumber }) => ({
        sceneNumber,
        narrationAudioPath: path.join(
          episodeDir,
          "audio",
          `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`,
        ),
      }));

      return assemblyTool.invoke({
        seriesId,
        seriesTitle: seriesInfo.conceptName,
        episodeNumber,
        scenes,
        musicPath: musicPath ?? null,
        captionsSrtPath: path.join(episodeDir, "captions.srt"),
        burnSubtitles,
      });
    },
  });
}
