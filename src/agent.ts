import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CONFIG as FRAMEWORK_CONFIG,
  CustomStateStore,
  DatabaseClient,
  DeepAgentRunner,
  hashUserPrompt,
  validateConfig,
} from "freetier-deepagent-framework";
import { CONFIG, validateProjectConfig } from "./config.js";
import { AgentProgressCallback } from "./services/agentProgressCallback.js";
import { installDeepAgentBackend } from "./services/deepAgentBackend.js";
import {
  buildEndEpisodeInvocationTool,
  guardTerminalEpisodeInvocationReceipts,
} from "./services/episodeInvocationBoundary.js";
import {
  assertProductionHarnessConfigured,
  configureProductionHarness,
} from "./services/productionHarness.js";
import {
  assertNvidiaDeepAgentProfileConfigured,
  configureNvidiaDeepAgentProfile,
} from "./services/nvidiaDeepAgentProfile.js";
import { runWithFinalizer } from "./services/runLifecycle.js";
import { selectiveCleanupNeon } from "./state/selectiveCleanup.js";
import { SeriesState } from "./state/seriesState.js";
import { SYSTEM_PROMPT_EXTENSION } from "./systemPrompt.js";
import { buildAgnesSceneVideoTools } from "./tools/agnesSceneVideoTool.js";
import { buildCaptionTool } from "./tools/captionTool.js";
import { buildEnsureSeriesCharacterSheetsTool } from "./tools/characterSheetTool.js";
import { buildEpisodeAssemblyTool } from "./tools/episodeAssemblyTool.js";
import {
  buildEpisodeScriptChunkTool,
  buildScriptRefinementTool,
} from "./tools/scriptRefinementTool.js";
import { buildSeriesStateTools } from "./tools/seriesStateTools.js";
import { buildSoundLibraryTool } from "./tools/soundLibraryTool.js";
import { buildEpisodeTtsTool } from "./tools/ttsTool.js";
import {
  buildYoutubeEpisodeMetadataTool,
  buildYoutubeSeriesMetadataTool,
} from "./tools/youtubeMetadataTool.js";
import { buildYoutubeUploadTool } from "./tools/youtubeUploadTool.js";

/** Runs one canonical episode-agent invocation after bootstrap cleanup. */
export async function runAgent(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  validateConfig();
  validateProjectConfig();
  configureProductionHarness();
  assertProductionHarnessConfigured();
  configureNvidiaDeepAgentProfile();
  assertNvidiaDeepAgentProfileConfigured();

  let conceptPrompt = args.join(" ").trim();
  if (!conceptPrompt) {
    console.error(
      'Usage: npm run dev -- "Generate the next episode for the Tiny Heroes Club concept" or npm run dev -- prompt.txt',
    );
    process.exitCode = 1;
    return;
  }

  if (existsSync(conceptPrompt) && statSync(conceptPrompt).isFile()) {
    conceptPrompt = readFileSync(conceptPrompt, "utf8").trim();
  }

  const db = new DatabaseClient(FRAMEWORK_CONFIG.NEON_DATABASE_URL);
  const seriesState = new SeriesState();
  await runWithFinalizer({
    run: async () => {
      const customState = new CustomStateStore(db);
      const promptHash = hashUserPrompt(conceptPrompt);
    const youtubeUploadTool = buildYoutubeUploadTool({
      getExistingUpload: async ({ seriesId, episodeNumber }) => {
        const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
        const episodeReceipt = episode?.uploadedAt && episode.youtubeVideoId && episode.youtubeUrl
          ? { videoId: episode.youtubeVideoId, url: episode.youtubeUrl }
          : null;
        const recoveryReceipt = episodeReceipt
          ? null
          : await seriesState.getYoutubeUploadReceipt(seriesId, episodeNumber);
        const receipt = episodeReceipt ?? (recoveryReceipt
          ? { videoId: recoveryReceipt.videoId, url: recoveryReceipt.url }
          : null);
        if (!receipt) return null;

        // A durable remote receipt prevents an unsafe duplicate upload even if
        // a previous invocation stopped before local finalization completed.
        try {
          await seriesState.finalizeEpisodeUpload({
            seriesId,
            episodeNumber,
            videoId: receipt.videoId,
            url: receipt.url,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `YouTube upload receipt exists for series ${seriesId}, episode ${episodeNumber}, ` +
            `so it will not be uploaded again; local finalization remains pending: ${message}`,
            { cause: error },
          );
        }
        return receipt;
      },
      beforeUpload: async ({ seriesId, episodeNumber, videoPath }) => {
        await seriesState.assertEpisodeUploadAllowedToday(seriesId, episodeNumber);
        const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
        if (!episode) {
          throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
        }
        const ready = await seriesState.assertEpisodeReadyForDone(episode.id);
        if (path.resolve(videoPath) !== path.resolve(ready.outputPath)) {
          throw new Error(
            `YouTube upload must use the canonical assembled Agnes video: ${ready.outputPath}`,
          );
        }
      },
      onUploaded: async ({ seriesId, episodeNumber, videoId, url }) => {
        await seriesState.finalizeEpisodeUpload({ seriesId, episodeNumber, videoId, url });
      },
    });

    const runner = new DeepAgentRunner(db, {
      extraTools: [
        ...buildSeriesStateTools(seriesState),
        buildEnsureSeriesCharacterSheetsTool(seriesState, customState, promptHash),
        guardTerminalEpisodeInvocationReceipts(buildEpisodeScriptChunkTool(seriesState)),
        guardTerminalEpisodeInvocationReceipts(buildScriptRefinementTool(seriesState)),
        buildEndEpisodeInvocationTool(),
        buildEpisodeTtsTool({ seriesState }),
        buildSoundLibraryTool(),
        buildCaptionTool(seriesState),
        ...buildAgnesSceneVideoTools(seriesState, {
          includeKeyArt: true,
          characterSheetCustomState: customState,
          characterSheetPromptHash: promptHash,
        }),
        buildEpisodeAssemblyTool(seriesState, { includeKeyArt: true }),
        buildYoutubeEpisodeMetadataTool(seriesState),
        buildYoutubeSeriesMetadataTool(seriesState),
        youtubeUploadTool,
      ],
      extraSubagents: [],
      systemPromptExtension: SYSTEM_PROMPT_EXTENSION,
      callbacks: [new AgentProgressCallback()],
      recursionLimit: 120,
    });
    installDeepAgentBackend(
      runner,
      path.join(CONFIG.outputDir, "_deep_agent_state"),
    );

    // A fresh Turso database has no domain tables. This also applies every
    // additive migration required by older installations before the agent runs.
    await seriesState.initialize();
    console.log("[episode-agent] Starting compact production flow", {
      conceptPromptChars: conceptPrompt.length,
      productionContractChars: SYSTEM_PROMPT_EXTENSION.length,
    });
    const result = await runner.run(conceptPrompt);
    await selectiveCleanupNeon({ preserveAgentRuns: true, preserveCustomState: true });
      console.log(result.finalText);
    },
    finalize: () => seriesState.close(),
    onSuppressedFinalizeError: (error) => {
      console.error("Series state close also failed:", error);
    },
  });
}
