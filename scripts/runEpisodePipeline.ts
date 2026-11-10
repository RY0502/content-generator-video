import { existsSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { CONFIG } from "../src/config.js";
import { SeriesState, createResilientTursoFetch } from "../src/state/seriesState.js";
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
  fetch: createResilientTursoFetch(),
});

const AGNES_ACCOUNTS: Record<string, string> = Object.fromEntries(
  CONFIG.agnesAccounts.map((account) => [account.accountId, account.apiKey]),
);


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
    const accountId = lastAttempt?.accountId || "account-1";
    const apiKey = AGNES_ACCOUNTS[accountId] || AGNES_ACCOUNTS["account-1"] || CONFIG.agnesAccounts[0]?.apiKey || "";

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

/** Finds the currently active in-progress episode across series in Turso DB. */
export async function findInProgressEpisode(
  client = tursoClient,
): Promise<{ seriesId: number; episodeNumber: number; title: string; status: string } | null> {
  const rs = await client.execute(`
    SELECT e.id, e.series_id, e.episode_number, e.title, e.status, e.updated_at,
           (SELECT COUNT(*) FROM agnes_scene_generations a
            WHERE a.series_id = e.series_id AND a.episode_number = e.episode_number
              AND (a.provider_task_id IS NULL OR a.status IN ('pending', 'failed'))) as pending_submission_count,
           (SELECT COUNT(*) FROM agnes_scene_generations a
            WHERE a.series_id = e.series_id AND a.episode_number = e.episode_number
              AND a.status <> 'completed') as active_scene_count,
           (SELECT COUNT(*) FROM agnes_scene_generations a
            WHERE a.series_id = e.series_id AND a.episode_number = e.episode_number) as total_tracked_scenes
    FROM episodes e
    WHERE e.status <> 'done'
      AND e.scheduler_skipped_at IS NULL
      AND e.output_path IS NULL
      AND (
        e.status IN ('audio', 'assembly', 'images')
        OR (e.script_json IS NOT NULL AND trim(e.script_json) <> '')
        OR EXISTS (
          SELECT 1 FROM agnes_scene_generations a
          WHERE a.series_id = e.series_id AND a.episode_number = e.episode_number
        )
      )
    ORDER BY
      pending_submission_count DESC,
      active_scene_count DESC,
      CASE WHEN e.status IN ('audio', 'assembly') THEN 1 ELSE 0 END DESC,
      total_tracked_scenes DESC,
      e.series_id DESC,
      e.updated_at DESC,
      e.episode_number ASC
    LIMIT 1
  `);

  if (rs.rows.length === 0) return null;
  const row = rs.rows[0]!;
  return {
    seriesId: Number(row.series_id),
    episodeNumber: Number(row.episode_number),
    title: String(row.title ?? ""),
    status: String(row.status ?? ""),
  };
}

function parseCliArgs(): {
  seriesId?: number;
  episodeNumber?: number;
  watch?: boolean;
  maxCycles?: number;
  cooldownMs?: number;
  promptPath?: string;
} {
  const args = process.argv.slice(2);
  let seriesId: number | undefined;
  let episodeNumber: number | undefined;
  let watch = false;
  let maxCycles: number | undefined;
  let cooldownMs: number | undefined;
  let promptPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--watch" || arg === "-w" || arg === "--loop") {
      watch = true;
    } else if (arg === "--series" || arg === "-s") {
      seriesId = Number(args[++i]);
    } else if (arg.startsWith("--series=")) {
      seriesId = Number(arg.split("=")[1]);
    } else if (arg === "--episode" || arg === "-e") {
      episodeNumber = Number(args[++i]);
    } else if (arg.startsWith("--episode=")) {
      episodeNumber = Number(arg.split("=")[1]);
    } else if (arg === "--cycles") {
      maxCycles = Number(args[++i]);
    } else if (arg === "--cooldown") {
      cooldownMs = Number(args[++i]) * 1000;
    } else if (arg === "--prompt" || arg === "-p") {
      promptPath = args[++i];
    } else if (arg.startsWith("--prompt=")) {
      promptPath = arg.split("=")[1];
    } else if (/^\d+$/.test(arg)) {
      if (seriesId === undefined) {
        seriesId = Number(arg);
      } else if (episodeNumber === undefined) {
        episodeNumber = Number(arg);
      }
    } else if (arg.endsWith(".txt")) {
      promptPath = arg;
    }
  }

  return { seriesId, episodeNumber, watch, maxCycles, cooldownMs, promptPath };
}

export async function runEpisodePipeline(options: {
  seriesId?: number;
  episodeNumber?: number;
  watch?: boolean;
  maxCycles?: number;
  cooldownMs?: number;
  promptPath?: string;
} = {}): Promise<void> {
  const seriesState = new SeriesState();
  await seriesState.initialize();

  // 1. Resolve target seriesId and episodeNumber
  let seriesId = options.seriesId;
  let episodeNumber = options.episodeNumber;

  if (seriesId === undefined || episodeNumber === undefined) {
    console.log("[Pipeline] No series/episode parameters provided. Checking for in-progress episode in Turso DB...");
    const inProgress = await findInProgressEpisode(tursoClient);
    if (!inProgress) {
      console.log("[Pipeline] No episode is currently in progress. Nothing to do.");
      return;
    }
    seriesId = inProgress.seriesId;
    episodeNumber = inProgress.episodeNumber;
    console.log(`[Pipeline] Detected in-progress episode: Series ${seriesId}, Episode ${episodeNumber} ("${inProgress.title}") [Status: ${inProgress.status}]`);
  } else {
    console.log(`[Pipeline] Targeting specified episode: Series ${seriesId}, Episode ${episodeNumber}`);
    if (options.promptPath) {
      await ensureSeriesFromPrompt(seriesId, seriesState, options.promptPath);
    }
  }

  const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
  if (!episode) {
    console.error(`[Pipeline Error] Episode ${episodeNumber} does not exist in series ${seriesId}. Nothing to do.`);
    return;
  }

  // 2. Check script & audio readiness
  try {
    await seriesState.assertEpisodeAudioReady(episode.id);
    await seriesState.assertEpisodeKeyArtAudioReady(seriesId, episodeNumber);
  } catch (err: any) {
    console.error(`[Pipeline Error] Audio or Script not ready for Series ${seriesId}, Episode ${episodeNumber}: ${err.message}`);
    console.log("[Pipeline] Episode is not ready for video submission yet. Nothing to do.");
    return;
  }

  const cooldownMs = options.cooldownMs ?? 120_000;
  const maxCycles = options.maxCycles ?? 60;

  console.log("=================================================");
  console.log(`[Pipeline] Video Submission & Pipeline Manager`);
  console.log(`[Pipeline] Series: ${seriesId}, Episode: ${episodeNumber} ("${episode.title}")`);
  console.log(`[Pipeline] Mode: ${options.watch ? "Watch/Loop (submits, monitors, downloads, assembles)" : "Submit Pending Only (default)"}`);
  console.log("=================================================\n");

  const runCycle = async (): Promise<{
    totalScenes: number;
    completedCount: number;
    pendingCount: number;
    inProgressCount: number;
    allAssembled: boolean;
  }> => {
    // Sync any completed remote video tasks from Agnes
    const syncResult = await syncRemoteTaskStatus(seriesId, episodeNumber);

    // Query Turso for current asset status
    const agnesRows = await seriesState.listAgnesSceneGenerations(seriesId, episodeNumber);
    const scriptObj = typeof episode.scriptJson === "string" ? JSON.parse(episode.scriptJson) : episode.scriptJson;
    const scriptSceneCount = Array.isArray(scriptObj?.scenes) ? scriptObj.scenes.length : 24;
    const totalScenes = scriptSceneCount + 2; // script scenes + 2 key-art tracking scenes (-2 series key art, -1 episode key art)
    const completedScenes = agnesRows.filter((r) => r.status === "completed" && Boolean(r.providerVideoUrl));
    const downloadedScenes = agnesRows.filter((r) => r.downloadStatus === "downloaded" && r.normalizedOutputPath && existsSync(r.normalizedOutputPath));
    const pendingScenes = agnesRows.filter((r) => !r.providerTaskId || r.status === "pending" || r.status === "failed");
    const untrackedCount = Math.max(0, totalScenes - agnesRows.length);
    const totalPendingForSubmission = pendingScenes.length + untrackedCount;

    console.log(`[Asset Inventory] Series ${seriesId}, Episode ${episodeNumber}`);
    console.log(`  - Total scenes required: ${totalScenes}`);
    console.log(`  - Completed on Agnes: ${completedScenes.length}/${totalScenes}`);
    console.log(`  - In-Progress / Rendering on Agnes: ${syncResult.inProgress}`);
    console.log(`  - Pending Submission: ${totalPendingForSubmission}`);
    console.log(`  - Downloaded & Normalized: ${downloadedScenes.length}/${totalScenes}`);

    // If any scenes are pending submission, submit them
    if (totalPendingForSubmission > 0) {
      console.log(`\n[Action] Submitting ${totalPendingForSubmission} pending scene(s) to Agnes...`);
      const submitTool = buildSubmitAgnesSceneVideosTool(seriesState, {
        includeKeyArt: true,
        rotateOnCapacity: true,
      });
      try {
        const rawResult = await submitTool.invoke({ seriesId, episodeNumber });
        const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
        console.log(`[Submit Result]: status=${result.status}, attempted=${result.attemptedCount ?? 0}, alreadyAccepted=${result.alreadyAcceptedCount ?? 0}`);
      } catch (err: any) {
        console.warn(`[Submit Warning]: ${err.message}`);
      }
    } else {
      console.log(`\n[Pipeline] ✅ All required videos have already been submitted or completed. Nothing is pending for submission.`);
    }

    // Check if fully downloaded / ready for QA and assembly (used in watch mode)
    let allAssembled = false;
    if (options.watch) {
      if (completedScenes.length === totalScenes && downloadedScenes.length < totalScenes) {
        console.log(`\n[Action] All clips completed on Agnes! Downloading and normalizing clips...`);
        const downloadTool = buildDownloadAgnesSceneVideosTool(seriesState, {
          includeKeyArt: true,
          rotateOnCapacity: true,
        });
        const rawResult = await downloadTool.invoke({ seriesId, episodeNumber });
        const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
        console.log(`[Download Result]: status=${result.status}, completed=${result.completed}/${result.assetCount}`);
      }

      const updatedRows = await seriesState.listAgnesSceneGenerations(seriesId, episodeNumber);
      const readyForQa = updatedRows.filter((r) => r.downloadStatus === "downloaded" && r.normalizedOutputPath && existsSync(r.normalizedOutputPath));
      if (readyForQa.length === totalScenes) {
        console.log(`\n[Action] All clips downloaded! Running static media QA...`);
        const qaTool = buildAgnesVideoQaTool(seriesState);
        const rawQa = await qaTool.invoke({ seriesId, episodeNumber });
        const qaResult = typeof rawQa === "string" ? JSON.parse(rawQa) : rawQa;
        console.log(`[QA Result]: status=${qaResult.status}, passed=${qaResult.passed}/${qaResult.assetCount}`);

        if (qaResult.status === "passed" || qaResult.status === "ready") {
          console.log(`\n[Action] QA Passed! Assembling final episode video...`);
          const assemblyTool = buildEpisodeAssemblyTool(seriesState, { includeKeyArt: true });
          const rawAssembly = await assemblyTool.invoke({ seriesId, episodeNumber });
          const assemblyResult = typeof rawAssembly === "string" ? JSON.parse(rawAssembly) : rawAssembly;
          const finalPath = assemblyResult.path || assemblyResult.outputPath;
          if (finalPath && existsSync(finalPath)) {
            const stats = statSync(finalPath);
            console.log("\n=================================================");
            console.log(`>>> SUCCESS: Final Episode Video Assembled! <<<`);
            console.log(`Output File: ${finalPath}`);
            console.log(`File Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
            console.log("=================================================\n");
            allAssembled = true;
          }
        }
      }
    }

    return {
      totalScenes,
      completedCount: completedScenes.length,
      pendingCount: totalPendingForSubmission,
      inProgressCount: syncResult.inProgress,
      allAssembled,
    };
  };

  // Run initial submission check
  const firstCycle = await runCycle();

  // In default mode (no watch), we do not loop; we submit pending videos (or do nothing if none pending) and exit.
  if (!options.watch) {
    if (firstCycle.pendingCount === 0) {
      console.log(`[Pipeline] Done. Nothing was pending for submission.`);
    } else {
      console.log(`[Pipeline] Done. Submitted pending videos for Series ${seriesId}, Episode ${episodeNumber}.`);
    }
    return;
  }

  // Watch mode: loop until all scenes are completed and assembled
  if (firstCycle.allAssembled) return;

  for (let cycle = 2; cycle <= maxCycles; cycle++) {
    console.log(`\n>>> [Cycle ${cycle}/${maxCycles}] Waiting ${cooldownMs / 1000}s @ ${new Date().toISOString()}`);
    await sleep(cooldownMs);
    const result = await runCycle();
    if (result.allAssembled) return;
  }

  throw new Error(`Pipeline reached max cycles (${maxCycles}) without finishing assembly.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("runEpisodePipeline.ts")) {
  const cliArgs = parseCliArgs();
  runEpisodePipeline(cliArgs).catch((err) => {
    console.error("Pipeline failed:", err);
    process.exit(1);
  });
}
