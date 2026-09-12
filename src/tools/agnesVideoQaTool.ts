import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { analyzeImagesWithAnyApi } from "../providers/anyApiVisionClient.js";
import {
  AGNES_VIDEO_QA_POLICY_VERSION,
  buildAgnesVideoQaPrompts,
  createAgnesVideoContactSheet,
  createAgnesVideoQaRequestDigest,
  createCharacterReferenceBoard,
  parseAgnesVideoQaVerdict,
  planAgnesVideoQaBatches,
  type AgnesVideoQaAsset,
  type AgnesVideoQaBatch,
  type AgnesVideoQaBatchVerdict,
} from "../services/agnesVideoQaService.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
} from "../services/agnesKeyArtService.js";
import { canonicalizeKeyArtTitle } from "../services/keyArtTitleContract.js";
import { buildLockedCharacterIdentity } from "../services/characterSheetService.js";
import type { AgnesSceneGenerationRow, SeriesState } from "../state/seriesState.js";
import {
  agnesAssetSeedDiscriminator,
  buildAgnesQaRetryPrompt,
  createAgnesVideoRequestDigest,
  deriveAgnesAssetSeed,
  parseAgnesReferenceImageUrls,
} from "./agnesSceneVideoTool.js";

interface ScriptScene {
  sceneNumber: number;
  narrationText: string;
  environmentDescription: string;
  action: string;
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
  characterNames: string[];
  supportingEntities: string[];
}

export interface AgnesVideoQaToolOptions {
  analyze?: typeof analyzeImagesWithAnyApi;
  createContactSheet?: typeof createAgnesVideoContactSheet;
  createReferenceBoard?: typeof createCharacterReferenceBoard;
  maxVisionCalls?: number;
  preferredTargetsPerSheet?: number;
  maxRegenerations?: number;
  minConfidence?: number;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try { return parseStringArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function parseScriptScenes(scriptJson: unknown): ScriptScene[] {
  let root = scriptJson;
  if (typeof root === "string") {
    try { root = JSON.parse(root) as unknown; } catch { throw new Error("Persisted episode script is malformed."); }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Persisted episode script is missing.");
  }
  let scenes: unknown = (root as { scenes?: unknown }).scenes;
  if (typeof scenes === "string") {
    try { scenes = JSON.parse(scenes) as unknown; } catch { throw new Error("Persisted episode scenes are malformed."); }
  }
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("Persisted episode has no scenes.");
  return scenes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Persisted episode scene ${index + 1} is malformed.`);
    }
    const scene = entry as Record<string, unknown>;
    const sceneNumber = Number(scene.sceneNumber ?? index + 1);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) {
      throw new Error(`Persisted episode scene ${index + 1} has an invalid number.`);
    }
    return {
      sceneNumber,
      narrationText: String(scene.narrationText ?? "").trim(),
      environmentDescription: String(scene.environmentDescription ?? "").trim(),
      action: String(scene.action ?? "").trim(),
      sceneDetails: typeof scene.sceneDetails === "string" ? scene.sceneDetails.trim() : undefined,
      cameraAngle: typeof scene.cameraAngle === "string" ? scene.cameraAngle.trim() : undefined,
      lighting: typeof scene.lighting === "string" ? scene.lighting.trim() : undefined,
      characterNames: parseStringArray(scene.characterNames),
      supportingEntities: parseStringArray(scene.supportingEntities),
    };
  });
}

function supportingEntity(entry: string): { name: string; description: string } {
  const separator = entry.indexOf(":");
  return separator > 0
    ? { name: entry.slice(0, separator).trim(), description: entry.slice(separator + 1).trim() }
    : { name: entry.trim(), description: entry.trim() };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/giu, "[url omitted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redacted]")
    .slice(0, 1_000);
}

function assetFileStem(sceneNumber: number): string {
  if (sceneNumber === AGNES_SERIES_KEY_ART_TRACKING_SCENE) return "series_key_art";
  if (sceneNumber === AGNES_EPISODE_KEY_ART_TRACKING_SCENE) return "episode_key_art";
  return `scene_${String(sceneNumber).padStart(3, "0")}`;
}

function qaResultIsCurrent(params: {
  row: AgnesSceneGenerationRow;
  videoSha256: string;
  referenceBoardSha256: string;
  portraitSetDigest: string;
  model: string;
}): boolean {
  if (params.row.qaStatus !== "passed"
    || params.row.qaVideoSha256 !== params.videoSha256
    || params.row.qaModel !== params.model) return false;
  if (!params.row.qaResult || typeof params.row.qaResult !== "object" || Array.isArray(params.row.qaResult)) {
    return false;
  }
  const result = params.row.qaResult as Record<string, unknown>;
  return result.policyVersion === AGNES_VIDEO_QA_POLICY_VERSION
    && result.referenceBoardSha256 === params.referenceBoardSha256
    && result.portraitSetDigest === params.portraitSetDigest
    && result.videoSha256 === params.videoSha256
    && result.qaRequestDigest === params.row.qaRequestDigest
    && result.generationRequestDigest === params.row.requestDigest
    && result.renderRevision === params.row.renderRevision
    && result.model === params.model
    && result.sceneNumber === params.row.sceneNumber
    && result.pass === true;
}

async function requireUsableVideo(row: AgnesSceneGenerationRow): Promise<string> {
  if (row.status !== "completed" || row.downloadStatus !== "downloaded" || !row.normalizedOutputPath) {
    throw new Error(`${assetFileStem(row.sceneNumber)} is not completed and downloaded.`);
  }
  if (!existsSync(row.normalizedOutputPath)) {
    throw new Error(`${assetFileStem(row.sceneNumber)} is missing: ${row.normalizedOutputPath}`);
  }
  const details = await stat(row.normalizedOutputPath);
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`${assetFileStem(row.sceneNumber)} is empty: ${row.normalizedOutputPath}`);
  }
  if (!row.requestDigest) throw new Error(`${assetFileStem(row.sceneNumber)} has no request digest.`);
  return sha256File(row.normalizedOutputPath);
}

async function buildQaAssets(params: {
  seriesState: SeriesState;
  seriesId: number;
  episodeNumber: number;
}): Promise<{
  assets: AgnesVideoQaAsset[];
  rows: Map<number, AgnesSceneGenerationRow>;
  portraits: Array<{ name: string; path: string }>;
}> {
  const [series, episode, rows] = await Promise.all([
    params.seriesState.getSeriesInfo(params.seriesId),
    params.seriesState.getEpisodeByNumber(params.seriesId, params.episodeNumber),
    params.seriesState.listAgnesSceneGenerations(params.seriesId, params.episodeNumber, "text"),
  ]);
  if (!series) throw new Error(`Series ${params.seriesId} was not found.`);
  if (!episode) throw new Error(`Episode ${params.episodeNumber} was not found for series ${params.seriesId}.`);
  const scenes = parseScriptScenes(episode.scriptJson);
  const roster = series.charactersJson.length > 0
    ? series.charactersJson
    : await params.seriesState.getSeriesCharacters(params.seriesId);
  if (roster.length === 0) throw new Error("Video QA cannot run without a stored main-character roster.");
  const lockedRoster = new Map<string, { name: string; description: string; portraitPath: string }>();
  const portraits: Array<{ name: string; path: string }> = [];
  for (const character of roster) {
    const sheet = await params.seriesState.getCharacterSheet(params.seriesId, character.name);
    const portraitPath = sheet?.referenceImagePaths?.portrait?.path;
    if (!sheet?.approvedAt || !sheet.generationPrompt?.trim() || !portraitPath) {
      throw new Error(`Video QA requires the approved portrait/signature for ${character.name}.`);
    }
    const locked = {
      name: character.name,
      description: buildLockedCharacterIdentity({
        characterName: character.name,
        characterDescription: character.description,
        generationPrompt: sheet.generationPrompt,
      }),
      portraitPath,
    };
    lockedRoster.set(character.name, locked);
    portraits.push({ name: character.name, path: portraitPath });
  }
  const byScene = new Map(rows.map((row) => [row.sceneNumber, row] as const));
  const appearanceCounts = new Map<string, number>();
  for (const scene of scenes) {
    for (const name of scene.characterNames) {
      appearanceCounts.set(name, (appearanceCounts.get(name) ?? 0) + 1);
    }
  }
  const protagonist = [...roster].sort((left, right) => (
    (appearanceCounts.get(right.name) ?? 0) - (appearanceCounts.get(left.name) ?? 0)
    || roster.indexOf(left) - roster.indexOf(right)
  ))[0]!;
  const protagonistIdentity = lockedRoster.get(protagonist.name);
  if (!protagonistIdentity) throw new Error(`Protagonist ${protagonist.name} has no locked identity.`);
  const requiredNumbers = [
    AGNES_SERIES_KEY_ART_TRACKING_SCENE,
    AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    ...scenes.map(({ sceneNumber }) => sceneNumber),
  ];
  const missing = requiredNumbers.filter((sceneNumber) => !byScene.has(sceneNumber));
  if (missing.length > 0) {
    throw new Error(`Video QA is waiting for Agnes rows: ${missing.join(", ")}.`);
  }
  const keyAsset = (
    sceneNumber: number,
    kind: "series_key_art" | "episode_key_art",
    title: string,
  ): AgnesVideoQaAsset => {
    const row = byScene.get(sceneNumber)!;
    return {
      sceneNumber,
      kind,
      label: kind === "series_key_art" ? "Series key art" : "Episode key art",
      videoPath: row.normalizedOutputPath ?? "",
      durationSeconds: row.requestedDurationSeconds,
      requestDigest: row.requestDigest ?? "",
      renderRevision: row.renderRevision,
      expectedTitle: title,
      expectedCast: [{ name: protagonistIdentity.name, description: protagonistIdentity.description }],
    };
  };
  const assets: AgnesVideoQaAsset[] = [
    keyAsset(
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      "series_key_art",
      canonicalizeKeyArtTitle(series.conceptName, "series"),
    ),
    keyAsset(
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      "episode_key_art",
      canonicalizeKeyArtTitle(episode.title, "episode"),
    ),
  ];
  for (const scene of scenes) {
    const row = byScene.get(scene.sceneNumber)!;
    const mainCast = scene.characterNames.map((name) => {
      const character = lockedRoster.get(name);
      if (!character) throw new Error(`Scene ${scene.sceneNumber} names unknown main character ${name}.`);
      return { name: character.name, description: character.description };
    });
    assets.push({
      sceneNumber: scene.sceneNumber,
      kind: "scene",
      label: `Scene ${scene.sceneNumber}`,
      videoPath: row.normalizedOutputPath ?? "",
      durationSeconds: row.requestedDurationSeconds,
      requestDigest: row.requestDigest ?? "",
      renderRevision: row.renderRevision,
      narrationText: scene.narrationText,
      environmentDescription: scene.environmentDescription,
      action: scene.action,
      sceneDetails: scene.sceneDetails,
      cameraAngle: scene.cameraAngle,
      lighting: scene.lighting,
      expectedCast: [...mainCast, ...scene.supportingEntities.map(supportingEntity)],
    });
  }
  return { assets, rows: byScene, portraits };
}

async function runQa(
  seriesState: SeriesState,
  seriesId: number,
  episodeNumber: number,
  options: AgnesVideoQaToolOptions,
): Promise<string> {
  const analyze = options.analyze ?? analyzeImagesWithAnyApi;
  const createContactSheet = options.createContactSheet ?? createAgnesVideoContactSheet;
  const createReferenceBoard = options.createReferenceBoard ?? createCharacterReferenceBoard;
  const model = CONFIG.anyApiVideoQaModel;
  const maxRegenerations = Math.min(1, Math.max(0, options.maxRegenerations ?? CONFIG.videoQaMaxRegenerations));
  const minConfidence = options.minConfidence ?? CONFIG.videoQaMinConfidence;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error("Agnes video QA minimum confidence must be from 0 through 1.");
  }
  const { assets, rows, portraits } = await buildQaAssets({ seriesState, seriesId, episodeNumber });
  const qaDir = path.join(
    CONFIG.outputDir,
    `series_${seriesId}`,
    `episode_${episodeNumber}`,
    "agnes_text",
    "qa",
  );
  await mkdir(qaDir, { recursive: true });
  const portraitSourceDigests = await Promise.all(portraits.map(async (portrait) => ({
    name: portrait.name,
    sha256: await sha256File(portrait.path),
  })));
  const portraitSetDigest = createHash("sha256")
    .update(JSON.stringify(portraitSourceDigests))
    .digest("hex");
  const referenceBoardPath = path.join(
    qaDir,
    "reference_boards",
    `characters_${portraitSetDigest.slice(0, 16)}.jpg`,
  );
  // These are cheap derived artifacts. Rebuild them atomically instead of
  // trusting a non-empty JPEG left by an interrupted earlier process.
  await createReferenceBoard({
    portraits,
    outputPath: referenceBoardPath,
  });
  const referenceBoardSha256 = await sha256File(referenceBoardPath);
  const videoShaByScene = new Map<number, string>();
  for (const asset of assets) {
    const row = rows.get(asset.sceneNumber)!;
    const videoSha = await requireUsableVideo(row);
    videoShaByScene.set(asset.sceneNumber, videoSha);
  }
  const currentPassed = new Set(assets.filter((asset) => qaResultIsCurrent({
    row: rows.get(asset.sceneNumber)!,
    videoSha256: videoShaByScene.get(asset.sceneNumber)!,
    referenceBoardSha256,
    portraitSetDigest,
    model,
  })).map(({ sceneNumber }) => sceneNumber));
  const exhausted = assets.filter((asset) => rows.get(asset.sceneNumber)?.qaStatus === "exhausted");
  if (exhausted.length > 0) {
    return JSON.stringify({
      status: "exhausted",
      phase: "video_qa",
      stopRun: true,
      exhaustedAssets: exhausted.map(({ sceneNumber, label }) => ({ sceneNumber, label })),
      nextAction: "Manual review is required; the single automatic Agnes rerender has already failed QA.",
    });
  }
  const batches = planAgnesVideoQaBatches({
    assets,
    preferredTargetsPerSheet: options.preferredTargetsPerSheet,
    maxVisionCalls: options.maxVisionCalls,
  });
  const results: Array<Record<string, unknown>> = [];
  let apiCalls = 0;
  let requeuedCount = 0;
  let passedCount = currentPassed.size;
  let pendingError: string | null = null;
  const seriesSeed = await seriesState.getOrCreateSeriesAgnesSeed(seriesId, CONFIG.agnesSeed);

  for (const plannedBatch of batches) {
    const targets = plannedBatch.targets.filter(({ sceneNumber }) => !currentPassed.has(sceneNumber));
    if (targets.length === 0) continue;
    const batch: AgnesVideoQaBatch = { ...plannedBatch, targets };
    const sheetSourceDigest = createHash("sha256").update(JSON.stringify({
      policyVersion: AGNES_VIDEO_QA_POLICY_VERSION,
      targets: targets.map((asset) => ({
        sceneNumber: asset.sceneNumber,
        requestDigest: asset.requestDigest,
        renderRevision: asset.renderRevision,
        videoSha256: videoShaByScene.get(asset.sceneNumber),
      })),
      context: batch.context ? {
        sceneNumber: batch.context.sceneNumber,
        requestDigest: batch.context.requestDigest,
        videoSha256: videoShaByScene.get(batch.context.sceneNumber),
      } : null,
    })).digest("hex");
    const contactSheetPath = path.join(
      qaDir,
      "contact_sheets",
      `batch_${String(batch.batchNumber).padStart(2, "0")}_${sheetSourceDigest.slice(0, 16)}.jpg`,
    );
    try {
      await createContactSheet({ batch, outputPath: contactSheetPath });
      const [contactSheetBytes, referenceBoardBytes] = await Promise.all([
        readFile(contactSheetPath),
        readFile(referenceBoardPath),
      ]);
      const contactSheetSha256 = createHash("sha256").update(contactSheetBytes).digest("hex");
      const qaRequestDigest = createAgnesVideoQaRequestDigest({
        model,
        contactSheetSha256,
        referenceBoardSha256,
        assets: targets.map((asset) => ({
          sceneNumber: asset.sceneNumber,
          requestDigest: asset.requestDigest,
          renderRevision: asset.renderRevision,
          videoSha256: videoShaByScene.get(asset.sceneNumber)!,
        })),
      });
      const prompts = buildAgnesVideoQaPrompts(batch);
      apiCalls += 1;
      console.log("[AgnesVideoQA] batch_analysis_start", {
        batchNumber: batch.batchNumber,
        targetSceneNumbers: targets.map(({ sceneNumber }) => sceneNumber),
        apiCall: apiCalls,
        plannedCallCount: batches.length,
      });
      const raw = await analyze({
        ...prompts,
        images: [
          { bytes: contactSheetBytes, mimeType: "image/jpeg", label: "VIDEO CONTACT SHEET" },
          { bytes: referenceBoardBytes, mimeType: "image/jpeg", label: "CANONICAL CHARACTER PORTRAITS" },
        ],
        model,
      });
      const verdict: AgnesVideoQaBatchVerdict = parseAgnesVideoQaVerdict(
        raw,
        targets.map(({ sceneNumber }) => sceneNumber),
      );
      for (const assetVerdict of verdict.assets) {
        const asset = targets.find(({ sceneNumber }) => sceneNumber === assetVerdict.sceneNumber)!;
        const row = rows.get(asset.sceneNumber)!;
        const videoSha256 = videoShaByScene.get(asset.sceneNumber)!;
        const storedResult = {
          policyVersion: AGNES_VIDEO_QA_POLICY_VERSION,
          model,
          referenceBoardSha256,
          portraitSetDigest,
          contactSheetSha256,
          videoSha256,
          qaRequestDigest,
          generationRequestDigest: row.requestDigest,
          renderRevision: row.renderRevision,
          ...assetVerdict,
        };
        if (assetVerdict.confidence < minConfidence) {
          const confidenceError =
            `Gemini QA confidence ${assetVerdict.confidence.toFixed(3)} is below the ` +
            `${minConfidence.toFixed(3)} production threshold; preserving this render for re-analysis.`;
          pendingError ??= confidenceError;
          await seriesState.recordAgnesVideoQaError({
            seriesId,
            episodeNumber,
            sceneNumber: asset.sceneNumber,
            variant: "text",
            expectedRequestDigest: row.requestDigest!,
            expectedRenderRevision: row.renderRevision,
            expectedNormalizedOutputPath: row.normalizedOutputPath!,
            expectedQaStatus: row.qaStatus,
            expectedQaRequestDigest: row.qaRequestDigest,
            error: confidenceError,
          });
          results.push({
            sceneNumber: asset.sceneNumber,
            status: "low_confidence",
            confidence: assetVerdict.confidence,
          });
          continue;
        }
        if (assetVerdict.pass) {
          const persisted = await seriesState.recordAgnesVideoQaVerdict({
            seriesId,
            episodeNumber,
            sceneNumber: asset.sceneNumber,
            variant: "text",
            expectedRequestDigest: row.requestDigest!,
            expectedRenderRevision: row.renderRevision,
            expectedNormalizedOutputPath: row.normalizedOutputPath!,
            expectedQaStatus: row.qaStatus,
            expectedQaRequestDigest: row.qaRequestDigest,
            qaRequestDigest,
            videoSha256,
            result: storedResult,
            contactSheetPath,
            model,
            status: "passed",
          });
          if (persisted.recorded) {
            passedCount += 1;
            currentPassed.add(asset.sceneNumber);
          }
          results.push({ sceneNumber: asset.sceneNumber, status: persisted.recorded ? "passed" : "stale" });
          continue;
        }
        if (row.renderRevision >= maxRegenerations) {
          const persisted = await seriesState.recordAgnesVideoQaVerdict({
            seriesId,
            episodeNumber,
            sceneNumber: asset.sceneNumber,
            variant: "text",
            expectedRequestDigest: row.requestDigest!,
            expectedRenderRevision: row.renderRevision,
            expectedNormalizedOutputPath: row.normalizedOutputPath!,
            expectedQaStatus: row.qaStatus,
            expectedQaRequestDigest: row.qaRequestDigest,
            qaRequestDigest,
            videoSha256,
            result: storedResult,
            contactSheetPath,
            model,
            status: "exhausted",
          });
          results.push({
            sceneNumber: asset.sceneNumber,
            status: persisted.recorded ? "exhausted" : "stale",
            issueCodes: assetVerdict.issues.map(({ code }) => code),
          });
          continue;
        }
        const retryPrompt = buildAgnesQaRetryPrompt(
          row.prompt,
          assetVerdict.issues.map(({ code }) => code),
        );
        const retrySeed = deriveAgnesAssetSeed(
          seriesSeed,
          episodeNumber,
          `${agnesAssetSeedDiscriminator(asset.sceneNumber)}:qa-retry-1`,
        );
        const referenceImageUrls = parseAgnesReferenceImageUrls(row.publicReferenceUrl);
        const retryRequestDigest = createAgnesVideoRequestDigest({
          prompt: retryPrompt,
          providerSeconds: row.providerDurationSeconds,
          seed: retrySeed,
          duration: row.requestedDurationSeconds,
          mode: referenceImageUrls.length > 0 ? "reference" : "text",
          referenceImageUrls,
        });
        const archivePath = path.join(
          qaDir,
          "rejected",
          `${assetFileStem(asset.sceneNumber)}_render_0_${videoSha256.slice(0, 16)}.mp4`,
        );
        await mkdir(path.dirname(archivePath), { recursive: true });
        if (!existsSync(archivePath)) await copyFile(row.normalizedOutputPath!, archivePath);
        const requeued = await seriesState.requeueAgnesSceneAfterQaFailure({
          seriesId,
          episodeNumber,
          sceneNumber: asset.sceneNumber,
          variant: "text",
          expectedRequestDigest: row.requestDigest!,
          expectedRenderRevision: row.renderRevision,
          expectedNormalizedOutputPath: row.normalizedOutputPath!,
          expectedQaStatus: row.qaStatus,
          expectedQaRequestDigest: row.qaRequestDigest,
          qaRequestDigest,
          videoSha256,
          result: storedResult,
          contactSheetPath,
          model,
          retryPrompt,
          retryRequestDigest,
          retrySeed,
          archivedVideoPath: archivePath,
        });
        if (requeued.requeued) requeuedCount += 1;
        results.push({
          sceneNumber: asset.sceneNumber,
          status: requeued.requeued ? "regeneration_queued" : "stale",
          issueCodes: assetVerdict.issues.map(({ code }) => code),
        });
      }
      console.log("[AgnesVideoQA] batch_analysis_complete", {
        batchNumber: batch.batchNumber,
        passed: verdict.assets.filter(({ pass }) => pass).length,
        failed: verdict.assets.filter(({ pass }) => !pass).length,
      });
    } catch (error) {
      pendingError = safeError(error);
      for (const target of targets) {
        const row = rows.get(target.sceneNumber)!;
        await seriesState.recordAgnesVideoQaError({
          seriesId,
          episodeNumber,
          sceneNumber: target.sceneNumber,
          variant: "text",
          expectedRequestDigest: row.requestDigest!,
          expectedRenderRevision: row.renderRevision,
          expectedNormalizedOutputPath: row.normalizedOutputPath!,
          expectedQaStatus: row.qaStatus,
          expectedQaRequestDigest: row.qaRequestDigest,
          error: pendingError,
        });
      }
      console.warn("[AgnesVideoQA] batch_analysis_error", {
        batchNumber: batch.batchNumber,
        targetSceneNumbers: targets.map(({ sceneNumber }) => sceneNumber),
        error: pendingError,
      });
      break;
    }
  }

  const refreshedRows = await seriesState.listAgnesSceneGenerations(seriesId, episodeNumber, "text");
  const exhaustedRows = refreshedRows.filter(({ qaStatus }) => qaStatus === "exhausted");
  const passedRows = refreshedRows.filter((row) => {
    const videoSha256 = videoShaByScene.get(row.sceneNumber);
    return Boolean(videoSha256) && qaResultIsCurrent({
      row,
      videoSha256: videoSha256!,
      referenceBoardSha256,
      portraitSetDigest,
      model,
    });
  });
  const status = exhaustedRows.length > 0
    ? "exhausted"
    : requeuedCount > 0
      ? "regeneration_required"
      : pendingError
        ? "pending"
        : passedRows.length === assets.length
          ? "passed"
          : "pending";
  return JSON.stringify({
    status,
    phase: "video_qa",
    stopRun: status !== "passed",
    assetCount: assets.length,
    passed: passedRows.length,
    requeued: requeuedCount,
    exhausted: exhaustedRows.length,
    apiCalls,
    maxVisionCalls: options.maxVisionCalls ?? CONFIG.videoQaMaxVisionCalls,
    minConfidence,
    contactSheetResolution: "3072px wide; 1024x576 per sampled frame",
    ...(pendingError ? { error: pendingError } : {}),
    results,
    nextAction: status === "passed"
      ? "Call assemble_episode_video."
      : status === "regeneration_required"
        ? "End this run. A later run will submit only the QA-rejected Agnes assets through the normal durable scheduler."
        : status === "exhausted"
          ? "Stop. At least one asset failed its single automatic rerender and requires manual review."
          : "End this run and retry video QA later; completed batch verdicts were preserved.",
  });
}

export function buildAgnesVideoQaTool(
  seriesState: SeriesState,
  options: AgnesVideoQaToolOptions = {},
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "qa_agnes_episode_videos",
    description:
      "After both title videos and every scene are downloaded, builds high-resolution start/middle/end contact sheets, compares them with approved portraits using Gemini through AnyAPI, and persists source-bound per-asset verdicts. It permits at most one durable Agnes rerender for a rejected asset and must pass before assembly.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
    }).strict(),
    func: ({ seriesId, episodeNumber }) => runQa(
      seriesState,
      seriesId,
      episodeNumber,
      options,
    ),
  });
}
