import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { logStep } from "../utils/logger.js";

/**
 * Builds a tool to log episode completion.
 * Checkpoints are automatically managed by the framework and will be cleaned
 * when you run with a different prompt (e.g., "Generate episode 2").
 * 
 * NOTE: The framework's checkpoint system is prompt-hash based. Each unique
 * prompt gets its own checkpoint namespace. When you run "Generate episode 2",
 * it will have a different prompt hash and won't interfere with episode 1's checkpoints.
 */
export function buildCleanupTool(promptHash: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "mark_episode_complete",
    description:
      "Marks an episode as complete after the video has been successfully assembled. " +
      "Call this ONLY after the episode video exists on disk. This logs completion and " +
      "confirms all assets are saved. Checkpoints are automatically managed by the framework.",
    schema: z.object({
      episodeNumber: z.number().describe("The episode number that was just completed."),
      videoPath: z.string().describe("Path to the completed episode video file."),
    }),
    func: async ({ episodeNumber, videoPath }) => {
      logStep(`✓ Episode ${episodeNumber} complete!`);
      logStep(`   Video: ${videoPath}`);
      logStep(`   Prompt hash: ${promptHash.slice(0, 16)}...`);
      logStep(`   Next run: Use a different prompt to generate episode ${episodeNumber + 1}`);
      logStep(`   Example: "Generate the next episode for [series name]"`);

      return JSON.stringify({
        status: "complete",
        episodeNumber,
        videoPath,
        promptHash: promptHash.slice(0, 16),
        message: `Episode ${episodeNumber} complete! Video saved to ${videoPath}. ` +
          `To generate episode ${episodeNumber + 1}, run with a different prompt. ` +
          `Checkpoints are automatically managed per-prompt by the framework.`,
        nextSteps: [
          `Run: npm run dev -- "Generate the next episode for [series name]"`,
          `The framework will automatically start episode ${episodeNumber + 1}`,
          `Previous checkpoints won't interfere (different prompt hash)`,
        ],
      });
    },
  });
}
