import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { CONFIG } from "../config.js";
import {
  AgnesError,
  AgnesVideoClient,
  AGNES_MAX_REFERENCE_IMAGES,
  AGNES_MAX_SECONDS,
  AGNES_MIN_SECONDS,
  AGNES_VIDEO_ASPECT_RATIO,
  AGNES_VIDEO_MODEL,
  AGNES_VIDEO_SIZE,
  type AgnesErrorKind,
  type AgnesSubmitVideoRequest,
  type AgnesVideoMode,
  type AgnesVideoTask,
} from "../providers/agnes/index.js";
import { canonicalCharacterImageName } from "../providers/supabaseCharacterReferenceStore.js";
import {
  buildEpisodeKeyArtVideoPrompt,
  buildSeriesKeyArtVideoPrompt,
  CHARACTER_INTEGRITY_NEGATIVE_BIBLE,
  TEMPORAL_STABILITY_NEGATIVE_BIBLE,
} from "../promptBuilder.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  AgnesKeyArtAudioMutationDeferredError,
  ensureAgnesKeyArtAudioAssets,
  type AgnesKeyArtAudioAsset,
} from "../services/agnesKeyArtService.js";
import { canonicalizeKeyArtTitle } from "../services/keyArtTitleContract.js";
import {
  ensureSeriesCharacterPortraits,
} from "../services/seriesCharacterPortraitService.js";
import {
  hasStartedAgnesSubmission,
  ProductionScriptContractError,
  productionScriptReadiness,
} from "../services/productionScriptContract.js";
import { materializeScenePrompt, type ScenePromptInput } from "../services/scenePromptService.js";
import {
  canonicalEpisodeScriptJson,
  EpisodeAudioMutationInProgressError,
  EpisodeAudioReadinessError,
  type AgnesSceneGenerationRow,
  type SeriesState,
} from "../state/seriesState.js";
import {
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  readNarrationAudioMetadata,
} from "./ttsTool.js";

const MIN_VIDEO_BYTES = 1_024;
const OUTPUT_FPS = 30;
/** Container timestamps may differ by one encoded frame, but never by several. */
export const VIDEO_DURATION_TOLERANCE_SECONDS = (1 / OUTPUT_FPS) + 0.005;
/** Bump whenever canonical scene-frame timing semantics change. */
export const AGNES_NORMALIZATION_VERSION = 2;
/** Stable prefix for operator-visible, secret-free Agnes workflow progress. */
export const AGNES_PROGRESS_LOG_PREFIX = "[AgnesVideo]";
const REQUEST_DIGEST_VERSION = 3;
const REFERENCE_REQUEST_DIGEST_VERSION = 4;
const RECEIPT_SCHEMA_VERSION = 3;
const LEGACY_RECEIPT_SCHEMA_VERSION = 2;
const RECEIPT_KIND = "agnes-single-scene";
const MAX_SUBMISSION_CONCURRENCY = 2;
export const MIN_PRODUCTION_STATUS_INTERVAL_MS = 30_000;
/**
 * A submission intent with no provider task may be reclaimed only by a later
 * runtime after this lease. Ten minutes is deliberately longer than the
 * one-minute POST timeout plus the five-minute queue-acknowledgement window.
 */
export const AGNES_STALE_SUBMISSION_LEASE_MS = 10 * 60_000;

type EpisodeScript = { scenes: Array<Omit<ScenePromptInput, "seriesId">> };
type AttemptState = "submitting" | "accepted" | "definite_rejection" | "ambiguous";
type SubmissionPhase = "claim_created" | "post_started";

type AgnesProgressValue = string | number | boolean | null | undefined;

function safeProgressError(error: unknown, providerPrompt?: string): string {
  const withoutPrompt = providerPrompt?.trim()
    ? safeError(error).split(providerPrompt.trim()).join("[prompt omitted]")
    : safeError(error);
  return withoutPrompt
    .replace(/https?:\/\/\S+/giu, "[url omitted]")
    .replace(
      /\b(api[-_ ]?key|authorization|bearer|token)\b\s*[:=]?\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redacted]")
    .slice(0, 320);
}

function logAgnesProgress(
  event: string,
  metadata: Record<string, AgnesProgressValue>,
  level: "info" | "warn" | "error" = "info",
): void {
  const compactMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
  const message = `${AGNES_PROGRESS_LOG_PREFIX} ${event}`;
  if (level === "error") console.error(message, compactMetadata);
  else if (level === "warn") console.warn(message, compactMetadata);
  else console.log(message, compactMetadata);
}

interface AgnesAttemptReceipt {
  attemptNumber: number;
  claimToken: string;
  state: AttemptState;
  startedAt: string;
  finishedAt?: string;
  retrySafe?: boolean;
  retryAfterMs?: number;
  error?: string;
  errorKind?: AgnesErrorKind;
  task?: AgnesVideoTask;
  submissionPhase?: SubmissionPhase;
  /** Stable, non-secret scheduler lane that owns this physical POST attempt. */
  accountId?: string;
  /** Diagnostic only; the fingerprint is the durable credential binding. */
  keyLabel?: string;
  keyFingerprint?: string;
}

interface AgnesSceneReceiptEnvelope {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: typeof RECEIPT_KIND;
  requestDigest: string;
  providerSeconds: number;
  attempts: AgnesAttemptReceipt[];
  rawPath?: string;
  sha256?: string;
  normalizationVersion?: number;
}

interface PreparedScene {
  assetKind: "series_key_art" | "episode_key_art" | "scene";
  assetLabel: string;
  manifestIndex: number;
  /** Populated once the full episode manifest has been prepared. */
  manifestSize?: number;
  input: ScenePromptInput;
  durationSeconds: number;
  providerSeconds: number;
  providerPrompt: string;
  /** Provider API mode; output/state variant intentionally remains agnes_text. */
  providerMode: AgnesVideoMode;
  referenceImageUrls: string[];
  publicReferenceValue: string | null;
  requestDigest: string;
  /** One shared canonical string reference captured before any row is prepared. */
  expectedEpisodeScriptJson: string;
  /** Episode-wide narration revision captured and rechecked around media reads. */
  expectedEpisodeAudioRevision: number;
  seed: number;
  normalizedPath: string;
  rawPath: string;
  promptPath: string;
}

function assetProgressMetadata(scene: PreparedScene): Record<string, AgnesProgressValue> {
  return {
    assetLabel: scene.assetLabel,
    assetKind: scene.assetKind,
    assetPosition: scene.manifestIndex + 1,
    assetCount: scene.manifestSize,
    sceneNumber: scene.assetKind === "scene" ? scene.input.sceneNumber : undefined,
    targetSeconds: Number(scene.durationSeconds.toFixed(3)),
    providerSeconds: scene.providerSeconds,
  };
}

type AgnesClientLike = Pick<AgnesVideoClient, "submitVideo" | "retrieveVideo" | "downloadCompletedVideo">;

export interface AgnesAccountClientOption {
  /** Stable non-secret id; it must not change when a credential is rotated. */
  accountId: string;
  client: AgnesClientLike;
  keyLabel?: string;
  keyFingerprint?: string;
}

type EnsureSeriesCharacterPortraitsOperation = (params: {
  seriesState: SeriesState;
  seriesId: number;
  roster?: readonly { name: string; description: string }[];
}) => Promise<unknown>;

export interface AgnesSceneVideoToolOptions {
  client?: AgnesClientLike;
  /** Explicit account lanes. Primarily useful for tests and custom runtimes. */
  accounts?: readonly AgnesAccountClientOption[];
  probeMediaDuration?: (filePath: string) => Promise<number>;
  normalizeVideo?: typeof normalizeAgnesVideo;
  submissionIntervalMs?: number;
  /** Minimum spacing between status GET starts within each account lane. */
  statusRequestIntervalMs?: number;
  submissionBatchSize?: number;
  queuePollIntervalMs?: number;
  queuePollWindowMs?: number;
  /** Programmatic subset used only by focused evaluation scripts. */
  sceneNumbers?: readonly number[];
  /** Production enables both title-card videos; focused legacy tests/previews may opt out. */
  includeKeyArt?: boolean;
  /** Injectable title-audio preparation used by focused tests. */
  ensureKeyArtAudioAssets?: typeof ensureAgnesKeyArtAudioAssets;
  /** Injectable portrait-only roster operation used by focused tests. */
  ensureSeriesCharacterPortraits?: EnsureSeriesCharacterPortraitsOperation;
}

interface WorkflowRuntime {
  seriesState: SeriesState;
  accounts: AgnesAccountRuntime[];
  downloadClient: AgnesClientLike;
  probeMediaDuration: (filePath: string) => Promise<number>;
  normalizeVideo: typeof normalizeAgnesVideo;
  submissionBatchSizePerAccount: number;
  totalSubmissionConcurrency: number;
  downloadConcurrency: number;
  submissionIntervalMsPerAccount: number;
  statusIntervalMsPerAccount: number;
  queuePollIntervalMs: number;
  queuePollWindowMs: number;
  /** Lives only for one production agent runtime/invocation. */
  attemptedSubmissions: Set<string>;
  /** Account-level quota failures are skipped for the rest of this invocation. */
  disabledAccounts: Set<string>;
  /** Queue-capacity and ambiguous outcomes may not rotate within one invocation. */
  haltedSubmissions: Set<string>;
  selectedSceneNumbers?: readonly number[];
  includeKeyArt: boolean;
  ensureKeyArtAudioAssets: typeof ensureAgnesKeyArtAudioAssets;
  ensureSeriesCharacterPortraits: EnsureSeriesCharacterPortraitsOperation;
}

interface AgnesAccountRuntime {
  accountId: string;
  keyLabel?: string;
  keyFingerprint?: string;
  /** Test-injected clients may intentionally accept any persisted fingerprint. */
  acceptsAnyFingerprint: boolean;
  client: AgnesClientLike;
  submissionGate: AccountRequestGate;
  statusRequestGate: AccountRequestGate;
  submissionSemaphore: AsyncSemaphore;
  statusSemaphore: AsyncSemaphore;
}

function parsePossiblyJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function stringArray(value: unknown): string[] | undefined {
  const parsed = parsePossiblyJson(value);
  return Array.isArray(parsed)
    ? parsed.map(String).map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function parseEpisodeScript(value: unknown): EpisodeScript {
  const root = parsePossiblyJson(value);
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Episode script_json is missing or is not an object");
  }
  const rawScenes = parsePossiblyJson((root as Record<string, unknown>).scenes);
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new Error("Episode script_json contains no scenes");
  }
  const scenes = rawScenes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Episode script scene ${index + 1} is not an object`);
    }
    const scene = entry as Record<string, unknown>;
    const sceneNumber = Number(scene.sceneNumber ?? index + 1);
    const narrationText = typeof scene.narrationText === "string" ? scene.narrationText.trim() : "";
    const environmentDescription = typeof scene.environmentDescription === "string"
      ? scene.environmentDescription.trim()
      : "";
    const action = typeof scene.action === "string" ? scene.action.trim() : "";
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) {
      throw new Error(`Episode script scene ${index + 1} has an invalid sceneNumber`);
    }
    if (!narrationText || !environmentDescription || !action) {
      throw new Error(`Episode script scene ${sceneNumber} is missing narrationText, environmentDescription, or action`);
    }
    const visuals = parsePossiblyJson(scene.characterVisuals);
    const characterVisuals = Array.isArray(visuals)
      ? visuals.filter((item): item is NonNullable<ScenePromptInput["characterVisuals"]>[number] => (
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )).map((item) => ({
          name: String((item as Record<string, unknown>).name ?? "").trim(),
          visualForm: (item as Record<string, unknown>).visualForm as NonNullable<ScenePromptInput["characterVisuals"]>[number]["visualForm"],
          speciesOrType: typeof (item as Record<string, unknown>).speciesOrType === "string"
            ? String((item as Record<string, unknown>).speciesOrType).trim()
            : undefined,
          humanoidAllowed: typeof (item as Record<string, unknown>).humanoidAllowed === "boolean"
            ? Boolean((item as Record<string, unknown>).humanoidAllowed)
            : undefined,
        })).filter((item) => item.name)
      : undefined;
    return {
      sceneNumber,
      narrationText,
      environmentDescription,
      action,
      characterNames: stringArray(scene.characterNames) ?? [],
      characterVisuals,
      supportingEntities: stringArray(scene.supportingEntities),
      continuityAnchors: stringArray(scene.continuityAnchors),
      sceneDetails: typeof scene.sceneDetails === "string" ? scene.sceneDetails.trim() : undefined,
      cameraAngle: typeof scene.cameraAngle === "string" ? scene.cameraAngle.trim() : undefined,
      lighting: typeof scene.lighting === "string" ? scene.lighting.trim() : undefined,
    };
  });
  const seen = new Set<number>();
  for (const scene of scenes) {
    if (seen.has(scene.sceneNumber)) throw new Error(`Episode script contains duplicate sceneNumber ${scene.sceneNumber}`);
    seen.add(scene.sceneNumber);
  }
  return { scenes };
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const stdout = await runProcess(CONFIG.ffprobePath, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Media has an invalid duration: ${filePath}`);
  return duration;
}

async function reusableVideo(
  filePath: string,
  targetDuration?: number,
  probe: (filePath: string) => Promise<number> = probeDurationSeconds,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < MIN_VIDEO_BYTES) return false;
    const duration = await probe(filePath);
    return targetDuration === undefined
      || Math.abs(duration - targetDuration) <= VIDEO_DURATION_TOLERANCE_SECONDS;
  } catch { return false; }
}

async function reusableCanonicalVideo(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  row: AgnesSceneGenerationRow,
  envelope: AgnesSceneReceiptEnvelope,
): Promise<boolean> {
  return row.status === "completed"
    && row.downloadStatus === "downloaded"
    && row.requestDigest === scene.requestDigest
    && envelope.normalizationVersion === AGNES_NORMALIZATION_VERSION
    && row.normalizedOutputPath !== null
    && path.resolve(row.normalizedOutputPath) === path.resolve(scene.normalizedPath)
    && await reusableVideo(scene.normalizedPath, scene.durationSeconds, runtime.probeMediaDuration);
}

/** One narration clip maps to one Agnes request; no visual restart/concatenation. */
export function planAgnesVideoSegments(targetDuration: number): number[] {
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error("Agnes target duration must be a positive finite number");
  }
  if (targetDuration > AGNES_MAX_SECONDS) {
    throw new Error(
      `Narration is ${targetDuration.toFixed(3)}s; each scene must be at most ${AGNES_MAX_SECONDS}s for one Agnes request.`,
    );
  }
  return [Math.max(AGNES_MIN_SECONDS, Math.ceil(targetDuration))];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function taskFromUnknown(value: unknown): AgnesVideoTask | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" || !value.id.trim()
    || typeof value.task_id !== "string" || !value.task_id.trim()
    || typeof value.video_id !== "string" || !value.video_id.trim()
    || value.model !== AGNES_VIDEO_MODEL
    || !["submitted", "pending", "queued", "in_progress", "completed", "failed"].includes(String(value.status))
    || typeof value.progress !== "number" || !Number.isFinite(value.progress)
    || value.progress < 0 || value.progress > 100
    || typeof value.keyLabel !== "string" || !value.keyLabel.trim()
    || typeof value.keyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.keyFingerprint)
  ) return undefined;
  const metadata = value.metadata;
  if (metadata !== undefined && (!isRecord(metadata)
    || (metadata.url !== undefined && typeof metadata.url !== "string"))) return undefined;
  return value as unknown as AgnesVideoTask;
}

function newEnvelope(requestDigest: string, providerSeconds: number): AgnesSceneReceiptEnvelope {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    requestDigest,
    providerSeconds,
    attempts: [],
  };
}

function cloneEnvelope(envelope: AgnesSceneReceiptEnvelope): AgnesSceneReceiptEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as AgnesSceneReceiptEnvelope;
}

function parseAttempt(value: unknown, index: number): AgnesAttemptReceipt | undefined {
  if (!isRecord(value)
    || value.attemptNumber !== index + 1
    || typeof value.claimToken !== "string" || !value.claimToken
    || !["submitting", "accepted", "definite_rejection", "ambiguous"].includes(String(value.state))
    || typeof value.startedAt !== "string" || !value.startedAt) return undefined;
  const task = value.task === undefined ? undefined : taskFromUnknown(value.task);
  if (value.state === "accepted" && !task) return undefined;
  const accountId = typeof value.accountId === "string" && value.accountId.trim()
    ? value.accountId.trim()
    : undefined;
  const keyLabel = typeof value.keyLabel === "string" && value.keyLabel.trim()
    ? value.keyLabel.trim()
    : undefined;
  const keyFingerprint = typeof value.keyFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value.keyFingerprint)
    ? value.keyFingerprint
    : undefined;
  if (value.accountId !== undefined && accountId === undefined) return undefined;
  if (value.keyLabel !== undefined && keyLabel === undefined) return undefined;
  if (value.keyFingerprint !== undefined && keyFingerprint === undefined) return undefined;
  if (task && keyFingerprint && task.keyFingerprint !== keyFingerprint) return undefined;
  const errorKind = [
    "configuration", "validation", "authentication", "insufficient_credits",
    "quota_exhausted", "daily_limit", "rate_limit", "provider_capacity",
    "ambiguous_submission", "provider", "network", "timeout", "download",
  ].includes(String(value.errorKind))
    ? value.errorKind as AgnesErrorKind
    : undefined;
  if (value.errorKind !== undefined && errorKind === undefined) return undefined;
  return {
    attemptNumber: value.attemptNumber,
    claimToken: value.claimToken,
    state: value.state as AttemptState,
    startedAt: value.startedAt,
    ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.retrySafe === "boolean" ? { retrySafe: value.retrySafe } : {}),
    ...(typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(task ? { task } : {}),
    ...(accountId ? { accountId } : {}),
    ...(keyLabel ? { keyLabel } : {}),
    ...(keyFingerprint ? { keyFingerprint } : {}),
    ...(["claim_created", "post_started"].includes(String(value.submissionPhase))
      ? { submissionPhase: value.submissionPhase as SubmissionPhase }
      : {}),
  };
}

function parseEnvelope(value: unknown, digest: string, seconds: number): AgnesSceneReceiptEnvelope | undefined {
  const directTask = taskFromUnknown(value);
  if (directTask) {
    return {
      ...newEnvelope(digest, seconds),
      attempts: [{
        attemptNumber: 1,
        claimToken: `legacy-${directTask.video_id}`,
        state: "accepted",
        startedAt: new Date(0).toISOString(),
        task: directTask,
      }],
    };
  }
  if (!isRecord(value)) return undefined;
  // Migrate a compatible one-segment receipt from the former combined tool.
  if (value.kind === "agnes-scene-segments" && value.requestDigest === digest
    && Array.isArray(value.segmentPlan) && value.segmentPlan.length === 1 && value.segmentPlan[0] === seconds
    && Array.isArray(value.segments) && value.segments.length === 1 && isRecord(value.segments[0])) {
    const segment = value.segments[0];
    if (!Array.isArray(segment.attempts)) return undefined;
    const attempts = segment.attempts.map(parseAttempt);
    if (attempts.some((attempt) => !attempt)) return undefined;
    return {
      ...newEnvelope(digest, seconds),
      attempts: attempts as AgnesAttemptReceipt[],
      ...(typeof segment.rawPath === "string" ? { rawPath: segment.rawPath } : {}),
      ...(typeof segment.sha256 === "string" ? { sha256: segment.sha256 } : {}),
      ...(Number.isSafeInteger(segment.normalizationVersion)
        ? { normalizationVersion: Number(segment.normalizationVersion) }
        : {}),
    };
  }
  if (![LEGACY_RECEIPT_SCHEMA_VERSION, RECEIPT_SCHEMA_VERSION].includes(Number(value.schemaVersion))
    || value.kind !== RECEIPT_KIND
    || value.requestDigest !== digest || value.providerSeconds !== seconds || !Array.isArray(value.attempts)) {
    return undefined;
  }
  const attempts = value.attempts.map(parseAttempt);
  if (attempts.some((attempt) => !attempt)) return undefined;
  return {
    ...newEnvelope(digest, seconds),
    attempts: attempts as AgnesAttemptReceipt[],
    ...(typeof value.rawPath === "string" ? { rawPath: value.rawPath } : {}),
    ...(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
      ? { sha256: value.sha256 }
      : {}),
    ...(Number.isSafeInteger(value.normalizationVersion)
      ? { normalizationVersion: Number(value.normalizationVersion) }
      : {}),
  };
}

function latestAttempt(envelope: AgnesSceneReceiptEnvelope): AgnesAttemptReceipt | undefined {
  return envelope.attempts.at(-1);
}

function activeTask(envelope: AgnesSceneReceiptEnvelope): AgnesVideoTask | undefined {
  const attempt = latestAttempt(envelope);
  return attempt?.state === "accepted" ? attempt.task : undefined;
}

function receiptSafety(value: unknown): { accepted: boolean; unresolved: boolean } {
  if (taskFromUnknown(value)) return { accepted: true, unresolved: false };
  if (!isRecord(value)) return { accepted: false, unresolved: value !== null && value !== undefined };
  const attempts = Array.isArray(value.attempts)
    ? value.attempts
    : Array.isArray(value.segments)
      ? value.segments.flatMap((segment) => isRecord(segment) && Array.isArray(segment.attempts) ? segment.attempts : [{}])
      : [];
  let accepted = false;
  let unresolved = false;
  for (const attempt of attempts) {
    if (!isRecord(attempt)) unresolved = true;
    else if (attempt.state === "accepted" || taskFromUnknown(attempt.task)) accepted = true;
    else if (attempt.state === "submitting" || attempt.state === "ambiguous") unresolved = true;
  }
  return { accepted, unresolved };
}

export function createAgnesVideoRequestDigest(params: {
  prompt: string;
  providerSeconds: number;
  seed: number;
  duration: number;
  mode: AgnesVideoMode;
  referenceImageUrls?: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: params.mode === "reference"
      ? REFERENCE_REQUEST_DIGEST_VERSION
      : REQUEST_DIGEST_VERSION,
    model: AGNES_VIDEO_MODEL,
    mode: params.mode,
    size: AGNES_VIDEO_SIZE,
    aspectRatio: AGNES_VIDEO_ASPECT_RATIO,
    n: 1,
    prompt: params.prompt,
    providerSeconds: params.providerSeconds,
    seed: params.seed,
    targetDurationSeconds: params.duration,
    ...(params.mode === "reference"
      ? { images: [...(params.referenceImageUrls ?? [])] }
      : {}),
  })).digest("hex");
}

export type AgnesVideoQaIssueCode =
  | "live_action_intrusion"
  | "multi_shot_discontinuity"
  | "duplicate_entity"
  | "wrong_cast"
  | "identity_drift"
  | "age_mismatch"
  | "anatomy_error"
  | "style_drift"
  | "scene_mismatch"
  | "repeated_scene"
  | "title_error";

const QA_RETRY_DIRECTIVES: Record<AgnesVideoQaIssueCode, string> = {
  live_action_intrusion: "Keep one full-screen 2D painted animated world for every frame; never show or composite a live-action or photoreal presenter, host, narrator, spokesperson, talking head, studio person, foreground overlay, picture-in-picture insert, reaction shot, or cutaway.",
  multi_shot_discontinuity: "Render one unbroken story shot with one camera and one location; never cut, cross-fade, dissolve, switch medium, insert another shot, replay the beat, or replace the cast midway.",
  duplicate_entity: "Enforce the visible-cast ledger literally from first frame to last: each listed person, creature, companion, or living object appears exactly once on one continuous trajectory, with no clone, second copy, foreground double, background double, reflection, re-entry, split, fork, or morph-generated duplicate.",
  wrong_cast: "Render every named ledger figure exactly once and all other figures zero times; no missing, substituted, generic, background, foreground, entering, exiting, cropped, or unlisted person, child, adult, creature, companion, or living object.",
  identity_drift: "Treat every canonical identity and approved portrait description as immutable: preserve exact face, numeric age, hair, skin/fur/material, body or object form, wardrobe, colors, markings, accessories, silhouette, and proportions from first frame to last.",
  age_mismatch: "Preserve each named human character's exact stated age and child proportions.",
  anatomy_error: "Keep every figure anatomically clean with one head, one face, and the correct number of separate limbs.",
  style_drift: "Use only the locked 2D hand-painted storybook style, palette, line treatment, and material rendering.",
  scene_mismatch: "Depict the specified setting and one specified action beat literally; do not substitute another episode moment.",
  repeated_scene: "Create a clearly new composition and action beat, not a reuse of the neighboring shot.",
  title_error: "Show the exact requested title once, stable and readable, with no other text.",
};

const AGNES_ANIMATED_MEDIUM_GUARD =
  "FULL-SHOT MEDIUM LOCK — one full-screen 2D painted animated story world for the entire clip. " +
  "No live-action or photoreal presenter, host, narrator, spokesperson, talking head, studio person, " +
  "picture-in-picture insert, foreground overlay, reaction shot, cutaway, or mixed-medium transition.";

export function agnesAssetSeedDiscriminator(sceneNumber: number): string {
  if (sceneNumber === AGNES_SERIES_KEY_ART_TRACKING_SCENE) return "series-key-art";
  if (sceneNumber === AGNES_EPISODE_KEY_ART_TRACKING_SCENE) return "episode-key-art";
  return `scene-${sceneNumber}`;
}

export function qaIssueCodesFromResult(value: unknown): AgnesVideoQaIssueCode[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const issues = (value as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const supported = new Set(Object.keys(QA_RETRY_DIRECTIVES));
  return [...new Set(issues.flatMap((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const code = String((issue as { code?: unknown }).code ?? "");
    return supported.has(code) ? [code as AgnesVideoQaIssueCode] : [];
  }))];
}

/**
 * Heals only the narrow legacy object-character alias understood by the
 * durable script canonicalizer (`Bobo` -> `Bobo the Backpack`, for example).
 * Exact canonical-name spans are protected so the replacement can never
 * produce `Bobo the Backpack the Backpack`. Conflicting aliases fail closed
 * instead of placing two identity labels in a rerender prompt.
 */
export function canonicalizeLegacyAgnesPromptCast(
  prompt: string,
  expectedCast: readonly { name: string }[],
): string {
  const names = expectedCast
    .map(({ name }) => name.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const byAlias = new Map<string, { alias: string; canonicalName: string }>();
  for (const canonicalName of names) {
    const match = canonicalName.match(/^(.+?)\s+the\s+(backpack|bag|satchel)$/iu);
    if (!match) continue;
    const alias = match[1]!.trim();
    const key = alias.toLocaleLowerCase();
    const existing = byAlias.get(key);
    if (existing && existing.canonicalName.toLocaleLowerCase() !== canonicalName.toLocaleLowerCase()) {
      throw new Error(`Cannot canonicalize ambiguous Agnes cast alias ${JSON.stringify(alias)}.`);
    }
    if (names.some((name) => name.toLocaleLowerCase() === key)) {
      throw new Error(`Cannot canonicalize Agnes cast alias ${JSON.stringify(alias)} because it is also an exact cast name.`);
    }
    byAlias.set(key, { alias, canonicalName });
  }

  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let output = prompt;
  for (const { alias, canonicalName } of byAlias.values()) {
    const canonicalSpans = [...output.matchAll(new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped(canonicalName)}(?![\\p{L}\\p{N}_])`,
      "giu",
    ))].flatMap((match) => match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length }]);
    output = output.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(alias)}(?![\\p{L}\\p{N}_])`, "giu"),
      (matched, ...args: unknown[]) => {
        const offset = args.at(-2);
        if (typeof offset !== "number") return matched;
        const end = offset + matched.length;
        return canonicalSpans.some((span) => offset >= span.start && end <= span.end)
          ? matched
          : canonicalName;
      },
    );
  }
  return output;
}

/** Adds only validated category-level corrections; raw judge prose never reaches Agnes. */
export function buildAgnesQaRetryPrompt(
  prompt: string,
  issueCodes: readonly AgnesVideoQaIssueCode[],
  expectedCast: readonly { name: string; description: string }[] = [],
): string {
  const mandatoryCodes: AgnesVideoQaIssueCode[] = [
    "live_action_intrusion",
    "multi_shot_discontinuity",
    "duplicate_entity",
    "wrong_cast",
    "identity_drift",
  ];
  const uniqueCodes = [...new Set([...mandatoryCodes, ...issueCodes])]
    .filter((code) => code in QA_RETRY_DIRECTIVES);
  const directives = uniqueCodes.map((code) => QA_RETRY_DIRECTIVES[code]);
  const exactCast = expectedCast
    .map(({ name, description }) => ({
      name: name.replace(/\s+/gu, " ").trim(),
      description: description.replace(/\s+/gu, " ").trim(),
    }))
    .filter(({ name, description }) => name && description);
  const canonicalPrompt = canonicalizeLegacyAgnesPromptCast(prompt, exactCast);
  const castLedger = exactCast.length > 0
    ? `VISIBLE CAST — EXACTLY ${exactCast.length} ${exactCast.length === 1 ? "FIGURE" : "FIGURES"}, NO OTHERS: ` +
      exactCast.map(({ name }) => `[${name}] × 1`).join("; ") + "."
    : canonicalPrompt.match(/VISIBLE CAST —[^\n]+/u)?.[0]?.trim();
  const identityRepair = exactCast.length > 0
    ? "FINAL IDENTITY LOCK — " + exactCast
      .map(({ name, description }) => `[${name}]: ${description}`)
      .join(" | ")
    : "";
  return [
    canonicalPrompt.trim(),
    `QA RERENDER CORRECTION — Previous render was rejected. ${directives.join(" ")}`,
    castLedger
      ? `FINAL CAST CHECK AT OUTPUT — ${castLedger} Keep that exact count and those exact identities in every frame; all other figures have count zero.`
      : "",
    identityRepair,
    AGNES_ANIMATED_MEDIUM_GUARD,
  ].filter(Boolean).join(" ");
}

/** Stable per-asset diversity while preserving deterministic reruns. */
export function deriveAgnesAssetSeed(
  seriesSeed: number,
  episodeNumber: number,
  assetDiscriminator: string,
): number {
  if (!Number.isSafeInteger(seriesSeed) || seriesSeed < 0 || seriesSeed > 2_147_483_647) {
    throw new Error("seriesSeed must be an integer from 0 through 2147483647.");
  }
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error("episodeNumber must be a positive integer.");
  }
  const discriminator = assetDiscriminator.trim();
  if (!discriminator) throw new Error("assetDiscriminator must not be empty.");
  const digest = createHash("sha256")
    .update(`${seriesSeed}:${episodeNumber}:${discriminator}`)
    .digest();
  return (digest.readUInt32BE(0) % 2_147_483_647) + 1;
}

export function serializeAgnesReferenceImageUrls(urls: readonly string[]): string | null {
  return urls.length > 0 ? JSON.stringify([...urls]) : null;
}

export function parseAgnesReferenceImageUrls(value: string | null | undefined): string[] {
  const raw = value?.trim();
  if (!raw) return [];
  let candidates: unknown;
  try {
    candidates = JSON.parse(raw);
  } catch {
    candidates = [raw];
  }
  if (!Array.isArray(candidates) || candidates.length < 1
    || candidates.length > AGNES_MAX_REFERENCE_IMAGES) return [];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") return [];
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return [];
      urls.push(candidate);
    } catch {
      return [];
    }
  }
  return urls;
}

function withReferenceIdentityMap(
  prompt: string,
  characters: readonly { name: string }[],
): string {
  const mapping = characters
    .map(({ name }, index) => (
      `<Picture ${index + 1}> is ${canonicalCharacterImageName(name)}.png, the approved portrait of ${name}`
    ))
    .join("; ");
  return `${prompt.trim()} REFERENCE IMAGE IDENTITY MAP — ${mapping}. Treat each portrait as the `
    + "authoritative identity and art-style reference; preserve its exact age, face, hair, body form, "
    + "colors, clothing, accessories, markings, proportions, and silhouette in every frame.";
}

function withCharacterIntegrityGuard(canonicalPrompt: string): string {
  const prompt = canonicalPrompt.trim();
  return [
    prompt,
    prompt.includes(CHARACTER_INTEGRITY_NEGATIVE_BIBLE) ? "" : CHARACTER_INTEGRITY_NEGATIVE_BIBLE,
    prompt.includes(AGNES_ANIMATED_MEDIUM_GUARD) ? "" : AGNES_ANIMATED_MEDIUM_GUARD,
  ].filter(Boolean).join(" ");
}

export function buildAgnesVideoPrompt(params: {
  canonicalScenePrompt: string;
  variant?: "text" | "reference";
  targetDurationSeconds: number;
  segmentIndex?: number;
  segmentCount?: number;
}): string {
  // `variant` remains a compatibility hint. Provider mode and reference URLs
  // are bound later, after the durable row and portrait availability are known.
  void params.variant;
  // The documented `seconds` request field controls provider duration, while
  // normalization uses the exact measured WAV duration. Avoid a competing
  // fractional duration instruction inside the creative prompt.
  void params.targetDurationSeconds;
  const canonicalPrompt = params.canonicalScenePrompt.trim();
  const isStructuredVideoPrompt = [
    "SUBJECT AND SETTING",
    "ACTION AND CHANGE",
    "CAMERA",
    "VISUAL STYLE",
    "SOUND AND RHYTHM",
    "CONSISTENCY REQUIREMENTS",
  ].every((section) => canonicalPrompt.includes(section));
  if (isStructuredVideoPrompt) return withCharacterIntegrityGuard(canonicalPrompt);
  return [
    `SUBJECT AND SETTING — ${canonicalPrompt}`,
    "ACTION AND CHANGE — Animate one continuous visible beat with gentle, readable movement and no cut, montage, or time jump.",
    "CAMERA — Use one smooth restrained camera move, or a fixed camera when movement is not needed.",
    "VISUAL STYLE — Preserve the supplied children's storybook style, lighting, color, and atmosphere.",
    "SOUND AND RHYTHM — Silent visual-only shot. No narration, dialogue, music, or sound effects.",
    `CONSISTENCY REQUIREMENTS — ${CHARACTER_INTEGRITY_NEGATIVE_BIBLE} ${TEMPORAL_STABILITY_NEGATIVE_BIBLE}`,
  ].filter(Boolean).join(" ");
}

/** Builds one gently animated title-card shot while keeping its only title stable. */
export function buildAgnesKeyArtVideoPrompt(params: {
  canonicalKeyArtPrompt: string;
  title: string;
  targetDurationSeconds: number;
  kind: "series" | "episode";
}): string {
  const label = params.kind === "series" ? "series" : "episode";
  const title = canonicalizeKeyArtTitle(params.title, params.kind);
  void params.targetDurationSeconds;
  const canonicalPrompt = params.canonicalKeyArtPrompt.trim();
  const isStructuredVideoPrompt = [
    "SUBJECT AND SETTING",
    "ACTION AND CHANGE",
    "CAMERA",
    "VISUAL STYLE",
    "SOUND AND RHYTHM",
    "CONSISTENCY REQUIREMENTS",
  ].every((section) => canonicalPrompt.includes(section));
  if (isStructuredVideoPrompt) return withCharacterIntegrityGuard(canonicalPrompt);
  return [
    `SUBJECT AND SETTING — One animated children's ${label} title card. Render the exact title ${JSON.stringify(title)} once. ${canonicalPrompt}`,
    "ACTION AND CHANGE — Use only gentle character and environmental motion; keep one composition with no cut, montage, or time jump.",
    "CAMERA — Use a very slow straight push-in while keeping the title plane stable.",
    "VISUAL STYLE — Premium colorful 2D painterly children's storybook animation.",
    "SOUND AND RHYTHM — Silent visual-only title card. No narration, dialogue, music, or sound effects.",
    `CONSISTENCY REQUIREMENTS — Keep the exact title stable and add no other text. ${CHARACTER_INTEGRITY_NEGATIVE_BIBLE} ${TEMPORAL_STABILITY_NEGATIVE_BIBLE}`,
  ].filter(Boolean).join(" ");
}

function isFrozenQaRetry(row: AgnesSceneGenerationRow | null): boolean {
  return Boolean(
    row
    && row.renderRevision === 1
    && row.qaStatus === "awaiting_regeneration",
  );
}

function hasDurableOrPotentialProviderWork(row: AgnesSceneGenerationRow | null): boolean {
  if (!row) return false;
  const safety = receiptSafety(row.providerReceipt);
  return isFrozenQaRetry(row)
    || safety.accepted
    || safety.unresolved
    || Boolean(row.providerTaskId)
    || row.status === "completed"
    || row.downloadStatus === "downloaded";
}

/**
 * Prompt wording evolves over time. Keep an already accepted/in-flight task
 * bound to its persisted prompt when every other request input is unchanged;
 * new and safely resettable rows immediately receive the latest prompt bible.
 */
function bindRequestToExistingWork(params: {
  proposedPrompt: string;
  proposedMode: AgnesVideoMode;
  proposedReferenceImageUrls: readonly string[];
  providerSeconds: number;
  durationSeconds: number;
  preferredSeed: number;
  existingRow: AgnesSceneGenerationRow | null;
}): {
  providerPrompt: string;
  providerMode: AgnesVideoMode;
  referenceImageUrls: string[];
  publicReferenceValue: string | null;
  requestDigest: string;
  seed: number;
} {
  if (isFrozenQaRetry(params.existingRow)) {
    const row = params.existingRow!;
    if (!row.requestDigest || !row.prompt.trim() || row.seed === null) {
      throw new Error(
        `Frozen Agnes QA retry for scene ${row.sceneNumber} is missing its prompt, digest, or seed.`,
      );
    }
    if (
      row.providerDurationSeconds !== params.providerSeconds
      || Math.abs(row.requestedDurationSeconds - params.durationSeconds) > 0.001
    ) {
      throw new Error(
        `Frozen Agnes QA retry for scene ${row.sceneNumber} no longer matches its persisted audio duration.`,
      );
    }
    const referenceImageUrls = parseAgnesReferenceImageUrls(row.publicReferenceUrl);
    const providerMode: AgnesVideoMode = referenceImageUrls.length > 0 ? "reference" : "text";
    const persistedDigest = createAgnesVideoRequestDigest({
      prompt: row.prompt,
      providerSeconds: row.providerDurationSeconds,
      seed: row.seed,
      duration: row.requestedDurationSeconds,
      mode: providerMode,
      referenceImageUrls,
    });
    if (persistedDigest !== row.requestDigest) {
      throw new Error(
        `Frozen Agnes QA retry for scene ${row.sceneNumber} has an inconsistent persisted request digest.`,
      );
    }
    return {
      providerPrompt: row.prompt,
      providerMode,
      referenceImageUrls,
      publicReferenceValue: serializeAgnesReferenceImageUrls(referenceImageUrls),
      requestDigest: row.requestDigest,
      seed: row.seed,
    };
  }
  const seed = params.existingRow?.seed !== null && params.existingRow?.seed !== undefined
    && hasDurableOrPotentialProviderWork(params.existingRow)
    ? params.existingRow.seed
    : params.preferredSeed;
  const proposedDigest = createAgnesVideoRequestDigest({
    prompt: params.proposedPrompt,
    providerSeconds: params.providerSeconds,
    seed,
    duration: params.durationSeconds,
    mode: params.proposedMode,
    referenceImageUrls: params.proposedReferenceImageUrls,
  });
  if (
    params.existingRow
    && hasDurableOrPotentialProviderWork(params.existingRow)
    && params.existingRow.requestDigest
    && params.existingRow.prompt.trim()
  ) {
    const persistedReferenceImageUrls = parseAgnesReferenceImageUrls(
      params.existingRow.publicReferenceUrl,
    );
    const persistedMode: AgnesVideoMode = persistedReferenceImageUrls.length > 0
      ? "reference"
      : "text";
    const persistedPromptDigest = createAgnesVideoRequestDigest({
      prompt: params.existingRow.prompt,
      providerSeconds: params.providerSeconds,
      seed,
      duration: params.durationSeconds,
      mode: persistedMode,
      referenceImageUrls: persistedReferenceImageUrls,
    });
    if (persistedPromptDigest === params.existingRow.requestDigest) {
      return {
        providerPrompt: params.existingRow.prompt,
        providerMode: persistedMode,
        referenceImageUrls: persistedReferenceImageUrls,
        publicReferenceValue: serializeAgnesReferenceImageUrls(persistedReferenceImageUrls),
        requestDigest: params.existingRow.requestDigest,
        seed,
      };
    }
  }
  return {
    providerPrompt: params.proposedPrompt,
    providerMode: params.proposedMode,
    referenceImageUrls: [...params.proposedReferenceImageUrls],
    publicReferenceValue: serializeAgnesReferenceImageUrls(params.proposedReferenceImageUrls),
    requestDigest: proposedDigest,
    seed,
  };
}

async function normalizeAgnesVideo(params: {
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
}): Promise<void> {
  const temporaryPath = `${params.outputPath}.${process.pid}.${randomUUID()}.tmp.mp4`;
  await mkdir(path.dirname(params.outputPath), { recursive: true });
  await rm(temporaryPath, { force: true });
  try {
    await runProcess(CONFIG.ffmpegPath, [
      "-y", "-i", params.inputPath, "-map", "0:v:0", "-vf",
      `fps=${OUTPUT_FPS},scale=1920:1080:force_original_aspect_ratio=decrease,` +
        `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
        `trim=start=0:duration=${params.durationSeconds},setpts=PTS-STARTPTS,format=yuv420p`,
      "-t", String(params.durationSeconds), "-an", "-c:v", "libx264",
      "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(OUTPUT_FPS),
      "-video_track_timescale", "90000", temporaryPath,
    ]);
    if (!(await reusableVideo(temporaryPath, params.durationSeconds))) {
      throw new Error(`Normalized Agnes video does not match ${params.durationSeconds.toFixed(3)}s`);
    }
    await rename(temporaryPath, params.outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

class SubmissionGate {
  private nextSlotAt = 0;
  private turn: Promise<void> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}
  async wait(deadlineAt?: number): Promise<boolean> {
    const previousTurn = this.turn;
    let releaseTurn!: () => void;
    this.turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    await previousTurn;
    try {
      const now = Date.now();
      const slot = Math.max(now, this.nextSlotAt);
      if (deadlineAt !== undefined && slot >= deadlineAt) return false;
      const waitMs = slot - now;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      // Anchor the next slot to the real request start. If the event loop wakes
      // this waiter late, pre-reserved timestamps must not let the following
      // request burst immediately behind it.
      const schedulingHeadroomMs = this.intervalMs <= 0
        ? 0
        : Math.min(1_000, Math.max(10, Math.ceil(this.intervalMs * 0.05)));
      this.nextSlotAt = Date.now() + Math.max(0, this.intervalMs) + schedulingHeadroomMs;
      return true;
    } finally {
      releaseTurn();
    }
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Reserves request starts in Turso so process restarts and overlapping agent
 * invocations cannot reset an account's rate window. A local gate remains as
 * a test/backward-compatible fallback for structural SeriesState doubles.
 */
class AccountRequestGate {
  private readonly fallback: SubmissionGate;

  constructor(
    private readonly seriesState: SeriesState,
    private readonly accountId: string,
    private readonly lane: "submit" | "status",
    private readonly intervalMs: number,
  ) {
    this.fallback = new SubmissionGate(intervalMs);
  }

  async wait(deadlineAt?: number): Promise<boolean> {
    if (this.intervalMs === 0
      || typeof (this.seriesState as Partial<SeriesState>).reserveAgnesAccountRateSlot !== "function") {
      return this.fallback.wait(deadlineAt);
    }
    const reservation = await this.seriesState.reserveAgnesAccountRateSlot({
      accountId: this.accountId,
      lane: this.lane,
      intervalMs: this.intervalMs,
    });
    let slotAt = reservation.scheduledAtMs;
    if (deadlineAt !== undefined && slotAt >= deadlineAt) return false;
    if (slotAt > Date.now()) await delay(slotAt - Date.now());

    // A concurrent request may have extended Retry-After after this slot was
    // reserved. Re-read only the cooldown; the reservation cursor itself must
    // not cause this already-reserved call to wait twice.
    if (typeof (this.seriesState as Partial<SeriesState>).getAgnesAccountRateState === "function") {
      const latest = await this.seriesState.getAgnesAccountRateState(this.accountId, this.lane);
      slotAt = Math.max(slotAt, latest?.blockedUntilMs ?? 0);
      if (deadlineAt !== undefined && slotAt >= deadlineAt) return false;
      if (slotAt > Date.now()) await delay(slotAt - Date.now());
    }
    return true;
  }

  async block(retryAfterMs: number | undefined, reason: string): Promise<void> {
    const durationMs = Math.max(this.intervalMs, retryAfterMs ?? 0);
    if (durationMs <= 0
      || typeof (this.seriesState as Partial<SeriesState>).blockAgnesAccountRateLane !== "function") return;
    await this.seriesState.blockAgnesAccountRateLane({
      accountId: this.accountId,
      lane: this.lane,
      blockedUntilMs: Date.now() + durationMs,
      blockReason: reason,
    });
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableNextRun(error: unknown): boolean {
  return error instanceof AgnesError && [
    "rate_limit", "quota_exhausted", "daily_limit", "insufficient_credits",
    "provider_capacity",
  ].includes(error.kind);
}

function dbStatus(task: AgnesVideoTask): AgnesSceneGenerationRow["status"] {
  // Accepted-but-not-yet-acknowledged is still pending in durable workflow
  // state; the exact provider detail remains in the receipt envelope.
  if (task.status === "submitted" || task.status === "pending") return "pending";
  if (task.status === "queued") return "queued";
  if (task.status === "failed") return "failed";
  if (task.status === "completed") return "completed";
  return "in_progress";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A normal Agnes POST already returns queued (or a later state), so this is
 * usually an immediate acknowledgement. The bounded loop also supports a
 * future/intermediate provider state without holding a worker forever.
 */
async function retrieveTaskWithOwningAccount(
  runtime: WorkflowRuntime,
  envelope: AgnesSceneReceiptEnvelope,
  task: AgnesVideoTask,
  deadlineAt?: number,
): Promise<AgnesVideoTask | undefined> {
  const account = accountForTask(runtime, latestAttempt(envelope), task);
  if (!account) {
    throw new AgnesError(
      "The exact Agnes account/key used for this accepted video is no longer configured; refusing to resubmit it.",
      { kind: "configuration", keyLabel: task.keyLabel },
    );
  }
  return account.statusSemaphore.run(async () => {
    if (!(await account.statusRequestGate.wait(deadlineAt))) return undefined;
    try {
      const latest = await account.client.retrieveVideo(task);
      if (latest.keyFingerprint !== task.keyFingerprint) {
        throw new AgnesError("Agnes retrieval changed the submitting key fingerprint", {
          kind: "provider",
          keyLabel: task.keyLabel,
        });
      }
      return latest;
    } catch (error) {
      if (error instanceof AgnesError && error.kind === "rate_limit") {
        await account.statusRequestGate.block(error.retryAfterMs, safeError(error));
      }
      throw error;
    }
  });
}

async function acknowledgeQueue(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  envelope: AgnesSceneReceiptEnvelope,
  initial: AgnesVideoTask,
): Promise<AgnesVideoTask> {
  let task = initial;
  const accountId = accountForTask(runtime, latestAttempt(envelope), initial)?.accountId;
  const acknowledged = () => ["queued", "in_progress", "completed", "failed"].includes(String(task.status));
  if (acknowledged()) return task;
  const deadline = Date.now() + runtime.queuePollWindowMs;
  let pollNumber = 0;
  while (Date.now() < deadline) {
    pollNumber += 1;
    const waitMs = Math.min(runtime.queuePollIntervalMs, Math.max(0, deadline - Date.now()));
    logAgnesProgress("queue_poll_wait", {
      ...assetProgressMetadata(scene),
      accountId,
      pollNumber,
      waitSeconds: Number((waitMs / 1_000).toFixed(1)),
      providerStatus: task.status,
    });
    await delay(waitMs);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineSignal = new Promise<{ kind: "deadline" }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), remainingMs);
    });
    let retrieved: { kind: "task"; value: AgnesVideoTask } | { kind: "deadline" };
    try {
      retrieved = await Promise.race([
        retrieveTaskWithOwningAccount(runtime, envelope, task, deadline)
          .then((value) => value === undefined
            ? ({ kind: "deadline" as const })
            : ({ kind: "task" as const, value })),
        deadlineSignal,
      ]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    if (retrieved.kind === "deadline") {
      logAgnesProgress("queue_poll_timeout", {
        ...assetProgressMetadata(scene),
        accountId,
        pollNumber,
        providerStatus: task.status,
      }, "warn");
      break;
    }
    task = retrieved.value;
    logAgnesProgress("queue_poll_result", {
      ...assetProgressMetadata(scene),
      accountId,
      pollNumber,
      providerStatus: task.status,
      progress: task.progress,
    });
    if (acknowledged()) return task;
  }
  return task;
}

async function mapConcurrent<T, R>(
  values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function positiveOption(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

export function resolveStatusRequestIntervalMs(
  explicitOverride: number | undefined,
  configuredIntervalMs: number,
): number {
  return explicitOverride ?? Math.max(MIN_PRODUCTION_STATUS_INTERVAL_MS, configuredIntervalMs);
}

export function requestIntervalForRpm(rpm: number): number {
  if (!Number.isSafeInteger(rpm) || rpm <= 0) throw new Error("Agnes RPM must be a positive integer.");
  return Math.ceil(60_000 / rpm);
}

function accountForTask(
  runtime: WorkflowRuntime,
  attempt: AgnesAttemptReceipt | undefined,
  task: AgnesVideoTask,
): AgnesAccountRuntime | undefined {
  if (attempt?.accountId) {
    const exactAccount = runtime.accounts.find(({ accountId }) => accountId === attempt.accountId);
    if (exactAccount && (exactAccount.acceptsAnyFingerprint
      || !exactAccount.keyFingerprint
      || exactAccount.keyFingerprint === task.keyFingerprint)) return exactAccount;
  }
  return runtime.accounts.find((account) => account.acceptsAnyFingerprint
    || account.keyFingerprint === task.keyFingerprint);
}

function createRuntime(seriesState: SeriesState, options: AgnesSceneVideoToolOptions): WorkflowRuntime {
  if (options.sceneNumbers && (
    options.sceneNumbers.length === 0
    || options.sceneNumbers.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || new Set(options.sceneNumbers).size !== options.sceneNumbers.length
  )) throw new Error("sceneNumbers must be a non-empty list of unique positive integers.");
  positiveOption("submissionBatchSize", options.submissionBatchSize);
  positiveOption("queuePollIntervalMs", options.queuePollIntervalMs);
  positiveOption("queuePollWindowMs", options.queuePollWindowMs);
  if (options.submissionIntervalMs !== undefined
    && (!Number.isSafeInteger(options.submissionIntervalMs) || options.submissionIntervalMs < 0)) {
    throw new Error("submissionIntervalMs must be a non-negative integer.");
  }
  if (options.statusRequestIntervalMs !== undefined
    && (!Number.isSafeInteger(options.statusRequestIntervalMs) || options.statusRequestIntervalMs < 0)) {
    throw new Error("statusRequestIntervalMs must be a non-negative integer.");
  }
  if (options.client && options.accounts) {
    throw new Error("Configure either one legacy Agnes client or explicit account clients, not both.");
  }
  const perAccountConcurrency = Math.min(
    MAX_SUBMISSION_CONCURRENCY,
    options.submissionBatchSize ?? CONFIG.agnesSubmissionBatchSize,
  );
  const submissionIntervalMs = options.submissionIntervalMs ?? Math.max(
    CONFIG.agnesSubmissionIntervalMs,
    requestIntervalForRpm(CONFIG.agnesSubmissionRpmPerAccount),
  );
  const statusIntervalMs = options.statusRequestIntervalMs ?? Math.max(
    resolveStatusRequestIntervalMs(undefined, CONFIG.agnesPollIntervalMs),
    requestIntervalForRpm(CONFIG.agnesStatusRpmPerAccount),
  );
  const configuredAccounts: AgnesAccountClientOption[] = options.accounts
    ? [...options.accounts]
    : options.client
      ? [{ accountId: "injected-account", client: options.client }]
      : CONFIG.agnesAccounts.map((account) => ({
        accountId: account.accountId,
        keyLabel: account.keyLabel,
        keyFingerprint: account.keyFingerprint,
        client: new AgnesVideoClient({
          apiKeys: [account.apiKey],
          baseUrl: CONFIG.agnesBaseUrl,
          requestTimeoutMs: CONFIG.agnesRequestTimeoutMs,
          pollIntervalMs: CONFIG.agnesPollIntervalMs,
          pollWindowMs: CONFIG.agnesPollWindowMs,
          maxDownloadBytes: CONFIG.agnesMaxDownloadBytes,
        }),
      }));
  const seenAccountIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const accounts = configuredAccounts.map((account): AgnesAccountRuntime => {
    const accountId = account.accountId.trim();
    if (!accountId) throw new Error("Agnes accountId must not be empty.");
    if (seenAccountIds.has(accountId)) throw new Error(`Duplicate Agnes accountId: ${accountId}`);
    seenAccountIds.add(accountId);
    if (account.keyFingerprint) {
      if (!/^[a-f0-9]{64}$/.test(account.keyFingerprint)) {
        throw new Error(`Agnes account ${accountId} has an invalid key fingerprint.`);
      }
      if (seenFingerprints.has(account.keyFingerprint)) {
        throw new Error(`Duplicate Agnes key fingerprint for account ${accountId}.`);
      }
      seenFingerprints.add(account.keyFingerprint);
    }
    return {
      accountId,
      client: account.client,
      keyLabel: account.keyLabel,
      keyFingerprint: account.keyFingerprint,
      acceptsAnyFingerprint: account.keyFingerprint === undefined,
      submissionGate: new AccountRequestGate(seriesState, accountId, "submit", submissionIntervalMs),
      statusRequestGate: new AccountRequestGate(seriesState, accountId, "status", statusIntervalMs),
      submissionSemaphore: new AsyncSemaphore(perAccountConcurrency),
      statusSemaphore: new AsyncSemaphore(perAccountConcurrency),
    };
  });
  const emptyClient = new AgnesVideoClient({
    apiKeys: [],
    baseUrl: CONFIG.agnesBaseUrl,
    requestTimeoutMs: CONFIG.agnesRequestTimeoutMs,
    maxDownloadBytes: CONFIG.agnesMaxDownloadBytes,
  });
  return {
    seriesState,
    accounts,
    downloadClient: accounts[0]?.client ?? emptyClient,
    probeMediaDuration: options.probeMediaDuration ?? probeDurationSeconds,
    normalizeVideo: options.normalizeVideo ?? normalizeAgnesVideo,
    submissionBatchSizePerAccount: perAccountConcurrency,
    totalSubmissionConcurrency: Math.max(1, accounts.length * perAccountConcurrency),
    downloadConcurrency: perAccountConcurrency,
    submissionIntervalMsPerAccount: submissionIntervalMs,
    statusIntervalMsPerAccount: statusIntervalMs,
    queuePollIntervalMs: options.queuePollIntervalMs ?? CONFIG.agnesQueuePollIntervalMs,
    queuePollWindowMs: options.queuePollWindowMs ?? CONFIG.agnesQueuePollWindowMs,
    attemptedSubmissions: new Set<string>(),
    disabledAccounts: new Set<string>(),
    haltedSubmissions: new Set<string>(),
    includeKeyArt: options.includeKeyArt ?? true,
    ensureKeyArtAudioAssets: options.ensureKeyArtAudioAssets ?? ensureAgnesKeyArtAudioAssets,
    ensureSeriesCharacterPortraits:
      options.ensureSeriesCharacterPortraits
      ?? ensureSeriesCharacterPortraits,
    ...(options.sceneNumbers ? { selectedSceneNumbers: [...options.sceneNumbers] } : {}),
  };
}

type CharacterReferenceSource = { name: string; source: string };
type ReferenceConditioning = {
  providerPrompt: string;
  providerMode: AgnesVideoMode;
  referenceImageUrls: string[];
};

function referenceTextFallback(prompt: string): ReferenceConditioning {
  return { providerPrompt: prompt, providerMode: "text", referenceImageUrls: [] };
}

function isPublicHttpsReference(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Enables reference mode only when every visible main character has one
 * durable public Supabase portrait URL. New work fails closed instead of
 * silently losing identity conditioning. Accepted legacy work remains bound
 * to its exact persisted mode, prompt, and URL set.
 */
async function resolveReferenceConditioning(params: {
  runtime: WorkflowRuntime;
  seriesId: number;
  episodeNumber: number;
  existingRow: AgnesSceneGenerationRow | null;
  prompt: string;
  characters: readonly CharacterReferenceSource[];
  requiredCharacterNames: readonly string[];
}): Promise<ReferenceConditioning> {
  if (hasDurableOrPotentialProviderWork(params.existingRow)) {
    // bindRequestToExistingWork will recover the exact persisted mode, URLs,
    // prompt and seed. Never publish or upgrade an accepted legacy text task.
    return referenceTextFallback(params.prompt);
  }

  if (params.requiredCharacterNames.length === 0) return referenceTextFallback(params.prompt);
  if (params.requiredCharacterNames.length > AGNES_MAX_REFERENCE_IMAGES) {
    throw new Error(
      `Agnes accepts at most ${AGNES_MAX_REFERENCE_IMAGES} visible main-character references; ` +
      `this asset requests ${params.requiredCharacterNames.length}.`,
    );
  }
  if (new Set(params.requiredCharacterNames).size !== params.requiredCharacterNames.length) {
    throw new Error("Agnes reference character names must be unique and ordered exactly once.");
  }

  const existingUrls = parseAgnesReferenceImageUrls(params.existingRow?.publicReferenceUrl);
  const expectedReferencePrompt = withReferenceIdentityMap(
    params.prompt,
    params.requiredCharacterNames.map((name) => ({ name })),
  );
  if (
    existingUrls.length === params.requiredCharacterNames.length
    && params.existingRow?.prompt.trim() === expectedReferencePrompt
  ) {
    return {
      providerPrompt: expectedReferencePrompt,
      providerMode: "reference",
      referenceImageUrls: existingUrls,
    };
  }

  const sourcesByName = new Map(params.characters.map(({ name, source }) => [name, source] as const));
  const orderedSources = params.requiredCharacterNames.map((name) => ({
    name,
    source: sourcesByName.get(name)?.trim() ?? "",
  }));
  if (orderedSources.some(({ source }) => !source)) {
    throw new Error(
      "At least one visible main character has no approved public Supabase portrait URL. " +
      "Run ensure_series_character_portraits before Agnes submission.",
    );
  }
  if (orderedSources.some(({ source }) => !isPublicHttpsReference(source))) {
    throw new Error(
      "Every visible main-character reference must be an anonymous credential-free HTTPS Supabase public URL.",
    );
  }
  const referenceImageUrls = orderedSources.map(({ source }) => source);
  if (new Set(referenceImageUrls).size !== referenceImageUrls.length) {
    throw new Error(
      "Two visible main characters resolve to the same portrait URL; each identity requires its own object.",
    );
  }
  return {
    providerPrompt: expectedReferencePrompt,
    providerMode: "reference",
    referenceImageUrls,
  };
}

async function prepareEpisode(runtime: WorkflowRuntime, seriesId: number, episodeNumber: number): Promise<PreparedScene[]> {
  const episode = await runtime.seriesState.getEpisodeByNumber(seriesId, episodeNumber);
  if (!episode) throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}`);
  let expectedEpisodeAudioRevision = await runtime.seriesState.getEpisodeAudioRevisionForAgnes(
    seriesId,
    episodeNumber,
  );
  await runtime.seriesState.assertEpisodeAudioReady(episode.id);
  const existingRows = await runtime.seriesState.listAgnesSceneGenerations(seriesId, episodeNumber);
  const agnesSubmissionStarted = existingRows.some(hasStartedAgnesSubmission);
  if (agnesSubmissionStarted) {
    await runtime.seriesState.assertEpisodeKeyArtAudioReady(seriesId, episodeNumber);
  }
  const seriesSeed = await runtime.seriesState.getOrCreateSeriesAgnesSeed(seriesId, CONFIG.agnesSeed);
  const expectedEpisodeScriptJson = canonicalEpisodeScriptJson(episode.scriptJson);
  const script = parseEpisodeScript(episode.scriptJson);
  const selected = runtime.selectedSceneNumbers ? new Set(runtime.selectedSceneNumbers) : undefined;
  const scriptedScenes = selected ? script.scenes.filter((scene) => selected.has(scene.sceneNumber)) : script.scenes;
  if (selected && scriptedScenes.length !== selected.size) {
    const available = new Set(script.scenes.map((scene) => scene.sceneNumber));
    const missing = runtime.selectedSceneNumbers!.filter((number) => !available.has(number));
    throw new Error(`Requested Agnes scenes are absent from the episode script: ${missing.join(", ")}`);
  }
  const episodeDir = path.join(CONFIG.outputDir, `series_${seriesId}`, `episode_${episodeNumber}`);
  const prepared: PreparedScene[] = [];
  const durationErrors: string[] = [];

  if (runtime.includeKeyArt) {
    const seriesInfo = await runtime.seriesState.getSeriesInfo(seriesId);
    if (!seriesInfo) throw new Error(`Series ${seriesId} was not found while preparing key-art videos.`);
    const characters = seriesInfo.charactersJson.length > 0
      ? seriesInfo.charactersJson
      : await runtime.seriesState.getSeriesCharacters(seriesId);
    if (characters.length === 0) {
      throw new Error(`Series ${seriesId} has no stored characters for its key-art video.`);
    }

    // Read-only fail-closed gate. Only runSubmit may repair the roster, and it
    // does so before the first durable provider claim. Verification/download
    // must never mutate a character identity after submission has begun.
    const lockedCharacters: Array<{
      name: string;
      portraitSource: string;
    }> = [];
    for (const character of characters) {
      const sheet = await runtime.seriesState.getCharacterSheet(seriesId, character.name);
      const publicUrl = sheet?.referenceImagePaths?.portrait?.publicUrl?.trim();
      if (!sheet?.approvedAt || !publicUrl) {
        throw new Error(
          `Approved public character portrait for "${character.name}" is missing` +
          (agnesSubmissionStarted
            ? " after Agnes submission already started, so its frozen reference cannot be changed."
            : " before Agnes submission. Run the portrait preflight before any provider request."),
        );
      }
      lockedCharacters.push({
        name: character.name,
        portraitSource: publicUrl,
      });
    }

    const seriesTitle = canonicalizeKeyArtTitle(seriesInfo.conceptName, "series");
    const episodeTitle = canonicalizeKeyArtTitle(episode.title, "episode");
    const [seriesAudio, episodeAudio] = await runtime.ensureKeyArtAudioAssets({
      seriesId,
      episodeNumber,
      seriesTitle,
      episodeTitle,
      options: {
        outputDir: CONFIG.outputDir,
        probeDurationSeconds: runtime.probeMediaDuration,
        audioMutationState: runtime.seriesState,
        allowMutation: !agnesSubmissionStarted,
      },
    });
    // Title generation, when needed, commits the same episode-wide revision as
    // narration TTS. Bind all prepared key-art and scene requests to that new
    // stable snapshot rather than the pre-generation revision.
    expectedEpisodeAudioRevision = await runtime.seriesState.getEpisodeAudioRevisionForAgnes(
      seriesId,
      episodeNumber,
    );
    // Re-read the exact published pair inside the new revision snapshot. This
    // also closes the narrow case where an overlapping owner rolled back after
    // an optimistic reusable-file read but before its lease was observed.
    await runtime.seriesState.assertEpisodeKeyArtAudioReady(seriesId, episodeNumber);

    const appearanceCounts = new Map<string, number>();
    for (const scene of script.scenes) {
      for (const name of scene.characterNames) {
        appearanceCounts.set(name, (appearanceCounts.get(name) ?? 0) + 1);
      }
    }
    const protagonist = [...lockedCharacters].sort((left, right) => {
      const countDelta = (appearanceCounts.get(right.name) ?? 0) - (appearanceCounts.get(left.name) ?? 0);
      return countDelta || lockedCharacters.indexOf(left) - lockedCharacters.indexOf(right);
    })[0]!;

    const keyArtSpecs: Array<{
      kind: "series" | "episode";
      audio: AgnesKeyArtAudioAsset;
      canonicalPrompt: string;
      characterNames: string[];
    }> = [
      {
        kind: "series",
        audio: seriesAudio,
        characterNames: lockedCharacters.map(({ name }) => name),
        canonicalPrompt: buildSeriesKeyArtVideoPrompt({
          conceptName: seriesTitle,
          conceptSummary: seriesInfo.episodeFormula.trim()
            || `A warm preschool adventure series starring ${lockedCharacters.map(({ name }) => name).join(", ")}.`,
          environmentDescription: script.scenes[0]?.environmentDescription,
          characterNames: lockedCharacters.map(({ name }) => name),
        }),
      },
      {
        kind: "episode",
        audio: episodeAudio,
        characterNames: [protagonist.name],
        canonicalPrompt: buildEpisodeKeyArtVideoPrompt({
          conceptName: seriesTitle,
          episodeTitle,
          episodePremise: episode.premise,
          environmentDescription: script.scenes[0]?.environmentDescription,
          mainCharacterName: protagonist.name,
        }),
      },
    ];

    for (const spec of keyArtSpecs) {
      const providerSeconds = planAgnesVideoSegments(spec.audio.durationSeconds)[0]!;
      const basePrompt = buildAgnesKeyArtVideoPrompt({
        canonicalKeyArtPrompt: spec.canonicalPrompt,
        title: spec.audio.text,
        targetDurationSeconds: spec.audio.durationSeconds,
        kind: spec.kind,
      });
      const existingRow = await runtime.seriesState.getAgnesSceneGeneration(
        seriesId,
        episodeNumber,
        spec.audio.trackingSceneNumber,
        "text",
      );
      const requiredCharacters = spec.characterNames.map((name) => {
        const character = lockedCharacters.find((candidate) => candidate.name === name);
        return {
          name,
          source: character?.portraitSource ?? "",
        };
      });
      const conditioning = await resolveReferenceConditioning({
        runtime,
        seriesId,
        episodeNumber,
        existingRow,
        prompt: basePrompt,
        characters: requiredCharacters,
        requiredCharacterNames: spec.characterNames,
      });
      const renderRevision = existingRow?.renderRevision ?? 0;
      const proposedPrompt = renderRevision === 1
        ? buildAgnesQaRetryPrompt(
            conditioning.providerPrompt,
            qaIssueCodesFromResult(existingRow?.qaResult),
          )
        : conditioning.providerPrompt;
      const seedDiscriminator = agnesAssetSeedDiscriminator(spec.audio.trackingSceneNumber);
      const binding = bindRequestToExistingWork({
        proposedPrompt,
        proposedMode: conditioning.providerMode,
        proposedReferenceImageUrls: conditioning.referenceImageUrls,
        providerSeconds,
        durationSeconds: spec.audio.durationSeconds,
        preferredSeed: deriveAgnesAssetSeed(
          seriesSeed,
          episodeNumber,
          renderRevision === 1 ? `${seedDiscriminator}:qa-retry-1` : seedDiscriminator,
        ),
        existingRow,
      });
      const prefix = binding.requestDigest.slice(0, 16);
      prepared.push({
        assetKind: spec.kind === "series" ? "series_key_art" : "episode_key_art",
        assetLabel: `${spec.kind} key art`,
        manifestIndex: prepared.length,
        input: {
          seriesId,
          sceneNumber: spec.audio.trackingSceneNumber,
          narrationText: spec.audio.text,
          environmentDescription: `${spec.kind} animated title-card composition`,
          action: "Gentle key-art title-card motion",
          characterNames: spec.characterNames,
        },
        durationSeconds: spec.audio.durationSeconds,
        providerSeconds,
        providerPrompt: binding.providerPrompt,
        providerMode: binding.providerMode,
        referenceImageUrls: binding.referenceImageUrls,
        publicReferenceValue: binding.publicReferenceValue,
        requestDigest: binding.requestDigest,
        expectedEpisodeScriptJson,
        expectedEpisodeAudioRevision,
        seed: binding.seed,
        normalizedPath: spec.audio.normalizedVideoPath,
        rawPath: path.join(spec.audio.rawDirectory, `${spec.audio.stem}_${prefix}.mp4`),
        promptPath: path.join(spec.audio.promptDirectory, `${spec.audio.stem}_${prefix}.txt`),
      });
    }
  }

  for (const scriptedScene of scriptedScenes) {
    const sceneNumber = scriptedScene.sceneNumber;
    const stem = `scene_${String(sceneNumber).padStart(3, "0")}`;
    const audioPath = path.join(episodeDir, "audio", `${stem}_narrator.wav`);
    if (!existsSync(audioPath)) throw new Error(`Groq narration audio is missing: ${audioPath}`);
    const durationSeconds = await runtime.probeMediaDuration(audioPath);
    const metadataPath = narrationAudioMetadataPath(audioPath);
    const metadata = await readNarrationAudioMetadata(metadataPath);
    const expectedAudioDigest = createNarrationAudioRequestDigest({
      text: scriptedScene.narrationText.trim(),
      model: CONFIG.groqTtsModel,
      voice: CONFIG.groqTtsVoice,
    });
    if (!metadata || metadata.requestDigest !== expectedAudioDigest) {
      durationErrors.push(
        `scene ${sceneNumber}: narration metadata is missing or does not match the persisted narration text; regenerate this scene's Groq audio`,
      );
      continue;
    }
    if (metadata.durationStatus !== "ready" || Math.abs(metadata.durationSeconds - durationSeconds) > 0.05) {
      durationErrors.push(
        `scene ${sceneNumber}: narration metadata is stale or marks the WAV as overlong; regenerate or split this script scene`,
      );
      continue;
    }
    let providerSeconds: number;
    try { [providerSeconds] = planAgnesVideoSegments(durationSeconds); }
    catch (error) { durationErrors.push(`scene ${sceneNumber}: ${safeError(error)}`); continue; }
    const input: ScenePromptInput = { seriesId, ...scriptedScene };
    const {
      prompt: canonicalPrompt,
      characterNames,
      characterReferenceSources,
    } = await materializeScenePrompt({
      seriesState: runtime.seriesState,
      input,
      requestedBy: `Agnes video for scene ${sceneNumber}`,
    });
    const existingRow = await runtime.seriesState.getAgnesSceneGeneration(
      seriesId,
      episodeNumber,
      sceneNumber,
      "text",
    );
    const basePrompt = buildAgnesVideoPrompt({
      canonicalScenePrompt: canonicalPrompt,
      targetDurationSeconds: durationSeconds,
    });
    const conditioning = await resolveReferenceConditioning({
      runtime,
      seriesId,
      episodeNumber,
      existingRow,
      prompt: basePrompt,
      characters: characterReferenceSources ?? [],
      requiredCharacterNames: characterNames,
    });
    const renderRevision = existingRow?.renderRevision ?? 0;
    const proposedPrompt = renderRevision === 1
      ? buildAgnesQaRetryPrompt(
          conditioning.providerPrompt,
          qaIssueCodesFromResult(existingRow?.qaResult),
        )
      : conditioning.providerPrompt;
    const seedDiscriminator = agnesAssetSeedDiscriminator(sceneNumber);
    const binding = bindRequestToExistingWork({
      proposedPrompt,
      proposedMode: conditioning.providerMode,
      proposedReferenceImageUrls: conditioning.referenceImageUrls,
      providerSeconds: providerSeconds!,
      durationSeconds,
      preferredSeed: deriveAgnesAssetSeed(
        seriesSeed,
        episodeNumber,
        renderRevision === 1 ? `${seedDiscriminator}:qa-retry-1` : seedDiscriminator,
      ),
      existingRow,
    });
    const variantDir = path.join(episodeDir, "agnes_text");
    const prefix = binding.requestDigest.slice(0, 16);
    prepared.push({
      assetKind: "scene",
      assetLabel: `scene ${sceneNumber}`,
      manifestIndex: prepared.length,
      input,
      durationSeconds,
      providerSeconds: providerSeconds!,
      providerPrompt: binding.providerPrompt,
      providerMode: binding.providerMode,
      referenceImageUrls: binding.referenceImageUrls,
      publicReferenceValue: binding.publicReferenceValue,
      requestDigest: binding.requestDigest,
      expectedEpisodeScriptJson,
      expectedEpisodeAudioRevision,
      seed: binding.seed,
      normalizedPath: path.join(variantDir, "scenes", `${stem}.mp4`),
      rawPath: path.join(variantDir, "raw", `${stem}_${prefix}.mp4`),
      promptPath: path.join(variantDir, "prompts", `${stem}_${prefix}.txt`),
    });
  }
  if (durationErrors.length > 0) {
    throw new Error(
      "Agnes preflight rejected narration that is stale, mismatched, or longer than one 12-second request. " +
      "Split affected script scenes when needed and regenerate their audio: "
      + durationErrors.join(" | "),
    );
  }
  const verifiedEpisodeAudioRevision = await runtime.seriesState.getEpisodeAudioRevisionForAgnes(
    seriesId,
    episodeNumber,
  );
  if (verifiedEpisodeAudioRevision !== expectedEpisodeAudioRevision) {
    throw new Error(
      `Episode narration audio changed during Agnes preparation (revision ` +
      `${expectedEpisodeAudioRevision} -> ${verifiedEpisodeAudioRevision}); rerun against the stable audio set.`,
    );
  }
  for (const scene of prepared) scene.manifestSize = prepared.length;
  return prepared;
}

type LoadedAgnesSceneState = {
  row: AgnesSceneGenerationRow;
  envelope: AgnesSceneReceiptEnvelope;
};

async function loadState(
  runtime: WorkflowRuntime, scene: PreparedScene, seriesId: number, episodeNumber: number,
  materializeMissing?: true,
): Promise<LoadedAgnesSceneState>;
async function loadState(
  runtime: WorkflowRuntime, scene: PreparedScene, seriesId: number, episodeNumber: number,
  materializeMissing: false,
): Promise<LoadedAgnesSceneState | null>;
async function loadState(
  runtime: WorkflowRuntime, scene: PreparedScene, seriesId: number, episodeNumber: number,
  materializeMissing = true,
): Promise<LoadedAgnesSceneState | null> {
  const sceneNumber = scene.input.sceneNumber;
  let row = await runtime.seriesState.getAgnesSceneGeneration(seriesId, episodeNumber, sceneNumber, "text");
  if (!row) {
    if (!materializeMissing) return null;
    row = await runtime.seriesState.upsertAgnesSceneGeneration({
      seriesId, episodeNumber, sceneNumber, variant: "text", status: "pending",
      prompt: scene.providerPrompt, requestDigest: scene.requestDigest, seed: scene.seed,
      requestedDurationSeconds: scene.durationSeconds, providerDurationSeconds: scene.providerSeconds,
      publicReferenceUrl: scene.publicReferenceValue,
    });
  } else if (row.requestDigest !== scene.requestDigest) {
    // A non-materializing reload runs only after this invocation's initial
    // preparation snapshot. A mismatch means another invocation changed the
    // script/request, so this stale invocation must not reset it backwards.
    if (!materializeMissing) return null;
    const safety = receiptSafety(row.providerReceipt);
    if (safety.accepted || safety.unresolved || row.providerTaskId) {
      throw new Error(`Stored Agnes receipt for scene ${sceneNumber} belongs to a different request and may be accepted.`);
    }
    const reset = await runtime.seriesState.resetAgnesSceneGenerationForRequest({
      seriesId, episodeNumber, sceneNumber, variant: "text", prompt: scene.providerPrompt,
      requestDigest: scene.requestDigest, seed: scene.seed,
      requestedDurationSeconds: scene.durationSeconds, providerDurationSeconds: scene.providerSeconds,
      publicReferenceUrl: scene.publicReferenceValue,
    }, { requestDigest: row.requestDigest, attemptCount: row.attemptCount });
    row = reset.row;
    if (!reset.reset && row.requestDigest !== scene.requestDigest) {
      throw new Error(`Another invocation changed Agnes scene ${sceneNumber}; rerun to use its durable state.`);
    }
  }
  const envelope = row.providerReceipt == null
    ? newEnvelope(scene.requestDigest, scene.providerSeconds)
    : parseEnvelope(row.providerReceipt, scene.requestDigest, scene.providerSeconds);
  if (!envelope) throw new Error(`Stored Agnes receipt for scene ${sceneNumber} is invalid; unsafe resubmission refused.`);
  return { row, envelope };
}

async function persistState(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  seriesId: number,
  episodeNumber: number,
  envelope: AgnesSceneReceiptEnvelope,
  status: AgnesSceneGenerationRow["status"],
  extra: {
    error?: string | null;
    rawOutputPath?: string;
    normalizedOutputPath?: string;
    completedAt?: string;
    downloadStatus?: AgnesSceneGenerationRow["downloadStatus"];
  } = {},
): Promise<AgnesSceneGenerationRow> {
  const task = activeTask(envelope);
  return runtime.seriesState.upsertAgnesSceneGeneration({
    seriesId, episodeNumber, sceneNumber: scene.input.sceneNumber, variant: "text", status,
    prompt: scene.providerPrompt, requestDigest: scene.requestDigest, seed: scene.seed,
    requestedDurationSeconds: scene.durationSeconds, providerDurationSeconds: scene.providerSeconds,
    publicReferenceUrl: scene.publicReferenceValue,
    providerTaskId: task?.video_id, providerReceipt: cloneEnvelope(envelope),
    providerVideoUrl: task?.metadata?.url, rawOutputPath: extra.rawOutputPath,
    normalizedOutputPath: extra.normalizedOutputPath, downloadStatus: extra.downloadStatus,
    error: extra.error, completedAt: extra.completedAt,
  });
}

function retryDelayRemaining(attempt: AgnesAttemptReceipt | undefined): number {
  // Account-scoped cooldowns are enforced by the durable scheduler lane. A
  // scene-level delay here would incorrectly prevent safe failover to another
  // independently limited account. Keep this only for legacy receipts.
  if (attempt?.accountId) return 0;
  if (!attempt?.retryAfterMs) return 0;
  const finishedAt = Date.parse(attempt.finishedAt ?? attempt.startedAt);
  return Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt + attempt.retryAfterMs - Date.now())
    : attempt.retryAfterMs;
}

function logicalSubmissionKey(
  seriesId: number,
  episodeNumber: number,
  scene: PreparedScene,
): string {
  return `${seriesId}:${episodeNumber}:${scene.input.sceneNumber}:${scene.requestDigest}`;
}

function staleSubmittingDiagnostic(attempt: AgnesAttemptReceipt | undefined): string | undefined {
  if (!attempt || !["submitting", "ambiguous"].includes(attempt.state) || attempt.task) return undefined;
  const startedAt = Date.parse(attempt.startedAt);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < AGNES_STALE_SUBMISSION_LEASE_MS) {
    return undefined;
  }
  if (attempt.state === "submitting" && attempt.submissionPhase === "claim_created") {
    return `Recovered a pre-POST Agnes claim after the ${AGNES_STALE_SUBMISSION_LEASE_MS / 60_000}-minute stale lease; no provider POST had been started.`;
  }
  return `Recovered a stale Agnes submission after the ${AGNES_STALE_SUBMISSION_LEASE_MS / 60_000}-minute lease. `
    + "The prior POST outcome is ambiguous, so this later-run retry may create a duplicate provider render.";
}

async function recoverStaleSubmittingAttempt(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  seriesId: number,
  episodeNumber: number,
  state: { row: AgnesSceneGenerationRow; envelope: AgnesSceneReceiptEnvelope },
): Promise<{ row: AgnesSceneGenerationRow; envelope: AgnesSceneReceiptEnvelope; diagnostic?: string }> {
  const attempt = latestAttempt(state.envelope);
  // A replacement attempt after a terminal provider failure can temporarily
  // retain the prior failed task id in the row until its own POST succeeds.
  // Only an id belonging to the latest accepted task proves this attempt has a
  // provider receipt and must suppress stale-claim recovery.
  if (state.row.providerTaskId
    && activeTask(state.envelope)?.video_id === state.row.providerTaskId) return state;
  const diagnostic = staleSubmittingDiagnostic(attempt);
  if (!attempt || !diagnostic) return state;
  attempt.state = "definite_rejection";
  attempt.finishedAt = new Date().toISOString();
  attempt.retrySafe = true;
  attempt.error = diagnostic;
  const row = await persistState(
    runtime,
    scene,
    seriesId,
    episodeNumber,
    state.envelope,
    "pending",
    { error: diagnostic },
  );
  return { row, envelope: state.envelope, diagnostic };
}

function isSubmissionCandidate(
  row: AgnesSceneGenerationRow,
  envelope: AgnesSceneReceiptEnvelope,
): boolean {
  const task = activeTask(envelope);
  // A terminal provider failure has a definite outcome, so a replacement is
  // safe on a later invocation even though the durable row is marked failed.
  if (task?.status === "failed") return true;
  if (row.status === "pending" && !task) return true;
  // Includes old rows that crashed after persisting status=submitted but before
  // a task receipt. submitOne applies the stale lease before allowing a POST.
  return !task && latestAttempt(envelope)?.state === "submitting";
}

async function submitOneInternal(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  seriesId: number,
  episodeNumber: number,
  preferredAccountIndex = 0,
): Promise<Record<string, unknown>> {
  const logicalKey = logicalSubmissionKey(seriesId, episodeNumber, scene);
  let state = await loadState(runtime, scene, seriesId, episodeNumber, false);
  if (!state) {
    return {
      sceneNumber: scene.input.sceneNumber,
      status: "pending",
      preparedRequestMissing: true,
      error: "The prepared Agnes request changed before submission; rerun to prepare the current script.",
    };
  }
  let recovered = await recoverStaleSubmittingAttempt(
    runtime, scene, seriesId, episodeNumber, state,
  );
  state = recovered;
  let { row, envelope } = state;
  let recoveryDiagnostic = recovered.diagnostic;
  let task = activeTask(envelope);
  if (task && task.status !== "failed") {
    return { sceneNumber: scene.input.sceneNumber, status: dbStatus(task), reused: true };
  }
  let previous = latestAttempt(envelope);
  if (previous?.state === "submitting" || previous?.state === "ambiguous") {
    return {
      sceneNumber: scene.input.sceneNumber,
      status: "blocked",
      error: previous.error ?? "Unresolved POST outcome; wait for the stale-submission lease before retrying.",
    };
  }
  if (previous?.state === "definite_rejection" && !previous.retrySafe) {
    return { sceneNumber: scene.input.sceneNumber, status: "failed", error: previous.error };
  }
  const remaining = retryDelayRemaining(previous);
  if (remaining > 0) {
    return { sceneNumber: scene.input.sceneNumber, status: "pending", retryAfterMs: remaining, error: previous?.error };
  }
  if (runtime.haltedSubmissions.has(logicalKey)) {
    return {
      sceneNumber: scene.input.sceneNumber,
      status: "pending",
      skippedSameInvocation: true,
      error: "This scene had a non-rotatable Agnes outcome in this invocation; retry only on a later run.",
    };
  }
  if (runtime.accounts.length === 0) {
    throw new AgnesError(
      "No Agnes account configured; set AGNES_API_KEY (or AGNES_API_KEY_1 and later numbered accounts).",
      { kind: "configuration" },
    );
  }

  const startIndex = ((preferredAccountIndex % runtime.accounts.length) + runtime.accounts.length)
    % runtime.accounts.length;
  const orderedAccounts = runtime.accounts.map((_account, offset) => (
    runtime.accounts[(startIndex + offset) % runtime.accounts.length]!
  ));
  const failoverErrors: Array<{ accountId: string; error: string }> = [];

  for (const account of orderedAccounts) {
    if (runtime.disabledAccounts.has(account.accountId)) continue;
    const physicalAttemptKey = `${logicalKey}:${account.accountId}`;
    if (runtime.attemptedSubmissions.has(physicalAttemptKey)) continue;
    runtime.attemptedSubmissions.add(physicalAttemptKey);

    const outcome = await account.submissionSemaphore.run(async (): Promise<{
      failover: boolean;
      result: Record<string, unknown>;
    }> => {
      if (runtime.disabledAccounts.has(account.accountId)) {
        return {
          failover: true,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: "pending",
            accountId: account.accountId,
            error: "This Agnes account was disabled for the current invocation after a quota/credit limit.",
          },
        };
      }
      logAgnesProgress("submission_slot_wait", {
        ...assetProgressMetadata(scene),
        accountId: account.accountId,
      });
      await account.submissionGate.wait();
      if (runtime.disabledAccounts.has(account.accountId)) {
        return {
          failover: true,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: "pending",
            accountId: account.accountId,
            error: "This Agnes account became unavailable while waiting for its submission slot.",
          },
        };
      }
      const refreshedState = await loadState(runtime, scene, seriesId, episodeNumber, false);
      if (!refreshedState) {
        return {
          failover: false,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: "pending",
            preparedRequestMissing: true,
            error: "The prepared Agnes request changed before submission; rerun to prepare the current script.",
          },
        };
      }
      state = refreshedState;
      recovered = await recoverStaleSubmittingAttempt(runtime, scene, seriesId, episodeNumber, state);
      state = recovered;
      recoveryDiagnostic ??= recovered.diagnostic;
      ({ row, envelope } = state);
      task = activeTask(envelope);
      if (task && task.status !== "failed") {
        return {
          failover: false,
          result: { sceneNumber: scene.input.sceneNumber, status: dbStatus(task), reused: true },
        };
      }
      previous = latestAttempt(envelope);
      if (previous?.state === "submitting" || previous?.state === "ambiguous") {
        runtime.haltedSubmissions.add(logicalKey);
        return {
          failover: false,
          result: { sceneNumber: scene.input.sceneNumber, status: "blocked", error: previous.error },
        };
      }
      if (previous?.state === "definite_rejection" && !previous.retrySafe) {
        return {
          failover: false,
          result: { sceneNumber: scene.input.sceneNumber, status: "failed", error: previous.error },
        };
      }
      const remainingAfterWait = retryDelayRemaining(previous);
      if (remainingAfterWait > 0) {
        return {
          failover: false,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: "pending",
            retryAfterMs: remainingAfterWait,
            error: previous?.error,
          },
        };
      }

      const claimToken = randomUUID();
      envelope.attempts.push({
        attemptNumber: envelope.attempts.length + 1,
        claimToken,
        state: "submitting",
        startedAt: new Date().toISOString(),
        submissionPhase: "claim_created",
        accountId: account.accountId,
        ...(account.keyLabel ? { keyLabel: account.keyLabel } : {}),
        ...(account.keyFingerprint ? { keyFingerprint: account.keyFingerprint } : {}),
      });
      const claim = await runtime.seriesState.claimAgnesSceneSubmission({
        seriesId, episodeNumber, sceneNumber: scene.input.sceneNumber, variant: "text",
        prompt: scene.providerPrompt, requestDigest: scene.requestDigest, seed: scene.seed,
        expectedEpisodeScriptJson: scene.expectedEpisodeScriptJson,
        expectedEpisodeAudioRevision: scene.expectedEpisodeAudioRevision,
        requestedDurationSeconds: scene.durationSeconds, providerDurationSeconds: scene.providerSeconds,
        publicReferenceUrl: scene.publicReferenceValue,
        providerReceipt: cloneEnvelope(envelope),
      }, row.attemptCount);
      if (!claim.claimed) {
        return {
          failover: false,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: "pending",
            ...(claim.reason === "missing" ? { preparedRequestMissing: true } : {}),
            error: claim.reason === "missing"
              ? "The prepared Agnes request changed before it could be claimed; rerun to prepare the current script."
              : "Another invocation claimed or changed this submission.",
          },
        };
      }

      const claimedAttempt = latestAttempt(envelope)!;
      claimedAttempt.submissionPhase = "post_started";
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, "pending");
      const request: AgnesSubmitVideoRequest = scene.providerMode === "reference"
        ? {
            mode: "reference",
            prompt: scene.providerPrompt,
            seconds: scene.providerSeconds,
            seed: scene.seed,
            images: scene.referenceImageUrls,
          }
        : {
            mode: "text",
            prompt: scene.providerPrompt,
            seconds: scene.providerSeconds,
            seed: scene.seed,
          };
      logAgnesProgress("submission_start", {
        ...assetProgressMetadata(scene),
        accountId: account.accountId,
        attemptNumber: claimedAttempt.attemptNumber,
        providerMode: scene.providerMode,
        referenceImageCount: scene.referenceImageUrls.length,
      });
      try {
        task = await account.client.submitVideo(request);
      } catch (error) {
        const attempt = latestAttempt(envelope)!;
        const agnesError = error instanceof AgnesError ? error : undefined;
        const ambiguous = Boolean(agnesError?.ambiguousOutcome);
        const retryable = !ambiguous && retryableNextRun(error);
        const mayFailover = Boolean(!ambiguous && agnesError?.mayTryAnotherKey);
        attempt.state = ambiguous ? "ambiguous" : "definite_rejection";
        attempt.finishedAt = new Date().toISOString();
        attempt.retrySafe = retryable;
        attempt.retryAfterMs = agnesError?.retryAfterMs;
        attempt.error = safeError(error);
        attempt.errorKind = agnesError?.kind;
        await persistState(
          runtime,
          scene,
          seriesId,
          episodeNumber,
          envelope,
          retryable || ambiguous ? "pending" : "failed",
          { error: attempt.error },
        );

        if (agnesError?.kind === "rate_limit") {
          await account.submissionGate.block(agnesError.retryAfterMs, attempt.error);
        } else if (agnesError?.retryAfterMs !== undefined && mayFailover) {
          await account.submissionGate.block(agnesError.retryAfterMs, attempt.error);
        }
        if (agnesError && ["quota_exhausted", "daily_limit", "insufficient_credits"].includes(agnesError.kind)) {
          runtime.disabledAccounts.add(account.accountId);
        }
        if (ambiguous || agnesError?.kind === "provider_capacity") {
          runtime.haltedSubmissions.add(logicalKey);
        }

        return {
          failover: mayFailover,
          result: {
            sceneNumber: scene.input.sceneNumber,
            status: retryable || ambiguous ? "pending" : "failed",
            accountId: account.accountId,
            failoverEligible: mayFailover,
            ambiguousOutcome: ambiguous,
            retryAfterLeaseMs: ambiguous ? AGNES_STALE_SUBMISSION_LEASE_MS : undefined,
            error: attempt.error,
          },
        };
      }

      const attempt = latestAttempt(envelope)!;
      // A production account client contains exactly one key, so this is the
      // authoritative credential identity. Persist the returned fingerprint
      // even for custom clients to ensure a later GET can never use another key.
      task = { ...task, keyLabel: account.keyLabel ?? task.keyLabel };
      const fingerprintMismatch = account.keyFingerprint !== undefined
        && task.keyFingerprint !== account.keyFingerprint
        ? new AgnesError(
            `Agnes account ${account.accountId} returned a task bound to a different key fingerprint; ` +
              "the accepted receipt was persisted, but this client configuration must be corrected before retrieval.",
            { kind: "configuration", keyLabel: account.keyLabel },
          )
        : undefined;
      attempt.state = "accepted";
      attempt.finishedAt = new Date().toISOString();
      attempt.retrySafe = false;
      attempt.keyLabel = task.keyLabel;
      attempt.keyFingerprint = task.keyFingerprint;
      attempt.task = task;
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, dbStatus(task), {
        error: fingerprintMismatch?.message ?? (task.status === "failed" ? safeError(task.error) : null),
      });
      logAgnesProgress("submission_accepted", {
        ...assetProgressMetadata(scene),
        accountId: account.accountId,
        attemptNumber: attempt.attemptNumber,
        providerStatus: task.status,
      });
      // A valid provider id is an accepted remote side effect even when an
      // injected client reports the wrong credential identity. Fail closed only
      // after durably recording it so a rerun can never submit a duplicate.
      if (fingerprintMismatch) throw fingerprintMismatch;
      if (!["queued", "in_progress", "completed", "failed"].includes(String(task.status))) {
        try {
          task = await acknowledgeQueue(runtime, scene, envelope, task);
          attempt.task = task;
          await persistState(runtime, scene, seriesId, episodeNumber, envelope, dbStatus(task), {
            error: task.status === "failed" ? safeError(task.error) : null,
          });
        } catch (error) {
          logAgnesProgress("queue_poll_error", {
            ...assetProgressMetadata(scene),
            accountId: account.accountId,
            error: safeProgressError(error, scene.providerPrompt),
          }, "warn");
          // The accepted video_id remains durable. A later verification call
          // uses that exact account receipt and never submits a replacement.
          await persistState(runtime, scene, seriesId, episodeNumber, envelope, "pending", {
            error: `Queue acknowledgement interrupted: ${safeError(error)}`,
          });
          return {
            failover: false,
            result: {
              sceneNumber: scene.input.sceneNumber,
              status: "pending",
              accountId: account.accountId,
              providerVideoId: task.video_id,
              error: safeError(error),
            },
          };
        }
      }
      const queueAcknowledged = ["queued", "in_progress", "completed", "failed"]
        .includes(String(task.status));
      logAgnesProgress(queueAcknowledged ? "queue_acknowledged" : "queue_acknowledgement_pending", {
        ...assetProgressMetadata(scene),
        accountId: account.accountId,
        providerStatus: task.status,
        progress: task.progress,
      }, task.status === "failed" ? "error" : queueAcknowledged ? "info" : "warn");
      return {
        failover: false,
        result: {
          sceneNumber: scene.input.sceneNumber,
          status: dbStatus(task),
          providerStatus: task.status,
          providerVideoId: task.video_id,
          accountId: account.accountId,
          ...(recoveryDiagnostic ? { recoveryDiagnostic } : {}),
        },
      };
    });

    if (!outcome.failover) return outcome.result;
    failoverErrors.push({ accountId: account.accountId, error: String(outcome.result.error ?? "Rejected") });
  }

  return {
    sceneNumber: scene.input.sceneNumber,
    status: "pending",
    skippedSameInvocation: true,
    failoverExhausted: failoverErrors.length > 0,
    failoverErrors,
    error: failoverErrors.length > 0
      ? "Every currently usable Agnes account rejected this scene with a safe key-scoped limit. Retry in a later run."
      : "No untried Agnes account is available in this invocation.",
  };
}

async function submitOne(
  runtime: WorkflowRuntime,
  scene: PreparedScene,
  seriesId: number,
  episodeNumber: number,
  preferredAccountIndex = 0,
): Promise<Record<string, unknown>> {
  try {
    const result = await submitOneInternal(
      runtime,
      scene,
      seriesId,
      episodeNumber,
      preferredAccountIndex,
    );
    const accountId = typeof result.accountId === "string" ? result.accountId : undefined;
    const status = typeof result.status === "string" ? result.status : "unknown";
    const providerStatus = typeof result.providerStatus === "string"
      ? result.providerStatus
      : undefined;
    if (result.error !== undefined) {
      logAgnesProgress("submission_error", {
        ...assetProgressMetadata(scene),
        accountId,
        status,
        error: safeProgressError(result.error, scene.providerPrompt),
      }, status === "failed" || status === "blocked" ? "error" : "warn");
    }
    logAgnesProgress("submission_result", {
      ...assetProgressMetadata(scene),
      accountId,
      status,
      providerStatus,
      reused: result.reused === true,
      failoverEligible: result.failoverEligible === true,
      ambiguousOutcome: result.ambiguousOutcome === true,
    });
    return result;
  } catch (error) {
    logAgnesProgress("submission_error", {
      ...assetProgressMetadata(scene),
      status: "threw",
      errorKind: error instanceof AgnesError ? error.kind : "unexpected",
      error: safeProgressError(error, scene.providerPrompt),
    }, "error");
    throw error;
  }
}

async function initializeAll(
  runtime: WorkflowRuntime, scenes: readonly PreparedScene[], seriesId: number, episodeNumber: number,
): Promise<Array<{ scene: PreparedScene; row: AgnesSceneGenerationRow; envelope: AgnesSceneReceiptEnvelope }>> {
  const result = [];
  for (const scene of scenes) {
    await mkdir(path.dirname(scene.promptPath), { recursive: true });
    await writeFile(scene.promptPath, scene.providerPrompt, "utf8");
    result.push({ scene, ...await loadState(runtime, scene, seriesId, episodeNumber) });
  }
  return result;
}

/**
 * Repairs a partial portrait phase only before this episode has any durable
 * Agnes side effect. `prepareEpisode` remains read-only so verify/download can
 * never change an identity that an accepted prompt may already reference.
 */
async function ensureRosterBeforeFirstAgnesClaim(
  runtime: WorkflowRuntime,
  seriesId: number,
  episodeNumber: number,
): Promise<void> {
  if (!runtime.includeKeyArt) return;
  const existingRows = await runtime.seriesState.listAgnesSceneGenerations(seriesId, episodeNumber);
  if (existingRows.some(hasStartedAgnesSubmission)) return;

  const seriesInfo = await runtime.seriesState.getSeriesInfo(seriesId);
  if (!seriesInfo) throw new Error(`Series ${seriesId} was not found while ensuring its character roster.`);
  const roster = seriesInfo.charactersJson.length > 0
    ? seriesInfo.charactersJson
    : await runtime.seriesState.getSeriesCharacters(seriesId);
  if (roster.length === 0) {
    throw new Error(`Series ${seriesId} has no stored characters for its key-art video.`);
  }
  await runtime.ensureSeriesCharacterPortraits({
    seriesState: runtime.seriesState,
    seriesId,
    roster,
  });
}

function logAgnesPhaseStart(
  runtime: WorkflowRuntime,
  phase: "submit" | "verify" | "download",
  seriesId: number,
  episodeNumber: number,
): void {
  logAgnesProgress("phase_start", {
    phase,
    seriesId,
    episodeNumber,
    accountCount: runtime.accounts.length,
    workersPerAccount: runtime.submissionBatchSizePerAccount,
    totalConcurrency: runtime.totalSubmissionConcurrency,
    submissionSpacingSecondsPerAccount: Number(
      (runtime.submissionIntervalMsPerAccount / 1_000).toFixed(1),
    ),
    statusSpacingSecondsPerAccount: Number(
      (runtime.statusIntervalMsPerAccount / 1_000).toFixed(1),
    ),
    queuePollSeconds: Number((runtime.queuePollIntervalMs / 1_000).toFixed(1)),
    queueWindowSeconds: Number((runtime.queuePollWindowMs / 1_000).toFixed(1)),
  });
}

function logPreparedAssets(
  phase: "submit" | "verify" | "download",
  scenes: readonly PreparedScene[],
): void {
  logAgnesProgress("prepared", {
    phase,
    assetCount: scenes.length,
    sceneCount: scenes.filter(({ assetKind }) => assetKind === "scene").length,
    keyArtCount: scenes.filter(({ assetKind }) => assetKind !== "scene").length,
    targetDurationSeconds: Number(
      scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0).toFixed(3),
    ),
  });
}

async function runSubmit(runtime: WorkflowRuntime, seriesId: number, episodeNumber: number): Promise<string> {
  logAgnesPhaseStart(runtime, "submit", seriesId, episodeNumber);
  await ensureRosterBeforeFirstAgnesClaim(runtime, seriesId, episodeNumber);
  const scenes = await prepareEpisode(runtime, seriesId, episodeNumber);
  logPreparedAssets("submit", scenes);
  const states = await initializeAll(runtime, scenes, seriesId, episodeNumber);
  // Snapshot candidates: a retry-safe failure is never re-attempted in this invocation.
  const candidates = states.filter(({ row, envelope }) => (
    isSubmissionCandidate(row, envelope)
  )).map(({ scene }) => scene);
  logAgnesProgress("submission_plan", {
    phase: "submit",
    assetCount: scenes.length,
    pendingSubmissionCount: candidates.length,
    alreadyDurableCount: scenes.length - candidates.length,
  });
  const results = await mapConcurrent(candidates, runtime.totalSubmissionConcurrency, (scene) => (
    submitOne(
      runtime,
      scene,
      seriesId,
      episodeNumber,
      runtime.accounts.length > 0 ? scene.manifestIndex % runtime.accounts.length : 0,
    )
  ));
  // This is a read-only reconciliation pass. Script promotion may have
  // invalidated a prepared row while submissions were waiting for an account
  // gate; recreating it here would resurrect stale work after we safely skipped
  // the POST.
  const finalSnapshots = await Promise.all(scenes.map(async (scene) => {
    const state = await loadState(runtime, scene, seriesId, episodeNumber, false);
    return state ? { scene, ...state } : null;
  }));
  const finalStates = finalSnapshots.filter((state): state is NonNullable<typeof state> => state !== null);
  const missingPreparedRows = finalSnapshots.length - finalStates.length;
  const finalClassifications = finalStates.map(({ row, envelope }) => {
    const task = activeTask(envelope);
    if (task?.status === "queued" || task?.status === "in_progress" || task?.status === "completed") {
      return "acknowledged" as const;
    }
    if (task?.status === "submitted" || task?.status === "pending") return "awaiting_ack" as const;
    if (task?.status === "failed" || row.status === "failed") return "failed" as const;
    if (latestAttempt(envelope)?.state === "submitting") return "unresolved_claim" as const;
    if (row.status === "pending") return "pending" as const;
    return "failed" as const;
  });
  const queued = finalStates.filter(({ envelope }) => activeTask(envelope)?.status === "queued").length;
  const inProgress = finalStates.filter(({ envelope }) => activeTask(envelope)?.status === "in_progress").length;
  const providerCompleted = finalStates.filter(({ envelope }) => activeTask(envelope)?.status === "completed").length;
  const acknowledged = finalClassifications.filter((value) => value === "acknowledged").length;
  const awaitingAcknowledgement = finalClassifications.filter((value) => value === "awaiting_ack").length;
  const pendingRows = finalClassifications.filter((value) => value === "pending").length;
  const unresolvedClaims = finalClassifications.filter((value) => value === "unresolved_claim").length;
  const failedRows = finalClassifications.filter((value) => value === "failed").length;
  const pending = pendingRows + awaitingAcknowledgement + unresolvedClaims + missingPreparedRows;
  const failed = failedRows;
  const alreadyAcceptedCount = states.filter(({ envelope }) => {
    const task = activeTask(envelope);
    return Boolean(task && task.status !== "failed");
  }).length;
  const sceneCount = scenes.filter(({ assetKind }) => assetKind === "scene").length;
  const keyArtCount = scenes.length - sceneCount;
  logAgnesProgress("phase_summary", {
    phase: "submit",
    status: failed ? "partial_failure" : pending ? "pending" : "submitted",
    assetCount: scenes.length,
    attemptedCount: results.length,
    alreadyAcceptedCount,
    acknowledged,
    awaitingAcknowledgement,
    pending,
    failed,
  });
  return JSON.stringify({
    status: failed ? "partial_failure" : pending ? "pending" : "submitted",
    phase: "submit",
    stopRun: pending > 0 || failed > 0,
    assetCount: scenes.length,
    sceneCount,
    keyArtCount,
    attemptedCount: results.length,
    alreadyAcceptedCount,
    queued,
    inProgress,
    providerCompleted,
    acknowledged,
    awaitingAcknowledgement,
    missingPreparedRows,
    pending,
    failed,
    accountCount: runtime.accounts.length,
    batchSize: runtime.submissionBatchSizePerAccount,
    batchSizePerAccount: runtime.submissionBatchSizePerAccount,
    totalSubmissionConcurrency: runtime.totalSubmissionConcurrency,
    queuePollIntervalMs: runtime.queuePollIntervalMs,
    queuePollWindowMs: runtime.queuePollWindowMs,
    results,
    note: pending
      ? "Some required key-art/scene videos remain pending or await queue acknowledgement; end this run and retry or verify in a later invocation."
      : undefined,
  });
}

async function runVerify(runtime: WorkflowRuntime, seriesId: number, episodeNumber: number): Promise<string> {
  logAgnesPhaseStart(runtime, "verify", seriesId, episodeNumber);
  const scenes = await prepareEpisode(runtime, seriesId, episodeNumber);
  logPreparedAssets("verify", scenes);
  const states = await initializeAll(runtime, scenes, seriesId, episodeNumber);
  const pendingScenes = states.filter(({ row, envelope }) => (
    isSubmissionCandidate(row, envelope)
  )).map(({ scene }) => scene);
  if (pendingScenes.length) {
    logAgnesProgress("submission_plan", {
      phase: "verify",
      assetCount: scenes.length,
      pendingSubmissionCount: pendingScenes.length,
      alreadyDurableCount: scenes.length - pendingScenes.length,
    });
    const results = await mapConcurrent(pendingScenes, runtime.totalSubmissionConcurrency, (scene) => (
      submitOne(
        runtime,
        scene,
        seriesId,
        episodeNumber,
        runtime.accounts.length > 0 ? scene.manifestIndex % runtime.accounts.length : 0,
      )
    ));
    logAgnesProgress("phase_summary", {
      phase: "verify",
      status: "submission_attempted",
      assetCount: scenes.length,
      attemptedCount: results.length,
      pending: pendingScenes.length,
    });
    return JSON.stringify({
      status: "submission_attempted",
      phase: "verify",
      stopRun: true,
      pendingBeforeSubmission: pendingScenes.length,
      results,
      note: "Missing/pending key-art or scene videos were submitted once. End this run and verify completion on a later rerun.",
    });
  }
  const blocked = states.filter(({ row, envelope }) => (
    row.status === "failed" || (!activeTask(envelope) && row.status === "submitted")
  ));
  if (blocked.length) {
    logAgnesProgress("phase_summary", {
      phase: "verify",
      status: "blocked",
      assetCount: scenes.length,
      failed: blocked.length,
    }, "warn");
    return JSON.stringify({
      status: "blocked",
      phase: "verify",
      failed: blocked.map(({ scene, row }) => ({ sceneNumber: scene.input.sceneNumber, error: row.error })),
    });
  }
  const results = await mapConcurrent(states, runtime.totalSubmissionConcurrency, async ({ scene, row, envelope }) => {
    if (await reusableCanonicalVideo(runtime, scene, row, envelope)) {
      logAgnesProgress("verify_status_result", {
        ...assetProgressMetadata(scene),
        providerStatus: "completed",
        progress: 100,
        source: "local_video",
      });
      return {
        sceneNumber: scene.input.sceneNumber,
        status: "completed",
        progress: 100,
        downloadReady: true,
        localReady: true,
      };
    }
    const task = activeTask(envelope);
    if (!task) {
      logAgnesProgress("verify_status_error", {
        ...assetProgressMetadata(scene),
        status: "missing_receipt",
      }, "error");
      return { sceneNumber: scene.input.sceneNumber, status: "missing_receipt", downloadReady: false };
    }
    if (task.status === "failed") {
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, "failed", { error: safeError(task.error) });
      logAgnesProgress("verify_status_result", {
        ...assetProgressMetadata(scene),
        providerStatus: "failed",
        progress: task.progress,
      }, "error");
      return { sceneNumber: scene.input.sceneNumber, status: "failed", downloadReady: false };
    }
    // Completion is terminal for an accepted Agnes task. Re-querying every
    // completed receipt on each rerun wastes the provider's status allowance
    // and can make readiness appear to move backwards when those redundant
    // GETs are rate-limited. The exact accepted task and its download URL are
    // already durable; download remains a separate, validated phase.
    if (task.status === "completed" && task.metadata?.url) {
      if (row.status !== "completed" || row.error) {
        await persistState(runtime, scene, seriesId, episodeNumber, envelope, "completed", {
          error: null,
        });
      }
      logAgnesProgress("verify_status_result", {
        ...assetProgressMetadata(scene),
        accountId: accountForTask(runtime, latestAttempt(envelope), task)?.accountId,
        providerStatus: "completed",
        progress: 100,
        source: "durable_receipt",
      });
      return {
        sceneNumber: scene.input.sceneNumber,
        status: "completed",
        progress: 100,
        providerVideoId: task.video_id,
        downloadReady: true,
        reusedReceipt: true,
      };
    }
    try {
      const accountId = accountForTask(runtime, latestAttempt(envelope), task)?.accountId;
      logAgnesProgress("verify_status_start", {
        ...assetProgressMetadata(scene),
        accountId,
        previousProviderStatus: task.status,
      });
      const latest = await retrieveTaskWithOwningAccount(runtime, envelope, task);
      if (!latest) throw new Error("The Agnes status lane could not reserve a request slot.");
      latestAttempt(envelope)!.task = latest;
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, dbStatus(latest), {
        error: latest.status === "failed" ? safeError(latest.error) : null,
      });
      logAgnesProgress("verify_status_result", {
        ...assetProgressMetadata(scene),
        accountId,
        providerStatus: latest.status,
        progress: latest.progress,
      }, latest.status === "failed" ? "error" : "info");
      return {
        sceneNumber: scene.input.sceneNumber,
        status: latest.status,
        progress: latest.progress,
        providerVideoId: latest.video_id,
        downloadReady: latest.status === "completed" && Boolean(latest.metadata?.url),
      };
    } catch (error) {
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, dbStatus(task), { error: safeError(error) });
      logAgnesProgress("verify_status_error", {
        ...assetProgressMetadata(scene),
        accountId: accountForTask(runtime, latestAttempt(envelope), task)?.accountId,
        previousProviderStatus: task.status,
        error: safeProgressError(error, scene.providerPrompt),
      }, "warn");
      return { sceneNumber: scene.input.sceneNumber, status: "check_failed", downloadReady: false, error: safeError(error) };
    }
  });
  const ready = results.filter((result) => result.downloadReady).length;
  const failed = results.filter((result) => ["failed", "missing_receipt"].includes(result.status)).length;
  logAgnesProgress("phase_summary", {
    phase: "verify",
    status: failed ? "blocked" : ready === scenes.length ? "ready_to_download" : "awaiting_generation",
    assetCount: scenes.length,
    readyToDownload: ready,
    pending: scenes.length - ready - failed,
    failed,
  }, failed ? "warn" : "info");
  return JSON.stringify({
    status: failed ? "blocked" : ready === scenes.length ? "ready_to_download" : "awaiting_generation",
    phase: "verify",
    assetCount: scenes.length,
    sceneCount: scenes.filter(({ assetKind }) => assetKind === "scene").length,
    keyArtCount: scenes.filter(({ assetKind }) => assetKind !== "scene").length,
    readyToDownload: ready,
    failed,
    results,
    note: ready === scenes.length
      ? "Both key-art videos and all Agnes scenes are provider-complete. Call download_agnes_scene_videos."
      : "Rerun verification later; no accepted task was resubmitted.",
  });
}

async function runDownload(runtime: WorkflowRuntime, seriesId: number, episodeNumber: number): Promise<string> {
  logAgnesPhaseStart(runtime, "download", seriesId, episodeNumber);
  const scenes = await prepareEpisode(runtime, seriesId, episodeNumber);
  logPreparedAssets("download", scenes);
  const states = await initializeAll(runtime, scenes, seriesId, episodeNumber);
  const readiness = await Promise.all(states.map(async ({ scene, row, envelope }) => {
    if (await reusableCanonicalVideo(runtime, scene, row, envelope)) return true;
    const task = activeTask(envelope);
    return task?.status === "completed" && Boolean(task.metadata?.url);
  }));
  if (!readiness.every(Boolean)) {
    const notReady = readiness.filter((ready) => !ready).length;
    logAgnesProgress("phase_summary", {
      phase: "download",
      status: "not_ready",
      assetCount: scenes.length,
      readyToDownload: scenes.length - notReady,
      pending: notReady,
    }, "warn");
    return JSON.stringify({
      status: "not_ready",
      phase: "download",
      missingSceneNumbers: scenes
        .filter((scene, index) => !readiness[index] && scene.assetKind === "scene")
        .map((scene) => scene.input.sceneNumber),
      missingKeyArt: scenes
        .filter((scene, index) => !readiness[index] && scene.assetKind !== "scene")
        .map((scene) => scene.assetKind),
      note: "Nothing was downloaded because every required key-art and scene task must complete first. Call verify_agnes_scene_videos.",
    });
  }
  const results = await mapConcurrent(states, runtime.downloadConcurrency, async ({ scene, row, envelope }) => {
    const existingTask = activeTask(envelope);
    const accountId = existingTask
      ? accountForTask(runtime, latestAttempt(envelope), existingTask)?.accountId
      : undefined;
    logAgnesProgress("download_start", {
      ...assetProgressMetadata(scene),
      accountId,
    });
    if (await reusableCanonicalVideo(runtime, scene, row, envelope)) {
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, "completed", {
        rawOutputPath: envelope.rawPath,
        normalizedOutputPath: scene.normalizedPath,
        completedAt: new Date().toISOString(),
        downloadStatus: "downloaded",
        error: null,
      });
      logAgnesProgress("download_reused", {
        ...assetProgressMetadata(scene),
        accountId,
        source: "normalized_video",
      });
      return { sceneNumber: scene.input.sceneNumber, status: "completed", path: scene.normalizedPath, reused: true };
    }
    const task = activeTask(envelope)!;
    const downloadClient = accountForTask(runtime, latestAttempt(envelope), task)?.client
      ?? runtime.downloadClient;
    try {
      if (!(await reusableVideo(scene.rawPath, undefined, runtime.probeMediaDuration))) {
        const downloaded = await downloadClient.downloadCompletedVideo(task, scene.rawPath, {
          maxBytes: CONFIG.agnesMaxDownloadBytes,
        });
        envelope.rawPath = scene.rawPath;
        envelope.sha256 = downloaded.sha256;
        logAgnesProgress("download_raw_complete", {
          ...assetProgressMetadata(scene),
          accountId,
          source: "provider",
        });
      } else {
        envelope.rawPath = scene.rawPath;
        envelope.sha256 ??= await sha256File(scene.rawPath);
        logAgnesProgress("download_reused", {
          ...assetProgressMetadata(scene),
          accountId,
          source: "raw_video",
        });
      }
      const rawDurationSeconds = await runtime.probeMediaDuration(scene.rawPath);
      if (rawDurationSeconds + VIDEO_DURATION_TOLERANCE_SECONDS < scene.durationSeconds) {
        throw new Error(
          `Downloaded Agnes video for scene ${scene.input.sceneNumber} is ` +
          `${rawDurationSeconds.toFixed(3)}s, shorter than its ${scene.durationSeconds.toFixed(3)}s narration. ` +
          "Refusing to add frozen-frame padding; retry the provider generation.",
        );
      }
      logAgnesProgress("download_normalize_start", {
        ...assetProgressMetadata(scene),
        accountId,
        rawDurationSeconds: Number(rawDurationSeconds.toFixed(3)),
      });
      await runtime.normalizeVideo({
        inputPath: scene.rawPath,
        outputPath: scene.normalizedPath,
        durationSeconds: scene.durationSeconds,
      });
      envelope.normalizationVersion = AGNES_NORMALIZATION_VERSION;
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, "completed", {
        rawOutputPath: scene.rawPath,
        normalizedOutputPath: scene.normalizedPath,
        completedAt: new Date().toISOString(),
        downloadStatus: "downloaded",
        error: null,
      });
      logAgnesProgress("download_normalized", {
        ...assetProgressMetadata(scene),
        accountId,
        status: "completed",
      });
      return { sceneNumber: scene.input.sceneNumber, status: "completed", path: scene.normalizedPath };
    } catch (error) {
      await persistState(runtime, scene, seriesId, episodeNumber, envelope, "completed", {
        downloadStatus: "failed",
        error: safeError(error),
      });
      logAgnesProgress("download_error", {
        ...assetProgressMetadata(scene),
        accountId,
        error: safeProgressError(error, scene.providerPrompt),
      }, "error");
      return { sceneNumber: scene.input.sceneNumber, status: "pending", error: safeError(error) };
    }
  });
  const completed = results.filter((result) => result.status === "completed").length;
  logAgnesProgress("phase_summary", {
    phase: "download",
    status: completed === scenes.length ? "completed" : "pending",
    assetCount: scenes.length,
    completed,
    pending: scenes.length - completed,
  }, completed === scenes.length ? "info" : "warn");
  return JSON.stringify({
    status: completed === scenes.length ? "completed" : "pending",
    phase: "download",
    assetCount: scenes.length,
    sceneCount: scenes.filter(({ assetKind }) => assetKind === "scene").length,
    keyArtCount: scenes.filter(({ assetKind }) => assetKind !== "scene").length,
    completed,
    pending: scenes.length - completed,
    results,
  });
}

const toolSchema = z.object({
  seriesId: z.number().int().positive(),
  episodeNumber: z.number().int().positive(),
});

type AgnesWorkflowPhase = "submit" | "verify" | "download";

async function runWithScriptPreflightResult(
  runtime: WorkflowRuntime,
  phase: AgnesWorkflowPhase,
  seriesId: number,
  episodeNumber: number,
  operation: () => Promise<string>,
): Promise<string> {
  try {
    return await operation();
  } catch (error) {
    logAgnesProgress("phase_error", {
      phase,
      seriesId,
      episodeNumber,
      errorKind: error instanceof AgnesError ? error.kind : error instanceof Error ? error.name : "unknown",
      error: safeProgressError(error),
    }, "error");
    if (error instanceof EpisodeAudioMutationInProgressError) {
      return JSON.stringify({
        status: "audio_mutation_deferred",
        phase,
        stopRun: true,
        seriesId,
        episodeNumber,
        audioValidation: {
          status: "mutation_deferred",
          reason: "mutation_in_progress",
          sceneNumber: error.sceneNumber,
          leaseExpiresAtMs: error.leaseExpiresAtMs,
        },
        startedAssetCount: 0,
        note: "Another audio writer owns the episode lease. End this run and retry from persisted state.",
      });
    }
    if (error instanceof AgnesKeyArtAudioMutationDeferredError) {
      const locked = error.reason === "agnes_started"
        || error.reason === "mutation_disabled"
        || error.reason === "episode_complete";
      return JSON.stringify({
        status: locked ? "audio_repair_blocked" : "audio_mutation_deferred",
        phase,
        stopRun: true,
        seriesId,
        episodeNumber,
        audioValidation: {
          status: locked ? "repair_blocked" : "mutation_deferred",
          reason: error.reason,
          assetKind: "key_art",
        },
        startedAssetCount: error.startedAssetCount,
        note: locked
          ? "Key-art title audio is immutable after an Agnes claim or episode completion. Stop without regenerating it."
          : "Another audio writer owns or fenced the episode lease. End this run and retry from persisted state.",
      });
    }
    if (error instanceof EpisodeAudioReadinessError) {
      const agnesRows = await runtime.seriesState.listAgnesSceneGenerations(
        seriesId,
        episodeNumber,
      );
      const startedAssetCount = agnesRows.filter(hasStartedAgnesSubmission).length;
      const locked = startedAssetCount > 0;
      return JSON.stringify({
        status: locked ? "audio_repair_blocked" : "audio_repair_required",
        phase,
        stopRun: locked,
        seriesId,
        episodeNumber,
        audioValidation: {
          status: locked ? "repair_blocked" : "repair_required",
          reason: error.reason,
          ...(error.sceneNumber === undefined ? {} : { sceneNumber: error.sceneNumber }),
          ...(error.assetKind === undefined ? {} : { assetKind: error.assetKind }),
          ...(error.durationSeconds === undefined
            ? {}
            : { durationSeconds: error.durationSeconds }),
          ...(error.totalDurationSeconds === undefined
            ? {}
            : { totalDurationSeconds: error.totalDurationSeconds }),
        },
        startedAssetCount,
        note: locked
          ? "Audio drift was detected after an Agnes claim. Stop without regenerating audio or submitting more work."
          : "Return to the exact-text audio step, regenerate/reuse every scene WAV, and submit complete timing evidence before retrying Agnes.",
      });
    }
    if (!(error instanceof ProductionScriptContractError)) throw error;

    const agnesRows = await runtime.seriesState.listAgnesSceneGenerations(
      seriesId,
      episodeNumber,
    );
    const scriptValidation = productionScriptReadiness(error.inspection, agnesRows);
    return JSON.stringify({
      status: scriptValidation.status,
      phase,
      stopRun: scriptValidation.status === "repair_blocked",
      seriesId,
      episodeNumber,
      scriptValidation,
      note: scriptValidation.nextAction,
    });
  }
}

function submitTool(runtime: WorkflowRuntime): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "submit_agnes_scene_videos",
    description:
      "Before the first durable provider claim, verifies that the complete stored 1-5 character roster has public Supabase portraits; after claims begin, preserves frozen references and fails closed if one is missing. The series key-art title card uses every canonical roster portrait, while episode key art uses one story-relevant protagonist. Then submits both key-art videos plus one image-reference Agnes job per <=12-second narration scene, with at most two workers per configured account. " +
      "Only definite account rate/quota/credit limits fail over; all intents/receipts are durable, and queue-full or ambiguous failures stay pending until another invocation. " +
      "An invalid persisted script returns repair_required before any provider call, or repair_blocked when durable submission evidence already exists. " +
      "Typed local narration drift returns audio_repair_required before any provider call.",
    schema: toolSchema,
    func: ({ seriesId, episodeNumber }) => runWithScriptPreflightResult(
      runtime,
      "submit",
      seriesId,
      episodeNumber,
      () => runSubmit(runtime, seriesId, episodeNumber),
    ),
  });
}

function verifyTool(runtime: WorkflowRuntime): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "verify_agnes_scene_videos",
    description:
      "Resubmits only safe pending Agnes key-art/scene videos and then ends that run, or refreshes each accepted receipt with its exact submitting account and reports when all required videos are provider-complete.",
    schema: toolSchema,
    func: ({ seriesId, episodeNumber }) => runWithScriptPreflightResult(
      runtime,
      "verify",
      seriesId,
      episodeNumber,
      () => runVerify(runtime, seriesId, episodeNumber),
    ),
  });
}

function downloadTool(runtime: WorkflowRuntime): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "download_agnes_scene_videos",
    description:
      "Downloads only after both key-art videos and all Agnes scenes are provider-complete, removes provider audio, and exact-normalizes each video to its matching Groq audio duration.",
    schema: toolSchema,
    func: ({ seriesId, episodeNumber }) => runWithScriptPreflightResult(
      runtime,
      "download",
      seriesId,
      episodeNumber,
      () => runDownload(runtime, seriesId, episodeNumber),
    ),
  });
}

export function buildAgnesSceneVideoTools(
  seriesState: SeriesState,
  options: AgnesSceneVideoToolOptions = {},
): DynamicStructuredTool[] {
  const runtime = createRuntime(seriesState, options);
  return [submitTool(runtime), verifyTool(runtime), downloadTool(runtime)];
}

export function buildSubmitAgnesSceneVideosTool(
  seriesState: SeriesState,
  options: AgnesSceneVideoToolOptions = {},
): DynamicStructuredTool {
  return submitTool(createRuntime(seriesState, options));
}

export function buildVerifyAgnesSceneVideosTool(
  seriesState: SeriesState,
  options: AgnesSceneVideoToolOptions = {},
): DynamicStructuredTool {
  return verifyTool(createRuntime(seriesState, options));
}

export function buildDownloadAgnesSceneVideosTool(
  seriesState: SeriesState,
  options: AgnesSceneVideoToolOptions = {},
): DynamicStructuredTool {
  return downloadTool(createRuntime(seriesState, options));
}

/** Compatibility shim for the standalone evaluator; production registers the explicit tools above. */
export function buildAgnesSceneVideoTool(
  seriesState: SeriesState,
  options: AgnesSceneVideoToolOptions = {},
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_agnes_scene_videos",
    description: "Compatibility wrapper that performs only the durable Agnes submission phase.",
    schema: toolSchema,
    func: ({ seriesId, episodeNumber }) => {
      const runtime = createRuntime(seriesState, options);
      return runWithScriptPreflightResult(
        runtime,
        "submit",
        seriesId,
        episodeNumber,
        () => runSubmit(runtime, seriesId, episodeNumber),
      );
    },
  });
}
