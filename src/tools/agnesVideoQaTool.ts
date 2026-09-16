import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { CONFIG } from "../config.js";
import {
  AGNES_STATIC_VIDEO_QA_MODEL,
  AGNES_STATIC_VIDEO_QA_PIPELINE,
  AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
  AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
  createAgnesStaticEpisodeAssetSetDigest,
  createAgnesStaticVideoQaRequestDigest,
  currentAgnesStaticVideoQaPolicyDigest,
  isCurrentAgnesStaticQaResult,
  type AgnesStaticMediaFacts,
  type AgnesStaticQaResult,
} from "../services/agnesStaticVideoQaService.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
} from "../services/agnesKeyArtService.js";
import { canonicalizeSceneCast } from "../services/sceneCastCanonicalizer.js";
import type { AgnesSceneGenerationRow, SeriesState } from "../state/seriesState.js";
import { AGNES_MAX_REFERENCE_IMAGES } from "../providers/agnes/index.js";
import {
  VIDEO_DURATION_TOLERANCE_SECONDS,
  createAgnesVideoRequestDigest,
} from "./agnesSceneVideoTool.js";

interface ScriptScene {
  sceneNumber: number;
  narrationText: string;
  characterNames: string[];
  supportingEntities: string[];
}

export interface AgnesStaticMediaProbe extends AgnesStaticMediaFacts {}

export interface AgnesVideoQaToolOptions {
  /** Injectable for focused tests; production always uses CONFIG.ffprobePath. */
  probeMedia?: (filePath: string) => Promise<AgnesStaticMediaProbe>;
  durationToleranceSeconds?: number;
  minimumVideoBytes?: number;
}

interface StaticIssue {
  code: string;
  message: string;
  relatedSceneNumbers?: number[];
}

interface StaticCheck {
  code: string;
  pass: boolean;
  detail?: string;
}

interface QaAsset {
  sceneNumber: number;
  label: string;
  row: AgnesSceneGenerationRow;
  expectedMainCast: string[];
  expectedLedgerCast: string[];
  referenceImageUrls: string[];
  videoSha256: string;
  media: AgnesStaticMediaFacts;
  checks: StaticCheck[];
  issues: StaticIssue[];
}

const MINIMUM_NORMALIZED_VIDEO_BYTES = 1_024;

function parseStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try { return parseStringArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value)
    ? value.map(String).map((item) => item.replace(/\s+/gu, " ").trim()).filter(Boolean)
    : [];
}

function parseScriptScenes(scriptJson: unknown, mainCharacterNames: readonly string[]): ScriptScene[] {
  let root = scriptJson;
  if (typeof root === "string") {
    try { root = JSON.parse(root) as unknown; } catch { throw new Error("Persisted episode script is malformed."); }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Persisted episode script is missing.");
  }
  let rawScenes: unknown = (root as { scenes?: unknown }).scenes;
  if (typeof rawScenes === "string") {
    try { rawScenes = JSON.parse(rawScenes) as unknown; } catch {
      throw new Error("Persisted episode scenes are malformed.");
    }
  }
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new Error("Persisted episode has no scenes.");
  }
  const seen = new Set<number>();
  return rawScenes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Persisted episode scene ${index + 1} is malformed.`);
    }
    const raw = entry as Record<string, unknown>;
    const sceneNumber = Number(raw.sceneNumber ?? index + 1);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0 || seen.has(sceneNumber)) {
      throw new Error(`Persisted episode scene ${index + 1} has an invalid or duplicate number.`);
    }
    seen.add(sceneNumber);
    const canonical = canonicalizeSceneCast({
      sceneNumber,
      narrationText: String(raw.narrationText ?? "").trim(),
      characterNames: parseStringArray(raw.characterNames),
      supportingEntities: parseStringArray(raw.supportingEntities),
    }, { mainCharacterNames });
    const ambiguous = canonical.audit.unresolved.find(
      ({ kind }) => kind === "ambiguous_main_character_alias",
    );
    if (ambiguous?.kind === "ambiguous_main_character_alias") {
      throw new Error(
        `Scene ${sceneNumber} contains ambiguous main-character alias ${JSON.stringify(ambiguous.alias)}.`,
      );
    }
    const scene = canonical.scene as ScriptScene;
    return {
      sceneNumber,
      narrationText: scene.narrationText,
      characterNames: scene.characterNames,
      supportingEntities: scene.supportingEntities,
    };
  });
}

function supportingEntityName(entry: string, index: number): string {
  const separator = entry.indexOf(":");
  const name = (separator > 0 ? entry.slice(0, separator) : entry).replace(/\s+/gu, " ").trim();
  return name || `Supporting entity ${index + 1}`;
}

function assetLabel(sceneNumber: number): string {
  if (sceneNumber === AGNES_SERIES_KEY_ART_TRACKING_SCENE) return "series key art";
  if (sceneNumber === AGNES_EPISODE_KEY_ART_TRACKING_SCENE) return "episode key art";
  return `scene ${sceneNumber}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function runProcess(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

async function probeStaticMedia(filePath: string): Promise<AgnesStaticMediaProbe> {
  const stdout = await runProcess(CONFIG.ffprobePath, [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", filePath,
  ]);
  let parsed: unknown;
  try { parsed = JSON.parse(stdout) as unknown; } catch {
    throw new Error(`ffprobe returned malformed JSON for ${filePath}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ffprobe returned no media metadata for ${filePath}.`);
  }
  const root = parsed as Record<string, unknown>;
  const streams = Array.isArray(root.streams)
    ? root.streams.filter((entry): entry is Record<string, unknown> => (
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      ))
    : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const video = videoStreams[0] ?? {};
  const format = root.format && typeof root.format === "object" && !Array.isArray(root.format)
    ? root.format as Record<string, unknown>
    : {};
  return {
    durationSeconds: Number(format.duration ?? video.duration),
    codecName: typeof video.codec_name === "string" ? video.codec_name.trim().toLowerCase() : "",
    width: Number(video.width),
    height: Number(video.height),
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
  };
}

function parseReferenceUrls(value: string | null): { urls: string[]; error?: string } {
  const raw = value?.trim();
  if (!raw) return { urls: [] };
  let candidates: unknown;
  try { candidates = JSON.parse(raw) as unknown; } catch { candidates = [raw]; }
  if (!Array.isArray(candidates)) return { urls: [], error: "reference URL payload is not an array" };
  if (candidates.length > AGNES_MAX_REFERENCE_IMAGES) {
    return { urls: [], error: `reference URL payload exceeds Agnes's ${AGNES_MAX_REFERENCE_IMAGES}-image limit` };
  }
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") return { urls: [], error: "reference URL payload contains a non-string value" };
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        return { urls: [], error: "reference images must use public credential-free HTTPS URLs" };
      }
      urls.push(parsed.href);
    } catch {
      return { urls: [], error: "reference URL payload contains an invalid URL" };
    }
  }
  if (new Set(urls).size !== urls.length) {
    return { urls, error: "the same character reference URL is supplied more than once" };
  }
  return { urls };
}

/** Accepts an optional canonical filename before the exact portrait name. */
export function parseAgnesPromptReferenceMap(
  prompt: string,
  rosterNames: readonly string[],
): { names: string[]; error?: string } {
  const marker = "REFERENCE IMAGE IDENTITY MAP —";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return { names: [] };
  const tail = prompt.slice(markerIndex + marker.length);
  const endIndex = tail.search(/\.\s*Treat each portrait\b/iu);
  const section = (endIndex >= 0 ? tail.slice(0, endIndex) : tail).trim();
  const entries = section.split(/\s*;\s*(?=<Picture\s+\d+>)/iu).filter(Boolean);
  if (entries.length === 0) return { names: [], error: "reference identity map is empty" };
  const names: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const pictureMatch = entry.match(/^<Picture\s+(\d+)>/iu);
    if (!pictureMatch || Number(pictureMatch[1]) !== index + 1) {
      return { names: [], error: "reference identity map picture numbers are not contiguous and ordered" };
    }
    const nameMatch = entry.match(/\b(?:the\s+)?approved portrait of\s+(.+?)\s*[.]?$/iu);
    if (!nameMatch) return { names: [], error: `Picture ${index + 1} has no approved-portrait name` };
    const candidate = nameMatch[1]!.replace(/\s+/gu, " ").trim().replace(/[.]$/u, "");
    const canonical = rosterNames.find((name) => name.toLocaleLowerCase() === candidate.toLocaleLowerCase());
    if (!canonical) return { names: [], error: `Picture ${index + 1} names unlisted character ${JSON.stringify(candidate)}` };
    names.push(canonical);
  }
  if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    return { names, error: "reference identity map repeats a character" };
  }
  return { names };
}

function parsePromptCastLedger(prompt: string): { count: number; names: string[] } | null {
  const scene = prompt.match(
    /VISIBLE CAST — EXACTLY\s+(\d+)\s+FIGURES?, NO OTHERS:\s*([\s\S]*?)(?=\.\s*Each listed identity appears once)/iu,
  );
  const keyArt = prompt.match(
    /EXACT ON-SCREEN CAST LEDGER —\s+(\d+)\s+TOTAL CHARACTER FIGURES?, AND NO OTHERS:\s*([\s\S]*?)(?=\.)/iu,
  );
  const match = scene ?? keyArt;
  if (!match) return null;
  const names = [...match[2]!.matchAll(/\[([^\]]+)\]\s*(?:×|x)\s*1/giu)]
    .map((entry) => entry[1]!.replace(/\s+/gu, " ").trim());
  return { count: Number(match[1]), names };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => (
    name.toLocaleLowerCase() === right[index]?.toLocaleLowerCase()
  ));
}

function approvedPublicUrl(sheet: unknown): string | null {
  if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) return null;
  const referenceImagePaths = (sheet as Record<string, unknown>).referenceImagePaths;
  if (!referenceImagePaths || typeof referenceImagePaths !== "object" || Array.isArray(referenceImagePaths)) return null;
  const portrait = (referenceImagePaths as Record<string, unknown>).portrait;
  if (!portrait || typeof portrait !== "object" || Array.isArray(portrait)) return null;
  const record = portrait as Record<string, unknown>;
  const value = typeof record.publicUrl === "string"
    ? record.publicUrl
    : typeof record.public_url === "string"
      ? record.public_url
      : null;
  if (!value?.trim()) return null;
  try { return new URL(value).href; } catch { return null; }
}

function addCheck(
  asset: QaAsset,
  code: string,
  pass: boolean,
  failureMessage: string,
  detail?: string,
): void {
  asset.checks.push({ code, pass, ...(detail ? { detail } : {}) });
  if (!pass) asset.issues.push({ code, message: failureMessage });
}

async function buildQaAssets(params: {
  seriesState: SeriesState;
  seriesId: number;
  episodeNumber: number;
  probeMedia: (filePath: string) => Promise<AgnesStaticMediaProbe>;
  durationToleranceSeconds: number;
  minimumVideoBytes: number;
}): Promise<QaAsset[]> {
  const [series, episode, rows] = await Promise.all([
    params.seriesState.getSeriesInfo(params.seriesId),
    params.seriesState.getEpisodeByNumber(params.seriesId, params.episodeNumber),
    params.seriesState.listAgnesSceneGenerations(params.seriesId, params.episodeNumber, "text"),
  ]);
  if (!series) throw new Error(`Series ${params.seriesId} was not found.`);
  if (!episode) throw new Error(`Episode ${params.episodeNumber} was not found for series ${params.seriesId}.`);
  const roster = series.charactersJson.length > 0
    ? series.charactersJson
    : await params.seriesState.getSeriesCharacters(params.seriesId);
  const rosterNames = roster.map(({ name }) => name.replace(/\s+/gu, " ").trim());
  if (rosterNames.length === 0 || rosterNames.length > AGNES_MAX_REFERENCE_IMAGES) {
    throw new Error(`Static video QA requires a series roster of 1-${AGNES_MAX_REFERENCE_IMAGES} main characters.`);
  }
  const approvedUrls = new Map<string, string>();
  for (const name of rosterNames) {
    const publicUrl = approvedPublicUrl(await params.seriesState.getCharacterSheet(params.seriesId, name));
    if (publicUrl) approvedUrls.set(name, publicUrl);
  }
  const scenes = parseScriptScenes(episode.scriptJson, rosterNames);
  const byScene = new Map(rows.map((row) => [row.sceneNumber, row] as const));
  const sceneByNumber = new Map(scenes.map((scene) => [scene.sceneNumber, scene] as const));
  const requiredNumbers = [
    AGNES_SERIES_KEY_ART_TRACKING_SCENE,
    AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    ...scenes.map(({ sceneNumber }) => sceneNumber),
  ];
  const missing = requiredNumbers.filter((sceneNumber) => !byScene.has(sceneNumber));
  if (missing.length > 0) {
    throw new Error(`Static video QA is waiting for Agnes rows: ${missing.map(assetLabel).join(", ")}.`);
  }

  const assets: QaAsset[] = [];
  for (const sceneNumber of requiredNumbers) {
    const row = byScene.get(sceneNumber)!;
    const label = assetLabel(sceneNumber);
    if (row.status !== "completed" || row.downloadStatus !== "downloaded" || !row.normalizedOutputPath) {
      throw new Error(`Static video QA cannot run: ${label} is not completed and downloaded.`);
    }
    if (!row.requestDigest || !/^[a-f0-9]{64}$/u.test(row.requestDigest)) {
      throw new Error(`Static video QA cannot run: ${label} has no valid generation request digest.`);
    }
    if (!existsSync(row.normalizedOutputPath)) {
      throw new Error(`Static video QA cannot run: ${label} is missing at ${row.normalizedOutputPath}.`);
    }
    const file = await stat(row.normalizedOutputPath);
    if (!file.isFile() || file.size < params.minimumVideoBytes) {
      throw new Error(`Static video QA cannot run: ${label} is empty or truncated.`);
    }
    let probeError: string | null = null;
    let media: AgnesStaticMediaFacts;
    try {
      media = await params.probeMedia(row.normalizedOutputPath);
    } catch (error) {
      probeError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      media = {
        durationSeconds: -1,
        codecName: "",
        width: 0,
        height: 0,
        videoStreamCount: 0,
        audioStreamCount: 0,
      };
    }
    const reference = parseReferenceUrls(row.publicReferenceUrl);
    const promptMap = parseAgnesPromptReferenceMap(row.prompt, rosterNames);
    const scriptScene = sceneByNumber.get(sceneNumber);
    // A series title card is the canonical ensemble asset, so its request must
    // name and reference the complete fixed roster. Episode title cards retain
    // their intentionally narrower cast as declared by the persisted request.
    const expectedMainCast = scriptScene
      ? scriptScene.characterNames
      : sceneNumber === AGNES_SERIES_KEY_ART_TRACKING_SCENE
        ? rosterNames
        : promptMap.names;
    const expectedLedgerCast = scriptScene
      ? [...scriptScene.characterNames, ...scriptScene.supportingEntities.map(supportingEntityName)]
      : expectedMainCast;
    const asset: QaAsset = {
      sceneNumber,
      label,
      row,
      expectedMainCast,
      expectedLedgerCast,
      referenceImageUrls: reference.urls,
      videoSha256: await sha256File(row.normalizedOutputPath),
      media,
      checks: [],
      issues: [],
    };

    addCheck(
      asset, "media_probe_succeeded", probeError === null,
      `${label} cannot be decoded by ffprobe: ${probeError ?? "unknown probe failure"}`,
    );

    addCheck(asset, "reference_urls_valid", !reference.error, reference.error ?? "Invalid character reference URLs.");
    addCheck(
      asset, "reference_count_matches_visible_main_cast",
      reference.urls.length === expectedMainCast.length,
      `${label} declares ${expectedMainCast.length} visible main characters but persists ${reference.urls.length} reference URLs.`,
    );
    const normalizedMainCast = expectedMainCast.map((name) => name.toLocaleLowerCase());
    addCheck(
      asset, "visible_main_cast_is_unique_and_within_reference_limit",
      expectedMainCast.length <= AGNES_MAX_REFERENCE_IMAGES
        && new Set(normalizedMainCast).size === normalizedMainCast.length,
      `${label}'s visible main-character cast repeats a name or exceeds Agnes's ${AGNES_MAX_REFERENCE_IMAGES}-reference limit.`,
    );
    addCheck(asset, "reference_identity_map_valid", !promptMap.error, promptMap.error ?? "Invalid reference identity map.");
    addCheck(
      asset, "reference_identity_map_matches_visible_main_cast",
      sameNames(promptMap.names, expectedMainCast),
      `${label}'s ordered Picture mapping does not match its visible main-character cast.`,
    );
    const missingApprovedUrls = expectedMainCast.filter((name) => !approvedUrls.has(name));
    addCheck(
      asset, "approved_public_portraits_present", missingApprovedUrls.length === 0,
      `${label} is missing an approved public portrait URL for: ${missingApprovedUrls.join(", ")}.`,
    );
    const wrongApprovedUrls = expectedMainCast.flatMap((name, index) => {
      const expected = approvedUrls.get(name);
      return expected && expected !== reference.urls[index]
        ? [`${name}: expected ${expected}, received ${reference.urls[index] ?? "none"}`]
        : [];
    });
    addCheck(
      asset, "reference_urls_match_approved_portraits", wrongApprovedUrls.length === 0,
      `${label} uses a character URL that does not match the approved public portrait.`,
      wrongApprovedUrls.join(" | "),
    );

    const ledger = parsePromptCastLedger(row.prompt);
    const ledgerPass = expectedLedgerCast.length === 0
      ? ledger === null && /EMPTY-SCENE LOCK\b/iu.test(row.prompt)
      : Boolean(ledger)
        && ledger!.count === expectedLedgerCast.length
        && ledger!.names.length === ledger!.count
        && sameNames(ledger!.names, expectedLedgerCast);
    addCheck(
      asset, "exact_cast_ledger_matches_script", ledgerPass,
      `${label}'s exact cast ledger does not match its declared main and supporting figures.`,
    );

    const requestDigestMatches = row.seed !== null
      && Number.isSafeInteger(row.seed)
      && createAgnesVideoRequestDigest({
        prompt: row.prompt,
        providerSeconds: row.providerDurationSeconds,
        seed: row.seed,
        duration: row.requestedDurationSeconds,
        mode: reference.urls.length > 0 ? "reference" : "text",
        referenceImageUrls: reference.urls,
      }) === row.requestDigest;
    addCheck(
      asset, "generation_request_digest_matches", requestDigestMatches,
      `${label}'s prompt, seed, duration, mode, or references no longer match its persisted request digest.`,
    );
    addCheck(
      asset, "agnes_duration_contract",
      Number.isFinite(row.requestedDurationSeconds)
        && row.requestedDurationSeconds > 0
        && row.requestedDurationSeconds <= 12
        && Number.isSafeInteger(row.providerDurationSeconds)
        && row.providerDurationSeconds >= 4
        && row.providerDurationSeconds <= 12,
      `${label} violates the one-request Agnes duration contract (target <=12s; provider integer 4-12s).`,
    );
    addCheck(
      asset, "one_1920x1080_h264_video_stream",
      media.videoStreamCount === 1 && media.codecName === "h264"
        && media.width === 1_920 && media.height === 1_080,
      `${label} must contain exactly one 1920x1080 H.264 video stream.`,
      `${media.codecName || "unknown"} ${media.width}x${media.height}; ${media.videoStreamCount} video streams`,
    );
    addCheck(
      asset, "video_contains_no_audio", media.audioStreamCount === 0,
      `${label} contains an audio stream; Agnes clips must stay silent because narration is assembled separately.`,
    );
    addCheck(
      asset, "normalized_duration_matches_audio",
      Number.isFinite(media.durationSeconds)
        && media.durationSeconds > 0
        && Math.abs(media.durationSeconds - row.requestedDurationSeconds) <= params.durationToleranceSeconds,
      `${label} duration ${media.durationSeconds.toFixed(3)}s does not match requested narration duration ${row.requestedDurationSeconds.toFixed(3)}s.`,
    );
    assets.push(asset);
  }

  const bySha = new Map<string, QaAsset[]>();
  for (const asset of assets) {
    const group = bySha.get(asset.videoSha256) ?? [];
    group.push(asset);
    bySha.set(asset.videoSha256, group);
  }
  for (const duplicates of bySha.values()) {
    if (duplicates.length < 2) continue;
    const relatedSceneNumbers = duplicates.map(({ sceneNumber }) => sceneNumber);
    for (const asset of duplicates) {
      asset.checks.push({
        code: "video_bytes_unique_within_episode",
        pass: false,
        detail: `byte-identical to ${duplicates.filter((item) => item !== asset).map(({ label }) => label).join(", ")}`,
      });
      asset.issues.push({
        code: "duplicate_video_file",
        message: `${asset.label} is byte-identical to another episode asset; it may be a repeated previous scene.`,
        relatedSceneNumbers,
      });
    }
  }
  for (const asset of assets) {
    if (!asset.checks.some(({ code }) => code === "video_bytes_unique_within_episode")) {
      asset.checks.push({ code: "video_bytes_unique_within_episode", pass: true });
    }
  }
  return assets;
}

async function writeAuditReport(filePath: string, report: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function runStaticQa(
  seriesState: SeriesState,
  seriesId: number,
  episodeNumber: number,
  options: AgnesVideoQaToolOptions,
): Promise<string> {
  const durationToleranceSeconds = options.durationToleranceSeconds
    ?? Math.max(0.08, VIDEO_DURATION_TOLERANCE_SECONDS);
  const minimumVideoBytes = options.minimumVideoBytes ?? MINIMUM_NORMALIZED_VIDEO_BYTES;
  if (!Number.isFinite(durationToleranceSeconds) || durationToleranceSeconds < 0) {
    throw new Error("Static video QA duration tolerance must be a non-negative finite number.");
  }
  if (!Number.isSafeInteger(minimumVideoBytes) || minimumVideoBytes <= 0) {
    throw new Error("Static video QA minimum video size must be a positive integer.");
  }
  const assets = await buildQaAssets({
    seriesState,
    seriesId,
    episodeNumber,
    probeMedia: options.probeMedia ?? probeStaticMedia,
    durationToleranceSeconds,
    minimumVideoBytes,
  });
  const episodeAssetSetDigest = createAgnesStaticEpisodeAssetSetDigest(
    assets.map(({ sceneNumber, row, videoSha256 }) => ({
      sceneNumber,
      generationRequestDigest: row.requestDigest!,
      renderRevision: row.renderRevision,
      videoSha256,
    })),
  );
  const reportPath = path.join(
    CONFIG.outputDir,
    `series_${seriesId}`,
    `episode_${episodeNumber}`,
    "agnes_text",
    "qa",
    "static_media_integrity_v1.json",
  );
  const results = assets.map((asset): AgnesStaticQaResult => {
    const digestInput = {
      sceneNumber: asset.sceneNumber,
      generationRequestDigest: asset.row.requestDigest!,
      renderRevision: asset.row.renderRevision,
      videoSha256: asset.videoSha256,
      episodeAssetSetDigest,
      expectedMainCast: asset.expectedMainCast,
      referenceImageUrls: asset.referenceImageUrls,
      media: asset.media,
    };
    return {
      policyVersion: AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
      pipeline: AGNES_STATIC_VIDEO_QA_PIPELINE,
      pipelineVersion: AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
      policyDigest: currentAgnesStaticVideoQaPolicyDigest(),
      decision: "final",
      model: AGNES_STATIC_VIDEO_QA_MODEL,
      ...digestInput,
      qaRequestDigest: createAgnesStaticVideoQaRequestDigest(digestInput),
      pass: asset.issues.length === 0,
      checks: asset.checks,
      issues: asset.issues,
      evidencePath: reportPath,
    };
  });
  await writeAuditReport(reportPath, {
    pipeline: AGNES_STATIC_VIDEO_QA_PIPELINE,
    pipelineVersion: AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
    policyVersion: AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
    policyDigest: currentAgnesStaticVideoQaPolicyDigest(),
    seriesId,
    episodeNumber,
    episodeAssetSetDigest,
    generatedAt: new Date().toISOString(),
    results,
  });

  const persistenceErrors: Array<{ sceneNumber: number; error: string }> = [];
  let reused = 0;
  let persisted = 0;
  for (const result of results) {
    const asset = assets.find(({ sceneNumber }) => sceneNumber === result.sceneNumber)!;
    const expectedStatus = result.pass ? "passed" : "exhausted";
    const current = isCurrentAgnesStaticQaResult({
      result: asset.row.qaResult,
      rowQaRequestDigest: asset.row.qaRequestDigest,
      rowQaVideoSha256: asset.row.qaVideoSha256,
      rowQaModel: asset.row.qaModel,
      sceneNumber: asset.sceneNumber,
      generationRequestDigest: asset.row.requestDigest!,
      renderRevision: asset.row.renderRevision,
      videoSha256: asset.videoSha256,
      episodeAssetSetDigest,
      expectedPass: result.pass,
    }) && asset.row.qaStatus === expectedStatus;
    if (current) {
      reused += 1;
      continue;
    }
    try {
      const recorded = await seriesState.recordAgnesVideoQaVerdict({
        seriesId,
        episodeNumber,
        sceneNumber: asset.sceneNumber,
        variant: "text",
        expectedRequestDigest: asset.row.requestDigest!,
        expectedRenderRevision: asset.row.renderRevision,
        expectedNormalizedOutputPath: asset.row.normalizedOutputPath!,
        expectedQaStatus: asset.row.qaStatus,
        expectedQaRequestDigest: asset.row.qaRequestDigest,
        qaRequestDigest: result.qaRequestDigest,
        videoSha256: result.videoSha256,
        result,
        contactSheetPath: reportPath,
        model: AGNES_STATIC_VIDEO_QA_MODEL,
        status: expectedStatus,
      });
      if (!recorded.recorded) {
        persistenceErrors.push({
          sceneNumber: asset.sceneNumber,
          error: "generation/QA state changed during the audit; rerun to audit the new state",
        });
      } else {
        persisted += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      persistenceErrors.push({ sceneNumber: asset.sceneNumber, error: message.slice(0, 500) });
      await seriesState.recordAgnesVideoQaError({
        seriesId,
        episodeNumber,
        sceneNumber: asset.sceneNumber,
        variant: "text",
        expectedRequestDigest: asset.row.requestDigest!,
        expectedRenderRevision: asset.row.renderRevision,
        expectedNormalizedOutputPath: asset.row.normalizedOutputPath!,
        expectedQaStatus: asset.row.qaStatus,
        expectedQaRequestDigest: asset.row.qaRequestDigest,
        error: message,
      }).catch(() => undefined);
    }
  }

  const failed = results.filter(({ pass }) => !pass);
  const status = persistenceErrors.length > 0 ? "pending" : failed.length > 0 ? "failed" : "passed";
  return JSON.stringify({
    status,
    phase: "static_video_qa",
    stopRun: status !== "passed",
    assetCount: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    persisted,
    reused,
    apiCalls: 0,
    qaEngine: AGNES_STATIC_VIDEO_QA_MODEL,
    reportPath,
    failures: failed.map(({ sceneNumber, issues }) => ({ sceneNumber, label: assetLabel(sceneNumber), issues })),
    persistenceErrors,
    nextAction: status === "passed"
      ? "Call assemble_episode_video."
      : status === "failed"
        ? "Static QA found a deterministic contract failure. Correct or regenerate only the listed assets, then rerun; no automatic rerender was submitted."
        : "Rerun static QA after the concurrent state change or persistence error is resolved.",
  });
}

export function buildAgnesVideoQaTool(
  seriesState: SeriesState,
  options: AgnesVideoQaToolOptions = {},
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "qa_agnes_episode_videos",
    description:
      "Runs a deterministic, resumable media-integrity audit after both title clips and every scene are downloaded. " +
      "It makes no AI/API calls and never auto-rerenders. It validates exact source bindings, public character references, " +
      "the complete canonical roster in series key art, ordered Picture/cast mappings, silent H.264 media and durations, " +
      "and byte-identical duplicate clips before assembly.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
    }).strict(),
    func: ({ seriesId, episodeNumber }) => runStaticQa(
      seriesState, seriesId, episodeNumber, options,
    ),
  });
}
