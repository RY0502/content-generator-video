import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { CONFIG } from "../config.js";
import type { AgnesVideoQaIssueCode } from "../tools/agnesSceneVideoTool.js";

export const AGNES_VIDEO_QA_POLICY_VERSION = 1;
export const VIDEO_QA_TILE_WIDTH = 1024;
export const VIDEO_QA_TILE_HEIGHT = 576;
const VIDEO_QA_LABEL_HEIGHT = 48;
const MAX_CONTACT_SHEET_BYTES = 18 * 1024 * 1024;
const MAX_CONTACT_SHEET_HEIGHT = 8_192;
/** 12 targets plus one context row produce an 8112px-high sheet. */
export const MAX_VIDEO_QA_TARGETS_PER_SHEET = 12;

export type QaAssetKind = "series_key_art" | "episode_key_art" | "scene";
export type QaFramePosition = "start" | "middle" | "end";

export interface AgnesVideoQaAsset {
  sceneNumber: number;
  kind: QaAssetKind;
  label: string;
  videoPath: string;
  durationSeconds: number;
  requestDigest: string;
  renderRevision: number;
  expectedTitle?: string;
  narrationText?: string;
  environmentDescription?: string;
  action?: string;
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
  expectedCast: Array<{ name: string; description: string }>;
}

export interface AgnesVideoQaIssue {
  code: AgnesVideoQaIssueCode;
  characterNames: string[];
  frames: QaFramePosition[];
  description: string;
}

export interface AgnesVideoQaAssetVerdict {
  sceneNumber: number;
  pass: boolean;
  confidence: number;
  issues: AgnesVideoQaIssue[];
}

export interface AgnesVideoQaBatchVerdict {
  assets: AgnesVideoQaAssetVerdict[];
}

export interface AgnesVideoQaBatch {
  batchNumber: number;
  targets: AgnesVideoQaAsset[];
  context?: AgnesVideoQaAsset;
}

const framePositionSchema = z.enum(["start", "middle", "end"]);
const issueCodeSchema = z.enum([
  "duplicate_entity",
  "wrong_cast",
  "identity_drift",
  "age_mismatch",
  "anatomy_error",
  "style_drift",
  "scene_mismatch",
  "repeated_scene",
  "title_error",
]);
const issueSchema = z.object({
  code: issueCodeSchema,
  characterNames: z.array(z.string().trim().min(1).max(100)).max(20),
  frames: z.array(framePositionSchema).max(3),
  description: z.string().trim().min(1).max(400),
}).strict();
const assetVerdictSchema = z.object({
  sceneNumber: z.number().int(),
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  issues: z.array(issueSchema).max(12),
}).strict().superRefine((value, context) => {
  if (value.pass !== (value.issues.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pass must be true exactly when issues is empty",
    });
  }
});
const batchVerdictSchema = z.object({
  assets: z.array(assetVerdictSchema).min(1).max(20),
}).strict();

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

const GEMINI_CONTROL_TOKEN_PATTERN = /<ctrl(\d+)>/giu;

function isInsideJsonStringAt(value: string, targetIndex: number): boolean {
  let insideString = false;
  let escaped = false;
  for (let index = 0; index < targetIndex; index += 1) {
    const character = value[index]!;
    if (!insideString) {
      if (character === "\"") insideString = true;
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      insideString = false;
    }
  }
  return insideString;
}

/**
 * Gemini can rarely leak tokenizer control labels into otherwise valid JSON.
 * The observed `<ctrl46>` token occupies a JSON quote position. Repair only
 * that exact artifact and let the strict schema below decide whether the
 * resulting value is safe to use. Unknown or residual control tokens fail
 * closed and are never persisted as QA verdicts.
 */
function parseGeminiQaJson(raw: string): unknown {
  const candidate = stripJsonFence(raw);
  const controlTokens = [...candidate.matchAll(GEMINI_CONTROL_TOKEN_PATTERN)];
  let originalError: unknown;
  let nativeParsed: unknown;
  try {
    nativeParsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    originalError = error;
  }
  if (originalError === undefined) {
    if (controlTokens.length > 0) {
      throw new Error("Gemini video QA returned unresolved control tokens inside its JSON verdict.");
    }
    return nativeParsed;
  }

  if (controlTokens.length === 0) {
    throw new Error(
      `Gemini video QA returned malformed JSON: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
    );
  }
  const unknownTokens = [...new Set(
    controlTokens
      .map((match) => match[1] ?? "")
      .filter((tokenNumber) => tokenNumber !== "46"),
  )];
  if (unknownTokens.length > 0) {
    throw new Error(
      `Gemini video QA returned unsupported control token(s): ${unknownTokens.map((value) => `<ctrl${value}>`).join(", ")}.`,
    );
  }
  if (controlTokens.some((match) => isInsideJsonStringAt(candidate, match.index ?? 0))) {
    throw new Error("Gemini video QA returned <ctrl46> inside a JSON string; refusing ambiguous repair.");
  }

  const repairedCandidate = candidate.replace(/<ctrl46>/giu, "\"");
  try {
    const parsed = JSON.parse(repairedCandidate) as unknown;
    if (/<ctrl\d+>/iu.test(repairedCandidate)) {
      throw new Error("control token remained after repair");
    }
    console.warn("[AgnesVideoQA] control_token_json_repaired", {
      token: "<ctrl46>",
      replacements: controlTokens.length,
    });
    return parsed;
  } catch (repairError) {
    throw new Error(
      "Gemini video QA returned malformed JSON containing <ctrl46>; the bounded quote repair was not valid JSON: " +
      `${repairError instanceof Error ? repairError.message : String(repairError)}`,
    );
  }
}

export function parseAgnesVideoQaVerdict(
  raw: string,
  targetSceneNumbers: readonly number[],
): AgnesVideoQaBatchVerdict {
  const parsed = parseGeminiQaJson(raw);
  const verdict = batchVerdictSchema.parse(parsed);
  const expected = [...targetSceneNumbers].sort((left, right) => left - right);
  const received = verdict.assets.map(({ sceneNumber }) => sceneNumber).sort((left, right) => left - right);
  if (received.length !== new Set(received).size
    || expected.length !== received.length
    || expected.some((sceneNumber, index) => sceneNumber !== received[index])) {
    throw new Error(
      `Gemini video QA must return exactly assets [${expected.join(", ")}]; received [${received.join(", ")}].`,
    );
  }
  return verdict;
}

export function contactSheetSampleTimes(durationSeconds: number): [number, number, number] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("A positive finite video duration is required for QA sampling.");
  }
  const inset = Math.min(0.35, Math.max(0.12, durationSeconds * 0.06));
  return [inset, durationSeconds / 2, Math.max(inset, durationSeconds - inset)];
}

/**
 * Keeps approximately three target clips per Gemini request while increasing
 * the batch size when necessary to respect the episode-level request ceiling.
 * The prior story scene is included as non-target context at batch boundaries.
 */
export function planAgnesVideoQaBatches(params: {
  assets: readonly AgnesVideoQaAsset[];
  preferredTargetsPerSheet?: number;
  maxVisionCalls?: number;
}): AgnesVideoQaBatch[] {
  const keyArt = params.assets.filter(({ kind }) => kind !== "scene");
  const scenes = params.assets.filter(({ kind }) => kind === "scene")
    .sort((left, right) => left.sceneNumber - right.sceneNumber);
  const maxCalls = Math.max(2, params.maxVisionCalls ?? CONFIG.videoQaMaxVisionCalls);
  const sceneCallBudget = Math.max(1, maxCalls - (keyArt.length > 0 ? 1 : 0));
  const targetsPerSheet = Math.max(
    1,
    params.preferredTargetsPerSheet ?? CONFIG.videoQaScenesPerSheet,
    Math.ceil(scenes.length / sceneCallBudget),
  );
  if (targetsPerSheet > MAX_VIDEO_QA_TARGETS_PER_SHEET) {
    const minimumCalls = (keyArt.length > 0 ? 1 : 0)
      + Math.ceil(scenes.length / MAX_VIDEO_QA_TARGETS_PER_SHEET);
    throw new Error(
      `Video QA configuration would require ${targetsPerSheet} targets on one contact sheet, ` +
      `above the ${MAX_VIDEO_QA_TARGETS_PER_SHEET}-target visual limit. ` +
      `Set VIDEO_QA_MAX_VISION_CALLS to at least ${minimumCalls}.`,
    );
  }
  const batches: AgnesVideoQaBatch[] = [];
  if (keyArt.length > 0) {
    batches.push({ batchNumber: batches.length + 1, targets: keyArt });
  }
  for (let index = 0; index < scenes.length; index += targetsPerSheet) {
    const targets = scenes.slice(index, index + targetsPerSheet);
    const context = index > 0
      ? scenes[index - 1]
      : keyArt.find(({ kind }) => kind === "episode_key_art")
        ?? keyArt.find(({ kind }) => kind === "series_key_art");
    batches.push({
      batchNumber: batches.length + 1,
      targets,
      ...(context ? { context } : {}),
    });
  }
  if (batches.length > maxCalls) {
    throw new Error(`Video QA planned ${batches.length} calls, above the configured maximum ${maxCalls}.`);
  }
  return batches;
}

function ffmpegFontOption(): string {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ];
  const fontPath = candidates.find((candidate) => existsSync(candidate));
  if (!fontPath) return "";
  const escaped = fontPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  return `fontfile='${escaped}':`;
}

function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(CONFIG.ffmpegPath, ["-y", ...args]);
    let stderr = "";
    process.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Video QA ffmpeg exited with code ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

function assetFrameLabel(asset: AgnesVideoQaAsset, position: QaFramePosition, context: boolean): string {
  const base = asset.kind === "series_key_art"
    ? "SERIES KEY ART"
    : asset.kind === "episode_key_art"
      ? "EPISODE KEY ART"
      : `SCENE ${String(asset.sceneNumber).padStart(3, "0")}`;
  return `${context ? "CONTEXT " : ""}${base} ${position.toUpperCase()}`;
}

/** Creates one 1024x576-per-frame JPEG grid with start/middle/end columns. */
export async function createAgnesVideoContactSheet(params: {
  batch: AgnesVideoQaBatch;
  outputPath: string;
  run?: (args: readonly string[]) => Promise<void>;
}): Promise<string> {
  const rows = [...(params.batch.context ? [params.batch.context] : []), ...params.batch.targets];
  if (rows.length === 0) throw new Error("Cannot create an empty Agnes video QA contact sheet.");
  const outputHeight = (VIDEO_QA_TILE_HEIGHT + VIDEO_QA_LABEL_HEIGHT) * rows.length;
  if (params.batch.targets.length > MAX_VIDEO_QA_TARGETS_PER_SHEET
    || outputHeight > MAX_CONTACT_SHEET_HEIGHT) {
    throw new Error(
      `Video QA contact sheet would be ${outputHeight}px high; the maximum is ` +
      `${MAX_CONTACT_SHEET_HEIGHT}px with at most ${MAX_VIDEO_QA_TARGETS_PER_SHEET} targets.`,
    );
  }
  await mkdir(path.dirname(params.outputPath), { recursive: true });
  const temporaryOutputPath = `${params.outputPath}.${process.pid}.${randomUUID()}.tmp.jpg`;
  await rm(temporaryOutputPath, { force: true });
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const font = ffmpegFontOption();
  let inputIndex = 0;
  const positions: QaFramePosition[] = ["start", "middle", "end"];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const asset = rows[rowIndex]!;
    const times = contactSheetSampleTimes(asset.durationSeconds);
    for (let positionIndex = 0; positionIndex < positions.length; positionIndex++) {
      inputArgs.push("-ss", times[positionIndex]!.toFixed(3), "-i", asset.videoPath);
      const label = assetFrameLabel(
        asset,
        positions[positionIndex]!,
        Boolean(params.batch.context && rowIndex === 0),
      );
      filters.push(
        `[${inputIndex}:v]scale=${VIDEO_QA_TILE_WIDTH}:${VIDEO_QA_TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${VIDEO_QA_TILE_WIDTH}:${VIDEO_QA_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
        `pad=${VIDEO_QA_TILE_WIDTH}:${VIDEO_QA_TILE_HEIGHT + VIDEO_QA_LABEL_HEIGHT}:0:${VIDEO_QA_LABEL_HEIGHT}:color=0x10141c,` +
        `drawtext=${font}text='${label}':fontcolor=white:fontsize=25:x=(w-text_w)/2:y=10[v${inputIndex}]`,
      );
      inputIndex += 1;
    }
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const offset = rowIndex * 3;
    filters.push(`[v${offset}][v${offset + 1}][v${offset + 2}]hstack=inputs=3[row${rowIndex}]`);
  }
  const finalLabel = rows.length === 1
    ? "row0"
    : "out";
  if (rows.length > 1) {
    filters.push(`${rows.map((_row, index) => `[row${index}]`).join("")}vstack=inputs=${rows.length}[out]`);
  }
  let outputBytes = 0;
  try {
    await (params.run ?? runFfmpeg)([
      ...inputArgs,
      "-filter_complex", filters.join(";"),
      "-map", `[${finalLabel}]`,
      "-frames:v", "1",
      "-q:v", "2",
      temporaryOutputPath,
    ]);
    const details = await stat(temporaryOutputPath);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_CONTACT_SHEET_BYTES) {
      throw new Error(
        `Video QA contact sheet must be between 1 byte and ${MAX_CONTACT_SHEET_BYTES} bytes; got ${details.size}.`,
      );
    }
    outputBytes = details.size;
    await rename(temporaryOutputPath, params.outputPath);
  } catch (error) {
    await rm(temporaryOutputPath, { force: true });
    throw error;
  }
  console.log("[AgnesVideoQA] contact_sheet_ready", {
    batchNumber: params.batch.batchNumber,
    targetCount: params.batch.targets.length,
    contextCount: params.batch.context ? 1 : 0,
    width: VIDEO_QA_TILE_WIDTH * 3,
    height: outputHeight,
    bytes: outputBytes,
    path: params.outputPath,
  });
  return params.outputPath;
}

/** Builds one labeled portrait board so every QA call sees canonical identities. */
export async function createCharacterReferenceBoard(params: {
  portraits: readonly { name: string; path: string }[];
  outputPath: string;
  run?: (args: readonly string[]) => Promise<void>;
}): Promise<string> {
  if (params.portraits.length === 0) throw new Error("Video QA requires approved character portraits.");
  for (const portrait of params.portraits) {
    if (!existsSync(portrait.path)) {
      throw new Error(`Approved portrait for ${portrait.name} is unavailable locally: ${portrait.path}`);
    }
  }
  await mkdir(path.dirname(params.outputPath), { recursive: true });
  const temporaryOutputPath = `${params.outputPath}.${process.pid}.${randomUUID()}.tmp.jpg`;
  await rm(temporaryOutputPath, { force: true });
  const tile = 640;
  const labelHeight = 50;
  const columns = Math.min(4, params.portraits.length);
  const rows = Math.ceil(params.portraits.length / columns);
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const font = ffmpegFontOption();
  params.portraits.forEach((portrait, index) => {
    inputArgs.push("-i", portrait.path);
    const safeName = portrait.name.replace(/[^\p{L}\p{N} _-]/gu, " ").slice(0, 60);
    filters.push(
      `[${index}:v]crop='min(iw,ih)':'min(iw,ih)':(iw-ow)/2:(ih-oh)/2,` +
      `scale=${tile}:${tile}:flags=lanczos,setsar=1,` +
      `pad=${tile}:${tile + labelHeight}:0:${labelHeight}:color=0x10141c,` +
      `drawtext=${font}text='${safeName}':fontcolor=yellow:fontsize=28:x=(w-text_w)/2:y=10[p${index}]`,
    );
  });
  const inputs = params.portraits.map((_portrait, index) => `[p${index}]`).join("");
  filters.push(`${inputs}concat=n=${params.portraits.length}:v=1:a=0,` +
    `tile=${columns}x${rows}:margin=0:padding=0:color=black[out]`);
  let outputBytes = 0;
  try {
    await (params.run ?? runFfmpeg)([
      ...inputArgs,
      "-filter_complex", filters.join(";"),
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", "2",
      temporaryOutputPath,
    ]);
    const details = await stat(temporaryOutputPath);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_CONTACT_SHEET_BYTES) {
      throw new Error("Character reference board is empty or too large for AnyAPI vision.");
    }
    outputBytes = details.size;
    await rename(temporaryOutputPath, params.outputPath);
  } catch (error) {
    await rm(temporaryOutputPath, { force: true });
    throw error;
  }
  console.log("[AgnesVideoQA] character_reference_board_ready", {
    characterCount: params.portraits.length,
    width: tile * columns,
    height: (tile + labelHeight) * rows,
    bytes: outputBytes,
    path: params.outputPath,
  });
  return params.outputPath;
}

function assetExpectation(asset: AgnesVideoQaAsset, contextOnly = false): string {
  const cast = asset.expectedCast.length === 0
    ? "none"
    : asset.expectedCast.map(({ name, description }) => `${name}: ${description}`).join(" | ");
  return [
    `${contextOnly ? "CONTEXT ONLY " : "TARGET "}${asset.label} (sceneNumber=${asset.sceneNumber})`,
    asset.expectedTitle ? `exact title: ${JSON.stringify(asset.expectedTitle)}` : "",
    asset.narrationText ? `narration intent: ${asset.narrationText}` : "",
    asset.environmentDescription ? `environment: ${asset.environmentDescription}` : "",
    asset.action ? `one action beat: ${asset.action}` : "",
    asset.sceneDetails ? `blocking/end state: ${asset.sceneDetails}` : "",
    asset.cameraAngle ? `camera: ${asset.cameraAngle}` : "",
    asset.lighting ? `lighting: ${asset.lighting}` : "",
    `exact visible cast, each exactly once: ${cast}`,
  ].filter(Boolean).join("\n  ");
}

export function buildAgnesVideoQaPrompts(batch: AgnesVideoQaBatch): {
  systemPrompt: string;
  userText: string;
} {
  const systemPrompt = [
    "You are a strict senior animation continuity and identity QA reviewer for a preschool series.",
    "Image 1 is a high-resolution contact sheet. Each video is one row: START, MIDDLE, END. A row labeled CONTEXT is comparison-only and must not appear in the result.",
    "Image 2 is the canonical labeled character portrait board. Use it to enforce face, age, hair, body form/species, wardrobe, colors, proportions, and object-character design.",
    "Fail a TARGET when any sampled frame shows: a duplicated/cloned named person, creature, or object character; wrong/missing/unlisted cast; major identity or exact-age drift; extra head/face/limb or fused anatomy; departure from premium 2D hand-painted painterly storybook style; wrong setting/action; reuse of the context/neighboring scene instead of the specified new beat; or incorrect/duplicated title text.",
    "Do not fail harmless motion blur, a normal expression/pose change, perspective, camera motion, or lighting that still preserves the canonical identity and locked 2D style.",
    "Use only these issue codes: duplicate_entity, wrong_cast, identity_drift, age_mismatch, anatomy_error, style_drift, scene_mismatch, repeated_scene, title_error.",
    "Return strict JSON only: {\"assets\":[{\"sceneNumber\":number,\"pass\":boolean,\"confidence\":number,\"issues\":[{\"code\":string,\"characterNames\":string[],\"frames\":[\"start\"|\"middle\"|\"end\"],\"description\":string}]}]}.",
    "Return exactly one result for every TARGET sceneNumber and no result for CONTEXT. pass is true exactly when issues is empty.",
  ].join(" ");
  const userText = [
    "Review the following exact production contract against both supplied images.",
    ...(batch.context ? [assetExpectation(batch.context, true)] : []),
    ...batch.targets.map((asset) => assetExpectation(asset)),
  ].join("\n\n");
  return { systemPrompt, userText };
}

export function createAgnesVideoQaRequestDigest(params: {
  model: string;
  contactSheetSha256: string;
  referenceBoardSha256: string;
  assets: readonly { sceneNumber: number; requestDigest: string; renderRevision: number; videoSha256: string }[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    policyVersion: AGNES_VIDEO_QA_POLICY_VERSION,
    model: params.model,
    samplePositions: ["start", "middle", "end"],
    tile: [VIDEO_QA_TILE_WIDTH, VIDEO_QA_TILE_HEIGHT],
    contactSheetSha256: params.contactSheetSha256,
    referenceBoardSha256: params.referenceBoardSha256,
    assets: params.assets,
  })).digest("hex");
}
