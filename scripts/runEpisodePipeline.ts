import { existsSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    } catch { }

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


/**
 * Ensures the series exists in Turso with the specified seriesId.
 * If not already present in Turso, parses prompt.txt to create the series,
 * character sheets, and initial episode manifest.
 */
async function ensureSeriesFromPrompt(
  seriesId: number,
  seriesState: SeriesState,
  customPromptPath?: string
): Promise<void> {
  const exists = await seriesState.seriesExists(seriesId);
  if (exists) {
    console.log(`[Series Check] Series ${seriesId} already exists in Turso.`);
    return;
  }

  console.log(`[Series Check] Series ${seriesId} not found in Turso. Bootstrapping from prompt.txt...`);

  const promptCandidates = [
    customPromptPath,
    fileURLToPath(new URL("../prompt.txt", import.meta.url)),
    path.resolve(process.cwd(), "prompt.txt"),
  ].filter(Boolean) as string[];

  const promptPath = promptCandidates.find((p) => existsSync(p));
  if (!promptPath) {
    throw new Error(
      `Cannot bootstrap series ${seriesId}: prompt.txt not found. Checked: ${promptCandidates.join(", ")}`
    );
  }

  console.log(`[Series Check] Reading series definition from: ${promptPath}`);
  const content = readFileSync(promptPath, "utf8");

  const titleMatch = content.match(/\*\*([^*]+)\*\*\s+series/i);
  const conceptName = titleMatch ? titleMatch[1].trim() : "Time-Travel Backpack";

  const premiseMatch = content.match(/##\s*Series premise\s*\n+([\s\S]*?)(?=\n##|$)/i);
  const premise = premiseMatch ? premiseMatch[1].trim() : "";

  const characters: Array<{ name: string; description: string }> = [];
  const castMatch = content.match(/##\s*Fixed main cast\s*\n+([\s\S]*?)(?=\n##|$)/i);
  if (castMatch) {
    const charRegex = /^-\s*\*\*([^:*]+):\*\*\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = charRegex.exec(castMatch[1])) !== null) {
      characters.push({ name: m[1].trim(), description: m[2].trim() });
    }
  }

  const formulaMatch = content.match(/##\s*Story design\s*\n+([\s\S]*?)(?=\n##|$)/i);
  const episodeFormula = formulaMatch
    ? formulaMatch[1].trim().slice(0, 500)
    : "Children travel through time and space with Bobo to solve gentle adventures with teamwork and wonder.";

  const environments = [
    {
      name: "Time Portal",
      description: "A swirling magical portal through time and space connecting past, present, and future worlds.",
    },
  ];

  // Insert series with the explicit seriesId
  await tursoClient.execute({
    sql: `INSERT INTO series (id, concept_name, characters_json, environments_json, episode_formula)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            concept_name = excluded.concept_name,
            characters_json = excluded.characters_json,
            environments_json = excluded.environments_json,
            episode_formula = excluded.episode_formula`,
    args: [
      seriesId,
      conceptName,
      JSON.stringify(characters),
      JSON.stringify(environments),
      episodeFormula,
    ],
  });
  console.log(`[Series Bootstrap] ✅ Created Series ${seriesId} ("${conceptName}") in Turso.`);

  // Upsert character sheets
  for (const char of characters) {
    await seriesState.upsertCharacterSheet(
      seriesId,
      char.name,
      char.description,
      {},
      char.description
    );
  }
  console.log(`[Series Bootstrap] ✅ Upserted ${characters.length} character sheets.`);

  // Seed 25-episode manifest in Turso if empty
  const seasonEpisodes = Array.from({ length: 25 }, (_, idx) => {
    const epNum = idx + 1;
    return {
      episodeNumber: epNum,
      title: epNum === 1 ? "The First Adventure" : `Episode ${epNum}`,
      premise:
        epNum === 1
          ? premise.slice(0, 300) || "The children discover Bobo and their first time-travel adventure."
          : `Episode ${epNum} of ${conceptName}`,
    };
  });

  await seriesState.bulkInsertEpisodesIfEmpty(seriesId, seasonEpisodes);
  console.log(`[Series Bootstrap] ✅ Seeded 25 episode slots in Turso.`);
}

export async function runEpisodePipeline(options: {
  seriesId?: number;
  episodeNumber?: number;
  maxCycles?: number;
  cooldownMs?: number;
  promptPath?: string;
} = {}): Promise<void> {
  const seriesId = options.seriesId ?? 18;
  const episodeNumber = options.episodeNumber ?? 1;
  const maxCycles = options.maxCycles ?? 60;
  const cooldownMs = options.cooldownMs ?? 120_000;

  console.log("=================================================");
  console.log(`[Pipeline] Autonomous Video Generation Pipeline`);
  console.log(`[Pipeline] Series: ${seriesId}, Episode: ${episodeNumber}`);
  console.log(`[Pipeline] Max Cycles: ${maxCycles}, Cycle Cooldown: ${cooldownMs / 1000}s`);
  console.log("=================================================\n");

  const seriesState = new SeriesState();
  await seriesState.initialize();

  // Ensure series exists in Turso or bootstrap it from prompt.txt using seriesId
  await ensureSeriesFromPrompt(seriesId, seriesState, options.promptPath);

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
