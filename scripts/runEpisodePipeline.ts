import { existsSync, statSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";
import {
  buildSubmitAgnesSceneVideosTool,
  buildVerifyAgnesSceneVideosTool,
  buildDownloadAgnesSceneVideosTool,
} from "../src/tools/agnesSceneVideoTool.js";
import { buildAgnesVideoQaTool } from "../src/tools/agnesVideoQaTool.js";
import { buildEpisodeAssemblyTool } from "../src/tools/episodeAssemblyTool.js";
import { createClient } from "@libsql/client";

dotenv.config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tursoClient = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const AGNES_ACCOUNTS: Record<string, string> = {
  "account-1": process.env.AGNES_API_KEY_1 || process.env.AGNES_API_KEY!,
  "account-2": process.env.AGNES_API_KEY_2 || "",
  "account-3": process.env.AGNES_API_KEY_3 || "",
  "account-4": process.env.AGNES_API_KEY_4 || "",
  "account-5": process.env.AGNES_API_KEY_5 || "",
};

/** Directly synchronizes remote Agnes video task completions into Turso DB. */
async function syncRemoteTaskStatus(seriesId: number, episodeNumber: number): Promise<{
  completed: number;
  inProgress: number;
  pending: number;
}> {
  const rs = await tursoClient.execute({
    sql: "SELECT scene_number, status, provider_task_id, provider_video_url, provider_receipt_json FROM agnes_scene_generations WHERE series_id = ? AND episode_number = ? ORDER BY scene_number ASC",
    args: [seriesId, episodeNumber],
  });

  let completed = 0;
  let inProgress = 0;
  let pending = 0;

  for (const row of rs.rows) {
    const sceneNumber = row.scene_number as number;
    const taskId = row.provider_task_id as string | null;
    const currentStatus = row.status as string;

    if (!taskId) {
      pending++;
      continue;
    }

    if (currentStatus === "completed" && row.provider_video_url) {
      completed++;
      continue;
    }

    let receipt: any = {};
    try {
      receipt = JSON.parse(row.provider_receipt_json as string);
    } catch {}

    const attempts = receipt.attempts ?? [];
    const lastAttempt = attempts[attempts.length - 1] ?? {};
    const accountId = lastAttempt.accountId || "account-1";
    const apiKey = AGNES_ACCOUNTS[accountId] || AGNES_ACCOUNTS["account-1"];

    try {
      const res = await fetch(`https://apihub.agnes-ai.com/v1/videos/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        inProgress++;
        continue;
      }

      const data: any = await res.json();
      const videoUrl = data.metadata?.url || data.url;

      if (data.status === "completed" && videoUrl) {
        completed++;
        lastAttempt.state = "accepted";
        const keyLabel = lastAttempt.keyLabel || "key-1";
        const keyFingerprint = lastAttempt.keyFingerprint || "0".repeat(64);
        lastAttempt.keyLabel = keyLabel;
        lastAttempt.keyFingerprint = keyFingerprint;
        lastAttempt.task = {
          id: taskId,
          task_id: taskId,
          video_id: taskId,
          model: "agnes-video-2.5-flash",
          status: "completed",
          progress: 100,
          keyLabel,
          keyFingerprint,
          metadata: { url: videoUrl },
          url: videoUrl,
        };

        await tursoClient.execute({
          sql: "UPDATE agnes_scene_generations SET status = 'completed', provider_video_url = ?, provider_receipt_json = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE series_id = ? AND episode_number = ? AND scene_number = ?",
          args: [videoUrl, JSON.stringify(receipt), seriesId, episodeNumber, sceneNumber],
        });
        console.log(`  -> [Agnes Sync] Scene ${sceneNumber} completed on Agnes! Updated in Turso.`);
      } else {
        inProgress++;
        console.log(`  -> [Agnes Sync] Scene ${sceneNumber} status=${data.status}, progress=${data.progress}%`);
      }
    } catch (err: any) {
      inProgress++;
    }
  }

  return { completed, inProgress, pending };
}

export async function runEpisodePipeline(options: {
  seriesId?: number;
  episodeNumber?: number;
  maxCycles?: number;
  cooldownMs?: number;
} = {}): Promise<void> {
  const seriesId = options.seriesId ?? 16;
  const episodeNumber = options.episodeNumber ?? 1;
  const maxCycles = options.maxCycles ?? 60;
  const cooldownMs = options.cooldownMs ?? 30_000;

  console.log("=================================================");
  console.log(`[Pipeline] Autonomous Video Generation Pipeline`);
  console.log(`[Pipeline] Series: ${seriesId}, Episode: ${episodeNumber}`);
  console.log(`[Pipeline] Max Cycles: ${maxCycles}, Cycle Cooldown: ${cooldownMs / 1000}s`);
  console.log("=================================================\n");

  const seriesState = new SeriesState();
  await seriesState.initialize();

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    console.log(`\n>>> [Cycle ${cycle}/${maxCycles}] State Check @ ${new Date().toISOString()}`);

    // Check script & audio readiness
    const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${episodeNumber} does not exist in series ${seriesId}.`);
    }

    try {
      await seriesState.assertEpisodeAudioReady(episode.id);
      await seriesState.assertEpisodeKeyArtAudioReady(seriesId, episodeNumber);
    } catch (err: any) {
      console.error(`[Pipeline Error] Audio or Script not ready: ${err.message}`);
      return;
    }

    // 1. Sync any completed remote video tasks from Agnes
    const syncResult = await syncRemoteTaskStatus(seriesId, episodeNumber);

    // 2. Query Turso for current asset status
    const agnesRows = await seriesState.listAgnesSceneGenerations(seriesId, episodeNumber);
    const totalScenes = 26; // 24 scenes + 2 key-art videos
    const completedScenes = agnesRows.filter((r) => r.status === "completed" && Boolean(r.providerVideoUrl));
    const downloadedScenes = agnesRows.filter((r) => r.downloadStatus === "downloaded" && r.normalizedOutputPath && existsSync(r.normalizedOutputPath));
    const pendingScenes = agnesRows.filter((r) => !r.providerTaskId || r.status === "pending" || r.status === "failed");

    console.log(`[Asset Inventory] Total: ${totalScenes}`);
    console.log(`  - Completed on Agnes: ${completedScenes.length}/${totalScenes}`);
    console.log(`  - In-Progress on Agnes: ${syncResult.inProgress}`);
    console.log(`  - Pending Submission: ${pendingScenes.length}`);
    console.log(`  - Downloaded & Normalized: ${downloadedScenes.length}/${totalScenes}`);

    // Create fresh tools for this cycle
    const submitTool = buildSubmitAgnesSceneVideosTool(seriesState, {
      includeKeyArt: true,
      rotateOnCapacity: true,
    });
    const downloadTool = buildDownloadAgnesSceneVideosTool(seriesState, {
      includeKeyArt: true,
      rotateOnCapacity: true,
    });
    const qaTool = buildAgnesVideoQaTool(seriesState);
    const assemblyTool = buildEpisodeAssemblyTool(seriesState, { includeKeyArt: true });

    // Step A: If any scenes are pending submission, submit them
    if (agnesRows.length < totalScenes || pendingScenes.length > 0) {
      const neededCount = agnesRows.length < totalScenes ? totalScenes - completedScenes.length : pendingScenes.length;
      console.log(`\n[Action] Submitting pending scene(s) (${neededCount} needed) across Agnes accounts...`);
      try {
        const rawResult = await submitTool.invoke({ seriesId, episodeNumber });
        const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
        console.log(`[Submit Result]: status=${result.status}, attempted=${result.attemptedCount}, alreadyAccepted=${result.alreadyAcceptedCount}`);
      } catch (err: any) {
        console.warn(`[Submit Warning]: ${err.message}`);
      }
      console.log(`[Cooldown] Waiting ${cooldownMs / 1000}s for provider slots/queues...`);
      await sleep(cooldownMs);
      continue;
    }

    // Step B: If all are submitted but some are still in progress on Agnes, wait
    if (completedScenes.length < totalScenes) {
      console.log(`\n[Waiting] ${totalScenes - completedScenes.length} clip(s) still rendering on Agnes. Sleeping ${cooldownMs / 1000}s...`);
      await sleep(cooldownMs);
      continue;
    }

    // Step C: All 26 are completed on Agnes! Download & Normalize
    if (downloadedScenes.length < totalScenes) {
      console.log(`\n[Action] All 26 videos are completed on Agnes! Downloading and normalizing clips...`);
      const rawResult = await downloadTool.invoke({ seriesId, episodeNumber });
      const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
      console.log(`[Download Result]: status=${result.status}, completed=${result.completed}/${result.assetCount}`);

      if (result.status !== "completed" && result.status !== "downloaded") {
        console.log(`[Download Pending]: Waiting ${cooldownMs / 1000}s...`);
        await sleep(cooldownMs);
        continue;
      }
    }

    // Step D: Static Deterministic Video QA
    console.log(`\n[Action] All clips downloaded! Running static media QA...`);
    const rawQa = await qaTool.invoke({ seriesId, episodeNumber });
    const qaResult = typeof rawQa === "string" ? JSON.parse(rawQa) : rawQa;
    console.log(`[QA Result]: status=${qaResult.status}, passed=${qaResult.passed}/${qaResult.assetCount}`);

    if (qaResult.status !== "passed" && qaResult.status !== "ready") {
      console.error(`[QA Issue]:`, qaResult);
      await sleep(10_000);
      continue;
    }

    // Step E: Final Video Assembly
    console.log(`\n[Action] QA Passed! Assembling final episode video...`);
    const rawAssembly = await assemblyTool.invoke({ seriesId, episodeNumber });
    const assemblyResult = typeof rawAssembly === "string" ? JSON.parse(rawAssembly) : rawAssembly;
    const finalPath = assemblyResult.path || assemblyResult.outputPath;
    console.log(`[Assembly Result]: status=${assemblyResult.status || "assembled"}, path=${finalPath}`);

    if (finalPath && existsSync(finalPath)) {
      const stats = statSync(finalPath);
      console.log("\n=================================================");
      console.log(`>>> SUCCESS: Final Episode Video Assembled! <<<`);
      console.log(`Output File: ${finalPath}`);
      console.log(`File Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Status: Episode 1 is completely produced and ready!`);
      console.log("=================================================\n");
      return;
    }

    console.log(`[Assembly In Progress]: Waiting ${cooldownMs / 1000}s...`);
    await sleep(cooldownMs);
  }

  throw new Error(`Pipeline reached max cycles (${maxCycles}) without assembling the episode.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("runEpisodePipeline.ts")) {
  runEpisodePipeline().catch((err) => {
    console.error("Pipeline failed:", err);
    process.exit(1);
  });
}
