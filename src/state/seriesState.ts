import { createClient, type Client } from "@libsql/client";
import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "../config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
} from "../services/narrationContract.js";
import { inspectProductionScript } from "../services/productionScriptContract.js";
import { canonicalizeKeyArtTitle } from "../services/keyArtTitleContract.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
} from "../services/agnesKeyArtService.js";
import {
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  readNarrationAudioMetadata,
} from "../tools/ttsTool.js";
import { DOMAIN_SCHEMA_STATEMENTS } from "./schemaStatements.js";

export interface CharacterDef {
  name: string;
  description: string;
}

export interface EnvironmentDef {
  name: string;
  description: string;
}

export const MAX_AGNES_SERIES_SEED = 0x7fffffff;

export interface AgnesAccountRateStateRow {
  accountId: string;
  lane: string;
  nextSlotAtMs: number;
  blockedUntilMs: number;
  blockReason: string | null;
  updatedAtMs: number;
}

export interface AgnesAccountRateSlotReservation extends AgnesAccountRateStateRow {
  /** The exact epoch-millisecond slot reserved for this outbound request. */
  scheduledAtMs: number;
}

export interface ReserveAgnesAccountRateSlotInput {
  accountId: string;
  lane: string;
  intervalMs: number;
  /** Injectable wall-clock time for deterministic scheduling/tests. */
  nowMs?: number;
}

export interface BlockAgnesAccountRateLaneInput {
  accountId: string;
  lane: string;
  blockedUntilMs: number;
  blockReason?: string | null;
  /** Injectable wall-clock time for deterministic scheduling/tests. */
  nowMs?: number;
}

export interface EpisodeRow {
  id: number;
  seriesId: number;
  episodeNumber: number;
  title: string;
  premise: string;
  status: "pending" | "script" | "images" | "audio" | "assembly" | "done" | "failed";
  scriptJson: unknown;
  outputPath: string | null;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  uploadedAt: string | null;
  /** YouTube-confirmed terminal timestamp; never set by intermediate stages. */
  completedAt: string | null;
  /** Calendar date of completedAt in the configured episode timezone. */
  completionLocalDate: string | null;
}

export type NextEpisodeAvailability =
  | {
      kind: "ready";
      episode: EpisodeRow;
      timeZone: string;
      localDate: string;
    }
  | {
      kind: "daily_limit";
      episode: null;
      timeZone: string;
      localDate: string;
      completedEpisodeNumber: number;
      completedAt: string;
      message: string;
    }
  | {
      kind: "series_complete" | "no_episodes" | "series_missing";
      episode: null;
      timeZone: string;
      localDate: string;
      message: string;
    };

export interface YoutubeUploadReceiptRow {
  seriesId: number;
  episodeNumber: number;
  videoId: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export const SERIES_EPISODE_COUNT = 25;
export const ONE_EPISODE_PER_DAY_MESSAGE = "Only 1 episode per day can be generated.";

export interface EpisodeDailyGateOptions {
  /** Injectable instant for deterministic tests; production defaults to now. */
  now?: Date;
  /** Injectable IANA timezone; production defaults to EPISODE_DAILY_TIMEZONE. */
  timeZone?: string;
}

export interface SeasonEpisodeInput {
  episodeNumber: number;
  title: string;
  premise: string;
}

function validateSeasonEpisodeList(
  episodes: SeasonEpisodeInput[],
  context = "Season episode list",
): SeasonEpisodeInput[] {
  if (!Array.isArray(episodes) || episodes.length !== SERIES_EPISODE_COUNT) {
    throw new Error(
      `${context} must contain exactly ${SERIES_EPISODE_COUNT} episodes; received ` +
      `${Array.isArray(episodes) ? episodes.length : "a non-array value"}.`,
    );
  }

  return episodes.map((episode, index) => {
    const expectedEpisodeNumber = index + 1;
    if (!episode || typeof episode !== "object") {
      throw new Error(`${context} episode ${expectedEpisodeNumber} must be an object.`);
    }
    if (!Number.isInteger(episode.episodeNumber) || episode.episodeNumber !== expectedEpisodeNumber) {
      throw new Error(
        `${context} must use unique sequential episode numbers 1-${SERIES_EPISODE_COUNT}; ` +
        `entry ${expectedEpisodeNumber} has episodeNumber ${String(episode.episodeNumber)}.`,
      );
    }

    const title = typeof episode.title === "string"
      ? canonicalizeKeyArtTitle(episode.title, "episode")
      : "";
    const premise = typeof episode.premise === "string" ? episode.premise.trim() : "";
    if (!title) {
      throw new Error(`${context} episode ${expectedEpisodeNumber} must have a non-empty title.`);
    }
    if (!premise) {
      throw new Error(`${context} episode ${expectedEpisodeNumber} must have a non-empty premise.`);
    }
    return { episodeNumber: expectedEpisodeNumber, title, premise };
  });
}

export interface ReferenceImage {
  path: string;
}

export interface KeyArtRow {
  id: number;
  seriesId: number;
  artType: "series" | "episode";
  episodeNumber: number | null;
  candidatePaths: Record<string, string>;
  selectedPath: string | null;
  rationale: string | null;
  approvedAt: string | null;
}

export interface CharacterSheetRow {
  id: number;
  seriesId: number;
  characterName: string;
  description: string;
  referenceImagePaths: Record<string, ReferenceImage>;
  generationPrompt: string | null;
  approvedAt: string | null;
}

export type AgnesSceneVariant = "text" | "reference";
/** Backward-compatible descriptive alias used by the Agnes generation tool. */
export type AgnesSceneVideoVariant = AgnesSceneVariant;

export type AgnesSceneGenerationStatus =
  | "pending"
  | "submitted"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed";

export type AgnesSceneDownloadStatus = "pending" | "downloaded" | "failed";

export interface AgnesSceneGenerationRow {
  id: number;
  seriesId: number;
  episodeNumber: number;
  /** Positive for script scenes; -2/-1 are reserved for series/episode key-art videos. */
  sceneNumber: number;
  variant: AgnesSceneVariant;
  status: AgnesSceneGenerationStatus;
  prompt: string;
  requestDigest: string | null;
  attemptCount: number;
  seed: number | null;
  requestedDurationSeconds: number;
  /** One integer Agnes request duration from 4-12s. */
  providerDurationSeconds: number;
  publicReferenceUrl: string | null;
  providerTaskId: string | null;
  providerReceipt: unknown | null;
  providerVideoUrl: string | null;
  rawOutputPath: string | null;
  normalizedOutputPath: string | null;
  downloadStatus: AgnesSceneDownloadStatus;
  error: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgnesSceneGenerationInput {
  seriesId: number;
  episodeNumber: number;
  sceneNumber: number;
  variant: AgnesSceneVariant;
  status: AgnesSceneGenerationStatus;
  prompt: string;
  requestDigest?: string | null;
  attemptCount?: number;
  seed?: number | null;
  requestedDurationSeconds: number;
  /** One integer Agnes request duration from 4-12s. */
  providerDurationSeconds: number;
  publicReferenceUrl?: string | null;
  providerTaskId?: string | null;
  providerReceipt?: unknown | null;
  providerVideoUrl?: string | null;
  rawOutputPath?: string | null;
  normalizedOutputPath?: string | null;
  downloadStatus?: AgnesSceneDownloadStatus;
  error?: string | null;
  submittedAt?: string | null;
  completedAt?: string | null;
}

export interface ClaimAgnesSceneSubmissionInput extends Omit<
  UpsertAgnesSceneGenerationInput,
  "status" | "attemptCount"
> {
  requestDigest: string;
  /** Versioned receipt envelope containing the unique pre-POST claim intent. */
  providerReceipt: unknown;
}

export interface ResetAgnesSceneGenerationForRequestInput {
  seriesId: number;
  episodeNumber: number;
  sceneNumber: number;
  variant: AgnesSceneVariant;
  prompt: string;
  requestDigest: string;
  seed?: number | null;
  requestedDurationSeconds: number;
  providerDurationSeconds: number;
  publicReferenceUrl?: string | null;
}

export type EpisodeVideoVariant = "static" | "agnes_text" | "agnes_reference";
export type EpisodeVideoOutputStatus = "pending" | "completed" | "failed";

export interface EpisodeVideoOutputRow {
  id: number;
  seriesId: number;
  episodeNumber: number;
  variant: EpisodeVideoVariant;
  status: EpisodeVideoOutputStatus;
  outputPath: string | null;
  durationSeconds: number | null;
  error: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertEpisodeVideoOutputInput {
  seriesId: number;
  episodeNumber: number;
  variant: EpisodeVideoVariant;
  /** Defaults to completed when outputPath is supplied, otherwise pending. */
  status?: EpisodeVideoOutputStatus;
  outputPath?: string | null;
  durationSeconds?: number | null;
  error?: string | null;
  completedAt?: string | null;
}

/** Safely parses a JSON TEXT column, returning the fallback on failure. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  if (value && typeof value === "object") return value as T;
  return fallback;
}

function parseTopLevelJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * SQLite datetime('now') values omit a timezone suffix but are UTC. Normalize
 * both that representation and regular ISO-8601 timestamps to a real instant.
 */
function parseDatabaseTimestamp(value: unknown, label: string): Date {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const timestamp = new Date(normalized);
  if (!raw || Number.isNaN(timestamp.getTime())) {
    throw new Error(`${label} is not a valid UTC/ISO timestamp: ${String(value)}`);
  }
  return timestamp;
}

function localCalendarDate(instant: Date, timeZone: string): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("The episode daily-gate instant must be a valid Date.");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
  } catch (error) {
    throw new Error(
      `EPISODE_DAILY_TIMEZONE must be a valid IANA timezone; received ${JSON.stringify(timeZone)}.`,
      { cause: error },
    );
  }
  const read = (type: "year" | "month" | "day"): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Could not resolve ${type} in timezone ${timeZone}.`);
    return value;
  };
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function episodeDailyGateContext(options: EpisodeDailyGateOptions = {}): {
  now: Date;
  timeZone: string;
  localDate: string;
} {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone?.trim() || CONFIG.episodeDailyTimezone;
  return { now, timeZone, localDate: localCalendarDate(now, timeZone) };
}

function mapEpisodeRow(row: Record<string, unknown>): EpisodeRow {
  return {
    id: Number(row.id),
    seriesId: Number(row.series_id),
    episodeNumber: Number(row.episode_number),
    title: String(row.title),
    premise: String(row.premise),
    status: row.status as EpisodeRow["status"],
    scriptJson: parseJson(row.script_json, null),
    outputPath: (row.output_path as string | null) ?? null,
    youtubeVideoId: (row.youtube_video_id as string | null) ?? null,
    youtubeUrl: (row.youtube_url as string | null) ?? null,
    uploadedAt: (row.uploaded_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    completionLocalDate: (row.completion_local_date as string | null) ?? null,
  };
}

/**
 * Produces a deterministic JSON representation so harmless object-key order
 * changes do not invalidate already-generated episode artifacts.
 */
function canonicalJsonString(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  const serialized = JSON.stringify(normalize(parseTopLevelJson(value)));
  if (serialized === undefined) {
    throw new Error("Episode script must be JSON-serializable.");
  }
  return serialized;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function schedulerKey(label: "accountId" | "lane", value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Agnes scheduler ${label} must not be empty.`);
  return normalized;
}

function nonNegativeSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function mapAgnesAccountRateStateRow(
  row: Record<string, unknown>,
): AgnesAccountRateStateRow {
  const mapped = {
    accountId: String(row.account_id),
    lane: String(row.lane),
    nextSlotAtMs: Number(row.next_slot_at_ms),
    blockedUntilMs: Number(row.blocked_until_ms),
    blockReason: (row.block_reason as string | null) ?? null,
    updatedAtMs: Number(row.updated_at_ms),
  };
  nonNegativeSafeInteger("Persisted Agnes next_slot_at_ms", mapped.nextSlotAtMs);
  nonNegativeSafeInteger("Persisted Agnes blocked_until_ms", mapped.blockedUntilMs);
  nonNegativeSafeInteger("Persisted Agnes updated_at_ms", mapped.updatedAtMs);
  return mapped;
}

function mapAgnesSceneGenerationRow(row: Record<string, unknown>): AgnesSceneGenerationRow {
  return {
    id: Number(row.id),
    seriesId: Number(row.series_id),
    episodeNumber: Number(row.episode_number),
    sceneNumber: Number(row.scene_number),
    variant: row.variant as AgnesSceneVariant,
    status: row.status as AgnesSceneGenerationStatus,
    prompt: String(row.prompt),
    requestDigest: (row.request_digest as string | null) ?? null,
    attemptCount: Number(row.attempt_count ?? 0),
    seed: nullableNumber(row.seed),
    requestedDurationSeconds: Number(row.requested_duration_seconds),
    providerDurationSeconds: Number(row.provider_duration_seconds),
    publicReferenceUrl: (row.public_reference_url as string | null) ?? null,
    providerTaskId: (row.provider_task_id as string | null) ?? null,
    providerReceipt: parseJson<unknown | null>(row.provider_receipt_json, null),
    providerVideoUrl: (row.provider_video_url as string | null) ?? null,
    rawOutputPath: (row.raw_output_path as string | null) ?? null,
    normalizedOutputPath: (row.normalized_output_path as string | null) ?? null,
    downloadStatus: (row.download_status as AgnesSceneDownloadStatus | null) ?? "pending",
    error: (row.error as string | null) ?? null,
    submittedAt: (row.submitted_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEpisodeVideoOutputRow(row: Record<string, unknown>): EpisodeVideoOutputRow {
  return {
    id: Number(row.id),
    seriesId: Number(row.series_id),
    episodeNumber: Number(row.episode_number),
    variant: row.variant as EpisodeVideoVariant,
    status: row.status as EpisodeVideoOutputStatus,
    outputPath: (row.output_path as string | null) ?? null,
    durationSeconds: nullableNumber(row.duration_seconds),
    error: (row.error as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Scene clips are encoded at 30 fps, so allow one frame plus a small container
// timestamp margin. This must stay strict enough to reject hidden padding.
const SCENE_DURATION_TOLERANCE_SECONDS = (1 / 30) + 0.005;
// Final containers can accumulate small AAC/MP4 mux timestamp differences.
const COMPLETION_DURATION_TOLERANCE_SECONDS = 0.15;
function requiredAgnesSceneVariants(): readonly AgnesSceneVariant[] {
  return ["text"];
}

function requiredEpisodeVideoVariants(): readonly EpisodeVideoVariant[] {
  return ["agnes_text"];
}

function episodeScriptSceneNumbers(scriptJson: unknown): number[] {
  const parsedRoot = typeof scriptJson === "string"
    ? parseJson<unknown>(scriptJson, null)
    : scriptJson;
  if (!parsedRoot || typeof parsedRoot !== "object" || Array.isArray(parsedRoot)) {
    throw new Error("Cannot mark episode done: script_json is missing or invalid.");
  }
  const scenesValue = (parsedRoot as Record<string, unknown>).scenes;
  const scenes = typeof scenesValue === "string"
    ? parseJson<unknown>(scenesValue, null)
    : scenesValue;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Cannot mark episode done: script_json contains no scenes.");
  }

  const numbers = scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new Error(`Cannot mark episode done: script scene ${index + 1} is invalid.`);
    }
    const sceneNumber = Number((scene as Record<string, unknown>).sceneNumber ?? index + 1);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) {
      throw new Error(`Cannot mark episode done: script scene ${index + 1} has an invalid sceneNumber.`);
    }
    return sceneNumber;
  });
  if (new Set(numbers).size !== numbers.length) {
    throw new Error("Cannot mark episode done: script scene numbers are duplicated.");
  }
  return numbers;
}

function episodeScriptNarrationMap(scriptJson: unknown): Map<number, string> {
  const parsedRoot = typeof scriptJson === "string"
    ? parseJson<unknown>(scriptJson, null)
    : scriptJson;
  if (!parsedRoot || typeof parsedRoot !== "object" || Array.isArray(parsedRoot)) return new Map();
  const scenesValue = (parsedRoot as Record<string, unknown>).scenes;
  const scenes = typeof scenesValue === "string"
    ? parseJson<unknown>(scenesValue, null)
    : scenesValue;
  if (!Array.isArray(scenes)) return new Map();
  return new Map(scenes.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const scene = entry as Record<string, unknown>;
    const sceneNumber = Number(scene.sceneNumber ?? index + 1);
    const narrationText = typeof scene.narrationText === "string" ? scene.narrationText.trim() : "";
    return Number.isSafeInteger(sceneNumber) && narrationText ? [[sceneNumber, narrationText] as const] : [];
  }));
}

async function requireMatchingNarrationMetadata(
  audioPath: string,
  narrationText: string,
  measuredDurationSeconds: number,
  label: string,
): Promise<void> {
  const metadataPath = narrationAudioMetadataPath(audioPath);
  const metadata = await readNarrationAudioMetadata(metadataPath);
  const expectedDigest = createNarrationAudioRequestDigest({
    text: narrationText,
    model: CONFIG.groqTtsModel,
    voice: CONFIG.groqTtsVoice,
  });
  if (!metadata || metadata.requestDigest !== expectedDigest) {
    throw new Error(
      `Cannot continue: ${label} metadata is missing or does not match the persisted script. ` +
      "Regenerate that scene's Groq narration audio.",
    );
  }
  if (
    metadata.durationStatus !== "ready" ||
    Math.abs(metadata.durationSeconds - measuredDurationSeconds) > 0.05
  ) {
    throw new Error(
      `Cannot continue: ${label} metadata is stale or marks the narration over 12 seconds.`,
    );
  }
}

async function requireNonEmptyFile(filePath: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    throw new Error(`Cannot mark episode done: ${label} is missing: ${filePath}`);
  }
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`Cannot mark episode done: ${label} is empty or not a file: ${filePath}`);
  }
}

function probeMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(CONFIG.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    process.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    process.on("error", reject);
    process.on("close", (code) => {
      const duration = Number(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) {
        resolve(duration);
      } else {
        reject(new Error(
          `Cannot mark episode done: media duration is invalid for ${filePath}` +
          (stderr.trim() ? ` (${stderr.trim().slice(-300)})` : "")
        ));
      }
    });
  });
}

function pathIsInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/**
 * Data-access layer for the kids-video-agent series/episode/character-sheet
 * tables, stored in Turso (libSQL). Kept separate from the deep-agent
 * framework's own StateStore (single-writer discipline: only the main
 * agent's tools call these methods, never a sub-agent directly).
 */
export class SeriesState {
  private client: Client;
  private schemaReady: Promise<void> | null = null;

  constructor(url?: string, authToken?: string) {
    this.client = createClient({
      url: url ?? CONFIG.tursoDatabaseUrl(),
      authToken: authToken ?? CONFIG.tursoAuthToken(),
    });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  /**
   * Creates every domain table before the agent can query Turso. The promise
   * is cached so concurrent startup/first-use calls share one atomic bootstrap.
   *
   * A rejected bootstrap is deliberately not cached so a transient database
   * failure can be retried by the next operation.
   */
  async initialize(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createDomainSchema().catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    await this.schemaReady;
  }

  private async createDomainSchema(): Promise<void> {
    // One ordered write transaction prevents a partially-created schema from
    // becoming visible if a fresh-database bootstrap fails midway through.
    await this.client.batch([...DOMAIN_SCHEMA_STATEMENTS], "write");

    // CREATE TABLE IF NOT EXISTS does not add fields to an older table. Apply
    // the supported additive migrations before any method selects those fields.
    const ensureColumn = async (
      tableName: "series" | "episodes" | "character_sheets" | "agnes_scene_generations",
      columnName: string,
      definition: string,
    ): Promise<void> => {
      const columns = await this.client.execute(`PRAGMA table_info('${tableName}')`);
      if (columns.rows.some((row) => String(row.name) === columnName)) return;
      try {
        await this.client.execute(
          `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
        );
      } catch (error) {
        // SQLite has no portable ADD COLUMN IF NOT EXISTS. Another process may
        // have won the migration race between PRAGMA and ALTER; only suppress
        // the error after proving the desired column now exists.
        const refreshed = await this.client.execute(`PRAGMA table_info('${tableName}')`);
        if (!refreshed.rows.some((row) => String(row.name) === columnName)) throw error;
      }
    };

    await ensureColumn("series", "environments_json", "TEXT NOT NULL DEFAULT '[]'");
    await ensureColumn("series", "episode_formula", "TEXT");
    await ensureColumn(
      "series",
      "agnes_seed",
      "INTEGER CHECK (agnes_seed BETWEEN 0 AND 2147483647)",
    );

    await ensureColumn("episodes", "title", "TEXT NOT NULL DEFAULT ''");
    await ensureColumn("episodes", "premise", "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(
      "episodes",
      "status",
      "TEXT NOT NULL DEFAULT 'pending' " +
        "CHECK (status IN ('pending', 'script', 'images', 'audio', 'assembly', 'done', 'failed'))",
    );
    await ensureColumn("episodes", "script_json", "TEXT");
    await ensureColumn("episodes", "output_path", "TEXT");
    await ensureColumn("episodes", "youtube_video_id", "TEXT");
    await ensureColumn("episodes", "youtube_url", "TEXT");
    await ensureColumn("episodes", "uploaded_at", "TEXT");
    await ensureColumn("episodes", "completed_at", "TEXT");
    await ensureColumn("episodes", "completion_local_date", "TEXT");
    await ensureColumn("episodes", "updated_at", "TEXT");

    await ensureColumn("character_sheets", "generation_prompt", "TEXT");
    await ensureColumn("character_sheets", "approved_at", "TEXT");

    await ensureColumn("agnes_scene_generations", "request_digest", "TEXT");
    await ensureColumn("agnes_scene_generations", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn(
      "agnes_scene_generations",
      "download_status",
      "TEXT NOT NULL DEFAULT 'pending' CHECK (download_status IN ('pending', 'downloaded', 'failed'))"
    );
    await this.client.execute(
      "UPDATE agnes_scene_generations SET download_status = 'downloaded' " +
      "WHERE normalized_output_path IS NOT NULL AND download_status = 'pending'"
    );

    // Builds predating durable YouTube receipts sometimes marked an episode
    // done without enough identity to prove that it was published. Put those
    // rows back into the resumable queue instead of silently skipping them.
    await this.client.execute(
      `UPDATE episodes
       SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'done'
         AND (
           uploaded_at IS NULL OR trim(uploaded_at) = '' OR
           youtube_video_id IS NULL OR trim(youtube_video_id) = '' OR
           youtube_url IS NULL OR trim(youtube_url) = ''
         )`,
    );

    // For valid legacy terminal rows, uploaded_at is the only durable evidence
    // of when YouTube succeeded. Preserve that instant as completed_at rather
    // than assigning migration time, which could move an upload across days.
    await this.client.execute(
      `UPDATE episodes
       SET completed_at = uploaded_at
       WHERE status = 'done'
         AND uploaded_at IS NOT NULL AND trim(uploaded_at) <> ''
         AND youtube_video_id IS NOT NULL AND trim(youtube_video_id) <> ''
         AND youtube_url IS NOT NULL AND trim(youtube_url) <> ''
         AND (completed_at IS NULL OR trim(completed_at) = '')`,
    );
  }

  async getOrCreateSeries(
    conceptName: string,
    characters: CharacterDef[],
    environments: EnvironmentDef[],
    episodeFormula: string
  ): Promise<number> {
    await this.initialize();
    const canonicalConceptName = canonicalizeKeyArtTitle(conceptName, "series");
    // Older builds could persist surrounding whitespace. Resolve one such row
    // before inserting the canonical value so upgrading cannot fork the series.
    // Multiple trim-equivalent legacy rows are ambiguous and must be repaired
    // explicitly rather than silently choosing the wrong episode lineage.
    const matching = await this.client.execute({
      sql: "SELECT id FROM series WHERE trim(concept_name) = ? ORDER BY id ASC",
      args: [canonicalConceptName],
    });
    if (matching.rows.length > 1) {
      throw new Error(
        `Multiple stored series normalize to ${JSON.stringify(canonicalConceptName)}; ` +
        "merge the duplicate legacy rows before continuing.",
      );
    }
    if (matching.rows[0]) return Number(matching.rows[0].id);
    const inserted = await this.client.execute({
      sql: `INSERT INTO series (concept_name, characters_json, environments_json, episode_formula)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (concept_name)
            DO UPDATE SET concept_name = excluded.concept_name
            RETURNING id`,
      args: [canonicalConceptName, JSON.stringify(characters), JSON.stringify(environments), episodeFormula],
    });
    return inserted.rows[0].id as number;
  }

  /**
   * Returns the series-wide deterministic Agnes seed, atomically persisting a
   * caller-provided candidate (or a cryptographically random candidate) only
   * when the series has no seed yet. Concurrent callers always converge on the
   * first value committed by Turso.
   */
  async getOrCreateSeriesAgnesSeed(
    seriesId: number,
    preferredCandidate?: number,
  ): Promise<number> {
    await this.initialize();
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
      throw new Error("seriesId must be a positive integer.");
    }
    if (preferredCandidate !== undefined && (
      !Number.isSafeInteger(preferredCandidate)
      || preferredCandidate < 0
      || preferredCandidate > MAX_AGNES_SERIES_SEED
    )) {
      throw new Error(
        `Agnes series seed must be an integer from 0 through ${MAX_AGNES_SERIES_SEED}.`,
      );
    }
    const candidate = preferredCandidate
      ?? randomInt(0, MAX_AGNES_SERIES_SEED + 1);
    const result = await this.client.execute({
      sql: `UPDATE series
            SET agnes_seed = COALESCE(agnes_seed, ?)
            WHERE id = ?
            RETURNING agnes_seed`,
      args: [candidate, seriesId],
    });
    const row = result.rows[0];
    if (!row) throw new Error(`Series ${seriesId} was not found.`);
    const stored = Number(row.agnes_seed);
    if (!Number.isSafeInteger(stored) || stored < 0 || stored > MAX_AGNES_SERIES_SEED) {
      throw new Error(`Series ${seriesId} contains an invalid Agnes seed.`);
    }
    return stored;
  }

  /** Read one durable account/lane scheduler row, if it has been initialized. */
  async getAgnesAccountRateState(
    accountId: string,
    lane: string,
  ): Promise<AgnesAccountRateStateRow | null> {
    await this.initialize();
    const normalizedAccountId = schedulerKey("accountId", accountId);
    const normalizedLane = schedulerKey("lane", lane);
    const result = await this.client.execute({
      sql: `SELECT account_id, lane, next_slot_at_ms, blocked_until_ms,
                   block_reason, updated_at_ms
            FROM agnes_account_rate_state
            WHERE account_id = ? AND lane = ?`,
      args: [normalizedAccountId, normalizedLane],
    });
    const row = result.rows[0];
    return row
      ? mapAgnesAccountRateStateRow(row as unknown as Record<string, unknown>)
      : null;
  }

  /**
   * Atomically reserves one future request start. The returned slot is the
   * maximum of the caller's clock, the prior reservation cursor, and the
   * account cooldown; the durable cursor advances by exactly intervalMs.
   */
  async reserveAgnesAccountRateSlot(
    input: ReserveAgnesAccountRateSlotInput,
  ): Promise<AgnesAccountRateSlotReservation> {
    await this.initialize();
    const accountId = schedulerKey("accountId", input.accountId);
    const lane = schedulerKey("lane", input.lane);
    const intervalMs = nonNegativeSafeInteger("Agnes scheduler intervalMs", input.intervalMs);
    const nowMs = nonNegativeSafeInteger("Agnes scheduler nowMs", input.nowMs ?? Date.now());
    if (nowMs + intervalMs > Number.MAX_SAFE_INTEGER) {
      throw new Error("Agnes scheduler reservation exceeds the safe integer range.");
    }

    const result = await this.client.execute({
      sql: `INSERT INTO agnes_account_rate_state (
              account_id, lane, next_slot_at_ms, blocked_until_ms, block_reason, updated_at_ms
            ) VALUES (?, ?, ? + ?, 0, NULL, ?)
            ON CONFLICT (account_id, lane)
            DO UPDATE SET
              next_slot_at_ms = MAX(
                ?,
                agnes_account_rate_state.next_slot_at_ms,
                agnes_account_rate_state.blocked_until_ms
              ) + ?,
              block_reason = CASE
                WHEN agnes_account_rate_state.blocked_until_ms <= ? THEN NULL
                ELSE agnes_account_rate_state.block_reason
              END,
              updated_at_ms = MAX(agnes_account_rate_state.updated_at_ms, ?)
            RETURNING account_id, lane, next_slot_at_ms, blocked_until_ms,
                      block_reason, updated_at_ms,
                      next_slot_at_ms - ? AS scheduled_at_ms`,
      args: [
        accountId,
        lane,
        nowMs,
        intervalMs,
        nowMs,
        nowMs,
        intervalMs,
        nowMs,
        nowMs,
        intervalMs,
      ],
    });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error("Agnes scheduler reservation was not persisted.");
    const state = mapAgnesAccountRateStateRow(row);
    const scheduledAtMs = nonNegativeSafeInteger(
      "Persisted Agnes scheduled_at_ms",
      Number(row.scheduled_at_ms),
    );
    return { ...state, scheduledAtMs };
  }

  /**
   * Extends an account/lane cooldown without allowing a stale writer to
   * shorten an existing block. The reason associated with the longest block
   * wins and remains available to later invocations for diagnostics.
   */
  async blockAgnesAccountRateLane(
    input: BlockAgnesAccountRateLaneInput,
  ): Promise<AgnesAccountRateStateRow> {
    await this.initialize();
    const accountId = schedulerKey("accountId", input.accountId);
    const lane = schedulerKey("lane", input.lane);
    const blockedUntilMs = nonNegativeSafeInteger(
      "Agnes scheduler blockedUntilMs",
      input.blockedUntilMs,
    );
    const nowMs = nonNegativeSafeInteger("Agnes scheduler nowMs", input.nowMs ?? Date.now());
    const blockReason = input.blockReason?.trim() || null;
    const result = await this.client.execute({
      sql: `INSERT INTO agnes_account_rate_state (
              account_id, lane, next_slot_at_ms, blocked_until_ms, block_reason, updated_at_ms
            ) VALUES (?, ?, 0, ?, ?, ?)
            ON CONFLICT (account_id, lane)
            DO UPDATE SET
              blocked_until_ms = MAX(
                agnes_account_rate_state.blocked_until_ms,
                excluded.blocked_until_ms
              ),
              block_reason = CASE
                WHEN excluded.blocked_until_ms >= agnes_account_rate_state.blocked_until_ms
                  THEN excluded.block_reason
                ELSE agnes_account_rate_state.block_reason
              END,
              updated_at_ms = MAX(
                agnes_account_rate_state.updated_at_ms,
                excluded.updated_at_ms
              )
            RETURNING account_id, lane, next_slot_at_ms, blocked_until_ms,
                      block_reason, updated_at_ms`,
      args: [accountId, lane, blockedUntilMs, blockReason, nowMs],
    });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error("Agnes scheduler cooldown was not persisted.");
    return mapAgnesAccountRateStateRow(row);
  }

  async getSeriesCharacters(seriesId: number): Promise<CharacterDef[]> {
    await this.initialize();
    const res = await this.client.execute({
      sql: "SELECT characters_json FROM series WHERE id = ?",
      args: [seriesId],
    });
    return parseJson<CharacterDef[]>(res.rows[0]?.characters_json, []);
  }

  async getSeriesEnvironments(seriesId: number): Promise<EnvironmentDef[]> {
    await this.initialize();
    const res = await this.client.execute({
      sql: "SELECT environments_json FROM series WHERE id = ?",
      args: [seriesId],
    });
    return parseJson<EnvironmentDef[]>(res.rows[0]?.environments_json, []);
  }

  /** Returns true when a series row exists for the given id. */
  async seriesExists(seriesId: number): Promise<boolean> {
    await this.initialize();
    const res = await this.client.execute({
      sql: "SELECT 1 FROM series WHERE id = ? LIMIT 1",
      args: [seriesId],
    });
    return res.rows.length > 0;
  }

  async bulkInsertEpisodesIfEmpty(
    seriesId: number,
    episodes: SeasonEpisodeInput[]
  ): Promise<void> {
    await this.initialize();
    const normalizedEpisodes = validateSeasonEpisodeList(episodes);
    const readStoredEpisodes = async (): Promise<SeasonEpisodeInput[]> => {
      const result = await this.client.execute({
        sql: `SELECT episode_number, title, premise
              FROM episodes
              WHERE series_id = ?
              ORDER BY episode_number ASC`,
        args: [seriesId],
      });
      return result.rows.map((row) => ({
        episodeNumber: Number(row.episode_number),
        title: typeof row.title === "string" ? row.title : "",
        premise: typeof row.premise === "string" ? row.premise : "",
      }));
    };
    const verifyStoredSeason = (storedEpisodes: SeasonEpisodeInput[]): void => {
      validateSeasonEpisodeList(storedEpisodes, `Stored season for series ${seriesId}`);
    };

    const existingEpisodes = await readStoredEpisodes();
    if (existingEpisodes.length > 0) {
      verifyStoredSeason(existingEpisodes);
      return;
    }

    try {
      await this.client.batch(
        normalizedEpisodes.map((episode) => ({
          sql: `INSERT INTO episodes (series_id, episode_number, title, premise)
                VALUES (?, ?, ?, ?)`,
          args: [seriesId, episode.episodeNumber, episode.title, episode.premise],
        })),
        "write",
      );
    } catch (error) {
      // Another process may have committed the same season after our empty read.
      // Accept that race only after proving the complete persisted invariant.
      const concurrentlyStoredEpisodes = await readStoredEpisodes();
      if (concurrentlyStoredEpisodes.length === 0) throw error;
      verifyStoredSeason(concurrentlyStoredEpisodes);
      return;
    }

    verifyStoredSeason(await readStoredEpisodes());
  }

  /**
   * Resolves the resumable episode and the one-per-local-calendar-day gate.
   * Existing work always wins over the gate so repeated invocations can finish
   * the same episode; only advancing to an untouched pending episode is gated.
   */
  async getNextEpisodeAvailability(
    seriesId: number,
    options: EpisodeDailyGateOptions = {},
  ): Promise<NextEpisodeAvailability> {
    await this.initialize();
    const gate = episodeDailyGateContext(options);
    if (!await this.seriesExists(seriesId)) {
      return {
        kind: "series_missing",
        episode: null,
        timeZone: gate.timeZone,
        localDate: gate.localDate,
        message: `Series ${seriesId} was not found.`,
      };
    }

    const candidateResult = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, title, premise, status, script_json, output_path,
                   youtube_video_id, youtube_url, uploaded_at, completed_at, completion_local_date,
                   CASE WHEN
                     status <> 'pending' OR
                     script_json IS NOT NULL OR output_path IS NOT NULL OR
                     youtube_video_id IS NOT NULL OR youtube_url IS NOT NULL OR
                     uploaded_at IS NOT NULL OR completed_at IS NOT NULL OR
                     EXISTS (
                       SELECT 1 FROM agnes_scene_generations a
                       WHERE a.series_id = episodes.series_id
                         AND a.episode_number = episodes.episode_number
                     ) OR
                     EXISTS (
                       SELECT 1 FROM episode_video_outputs o
                       WHERE o.series_id = episodes.series_id
                         AND o.episode_number = episodes.episode_number
                     ) OR
                     EXISTS (
                       SELECT 1 FROM youtube_upload_receipts r
                       WHERE r.series_id = episodes.series_id
                         AND r.episode_number = episodes.episode_number
                     )
                   THEN 1 ELSE 0 END AS is_resumable
            FROM episodes
            WHERE series_id = ?
              AND (
                status <> 'done' OR uploaded_at IS NULL OR trim(uploaded_at) = '' OR
                youtube_video_id IS NULL OR trim(youtube_video_id) = '' OR
                youtube_url IS NULL OR trim(youtube_url) = ''
              )
            ORDER BY is_resumable DESC, episode_number ASC
            LIMIT 1`,
      args: [seriesId],
    });
    const candidateRow = candidateResult.rows[0] as Record<string, unknown> | undefined;
    const candidate = candidateRow ? mapEpisodeRow(candidateRow) : null;

    // A crash or asynchronous Agnes wait must never let the daily gate strand
    // the episode already in progress. It remains the selected episode until
    // its YouTube-confirmed terminal transition commits.
    if (candidate && Number(candidateRow?.is_resumable) === 1) {
      return {
        kind: "ready",
        episode: candidate,
        timeZone: gate.timeZone,
        localDate: gate.localDate,
      };
    }

    const completedEpisodes = await this.client.execute({
      sql: `SELECT episode_number,
                   COALESCE(NULLIF(trim(completed_at), ''), uploaded_at) AS completed_at
            FROM episodes
            WHERE series_id = ? AND status = 'done'
              AND uploaded_at IS NOT NULL AND trim(uploaded_at) <> ''
              AND youtube_video_id IS NOT NULL AND trim(youtube_video_id) <> ''
              AND youtube_url IS NOT NULL AND trim(youtube_url) <> ''
            ORDER BY julianday(COALESCE(NULLIF(trim(completed_at), ''), uploaded_at)) DESC,
                     episode_number DESC`,
      args: [seriesId],
    });
    // Inspect every terminal timestamp. SQLite sorts an unparsable julianday
    // after valid values, so looking only at LIMIT 1 could silently ignore a
    // corrupt completion row and permit another episode.
    for (const completedRow of completedEpisodes.rows) {
      const completedAt = String(completedRow.completed_at);
      const completedInstant = parseDatabaseTimestamp(
        completedAt,
        "Episode completion timestamp",
      );
      const completionDate = localCalendarDate(
        completedInstant,
        gate.timeZone,
      );
      // A future terminal timestamp indicates clock/data corruption. Treat it
      // as consuming today's slot instead of risking a second upload.
      if (completedInstant.getTime() > gate.now.getTime() || completionDate === gate.localDate) {
        return {
          kind: "daily_limit",
          episode: null,
          timeZone: gate.timeZone,
          localDate: gate.localDate,
          completedEpisodeNumber: Number(completedRow.episode_number),
          completedAt,
          message: ONE_EPISODE_PER_DAY_MESSAGE,
        };
      }
    }

    if (candidate) {
      return {
        kind: "ready",
        episode: candidate,
        timeZone: gate.timeZone,
        localDate: gate.localDate,
      };
    }

    const episodeCount = await this.client.execute({
      sql: "SELECT COUNT(*) AS count FROM episodes WHERE series_id = ?",
      args: [seriesId],
    });
    if (Number(episodeCount.rows[0]?.count ?? 0) === 0) {
      return {
        kind: "no_episodes",
        episode: null,
        timeZone: gate.timeZone,
        localDate: gate.localDate,
        message: "The series has no episode manifest yet.",
      };
    }
    return {
      kind: "series_complete",
      episode: null,
      timeZone: gate.timeZone,
      localDate: gate.localDate,
      message: "Every episode in the series is complete.",
    };
  }

  /** Returns the selected resumable episode, or null when daily-gated/complete. */
  async getNextEpisode(
    seriesId: number,
    options: EpisodeDailyGateOptions = {},
  ): Promise<EpisodeRow | null> {
    return (await this.getNextEpisodeAvailability(seriesId, options)).episode;
  }

  /**
   * Enforces the durable/filesystem contract for the terminal episode state.
   * This intentionally lives below the agent tool so no caller can bypass the
   * configured-output gate by calling updateEpisodeStatus directly.
   */
  async assertEpisodeReadyForDone(
    episodeId: number
  ): Promise<{ outputPath: string; durationSeconds: number }> {
    await this.initialize();
    const episodeResult = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, title, script_json
            FROM episodes
            WHERE id = ?
            LIMIT 1`,
      args: [episodeId],
    });
    const episode = episodeResult.rows[0];
    if (!episode) throw new Error(`Cannot mark episode done: episode id ${episodeId} was not found.`);

    const seriesId = Number(episode.series_id);
    const episodeNumber = Number(episode.episode_number);
    const productionScript = inspectProductionScript(
      episode.script_json,
      (await this.getSeriesCharacters(seriesId)).map((character) => character.name),
    );
    if (!productionScript.pass) {
      throw new Error(
        "Cannot mark episode done: persisted script violates the production contract: " +
        productionScript.issues.join(" | "),
      );
    }
    const sceneNumbers = episodeScriptSceneNumbers(episode.script_json);
    const narrationByScene = episodeScriptNarrationMap(episode.script_json);
    const episodeDir = path.resolve(
      CONFIG.outputDir,
      `series_${seriesId}`,
      `episode_${episodeNumber}`
    );
    const captionsPath = path.join(episodeDir, "captions.srt");
    await requireNonEmptyFile(captionsPath, "captions.srt");

    const agnesRows = await this.listAgnesSceneGenerations(seriesId, episodeNumber);
    const rowBySceneVariant = new Map(
      agnesRows.map((row) => [`${row.sceneNumber}:${row.variant}`, row] as const)
    );

    const seriesInfo = await this.getSeriesInfo(seriesId);
    if (!seriesInfo) throw new Error(`Cannot mark episode done: series ${seriesId} was not found.`);
    const keyArtSpecs = [
      {
        kind: "series" as const,
        title: canonicalizeKeyArtTitle(seriesInfo.conceptName, "series"),
        trackingSceneNumber: AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      },
      {
        kind: "episode" as const,
        title: canonicalizeKeyArtTitle(String(episode.title), "episode"),
        trackingSceneNumber: AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      },
    ];
    for (const spec of keyArtSpecs) {
      const paths = agnesKeyArtPaths({ seriesId, episodeNumber, kind: spec.kind });
      await requireNonEmptyFile(paths.audioPath, `${spec.kind} key-art title audio`);
      await requireNonEmptyFile(paths.normalizedVideoPath, `${spec.kind} key-art video`);
      const audioDuration = await probeMediaDuration(paths.audioPath);
      await requireMatchingNarrationMetadata(
        paths.audioPath,
        spec.title,
        audioDuration,
        `${spec.kind} key-art title audio`,
      );
      if (audioDuration > NARRATION_MAX_AUDIO_SECONDS) {
        throw new Error(
          `Cannot mark episode done: ${spec.kind} key-art audio is ${audioDuration.toFixed(3)}s; ` +
          `the maximum is ${NARRATION_MAX_AUDIO_SECONDS}s.`,
        );
      }
      const row = rowBySceneVariant.get(`${spec.trackingSceneNumber}:text`);
      if (!row || row.status !== "completed" || row.downloadStatus !== "downloaded") {
        throw new Error(
          `Cannot mark episode done: Agnes ${spec.kind} key-art video is not completed and downloaded in Turso.`,
        );
      }
      if (
        !row.normalizedOutputPath
        || path.resolve(row.normalizedOutputPath) !== path.resolve(paths.normalizedVideoPath)
      ) {
        throw new Error(
          `Cannot mark episode done: Agnes ${spec.kind} key-art video does not reference its canonical path.`,
        );
      }
      const videoDuration = await probeMediaDuration(paths.normalizedVideoPath);
      if (
        Math.abs(videoDuration - audioDuration) > SCENE_DURATION_TOLERANCE_SECONDS
        || Math.abs(row.requestedDurationSeconds - audioDuration) > SCENE_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `Cannot mark episode done: Agnes ${spec.kind} key-art video duration ` +
          `(${videoDuration.toFixed(3)}s) does not match title audio (${audioDuration.toFixed(3)}s).`,
        );
      }
    }

    let totalNarrationDuration = 0;
    for (const sceneNumber of sceneNumbers) {
      const sceneStem = `scene_${String(sceneNumber).padStart(3, "0")}`;
      const narrationPath = path.join(episodeDir, "audio", `${sceneStem}_narrator.wav`);
      await requireNonEmptyFile(narrationPath, `scene ${sceneNumber} narration`);
      const narrationDuration = await probeMediaDuration(narrationPath);
      await requireMatchingNarrationMetadata(
        narrationPath,
        narrationByScene.get(sceneNumber) ?? "",
        narrationDuration,
        `scene ${sceneNumber} narration`,
      );
      if (narrationDuration > NARRATION_MAX_AUDIO_SECONDS) {
        throw new Error(
          `Cannot mark episode done: scene ${sceneNumber} narration is ${narrationDuration.toFixed(3)}s; ` +
          `every scene must be at most ${NARRATION_MAX_AUDIO_SECONDS} seconds for one Agnes request.`
        );
      }
      totalNarrationDuration += narrationDuration;

      for (const variant of requiredAgnesSceneVariants()) {
        const row = rowBySceneVariant.get(`${sceneNumber}:${variant}`);
        if (!row || row.status !== "completed" || row.downloadStatus !== "downloaded") {
          throw new Error(
            `Cannot mark episode done: Agnes ${variant} scene ${sceneNumber} is not completed and downloaded in Turso.`
          );
        }
        const variantDir = variant === "text" ? "agnes_text" : "agnes_reference";
        const canonicalVideoPath = path.join(episodeDir, variantDir, "scenes", `${sceneStem}.mp4`);
        if (!row.normalizedOutputPath || path.resolve(row.normalizedOutputPath) !== canonicalVideoPath) {
          throw new Error(
            `Cannot mark episode done: Agnes ${variant} scene ${sceneNumber} does not reference its canonical normalized path.`
          );
        }
        await requireNonEmptyFile(canonicalVideoPath, `Agnes ${variant} scene ${sceneNumber} video`);
        const videoDuration = await probeMediaDuration(canonicalVideoPath);
        if (
          Math.abs(videoDuration - narrationDuration) > SCENE_DURATION_TOLERANCE_SECONDS ||
          Math.abs(row.requestedDurationSeconds - narrationDuration) > SCENE_DURATION_TOLERANCE_SECONDS
        ) {
          throw new Error(
            `Cannot mark episode done: Agnes ${variant} scene ${sceneNumber} duration ` +
            `(${videoDuration.toFixed(3)}s) does not match narration (${narrationDuration.toFixed(3)}s).`
          );
        }
      }
    }

    if (totalNarrationDuration < 300) {
      throw new Error(
        `Cannot mark episode done: measured narration runtime is ${totalNarrationDuration.toFixed(3)}s; ` +
        "the episode must contain at least 300 seconds of narration."
      );
    }

    const outputs = await this.listEpisodeVideoOutputs(seriesId, episodeNumber);
    const outputByVariant = new Map(outputs.map((output) => [output.variant, output] as const));
    const measuredFinalDurations: number[] = [];
    let canonicalOutputPath = "";
    for (const variant of requiredEpisodeVideoVariants()) {
      const output = outputByVariant.get(variant);
      if (!output || output.status !== "completed" || !output.outputPath) {
        throw new Error(`Cannot mark episode done: final ${variant} video is not completed in Turso.`);
      }
      const outputPath = path.resolve(output.outputPath);
      if (!pathIsInside(episodeDir, outputPath)) {
        throw new Error(`Cannot mark episode done: final ${variant} video is outside the episode directory.`);
      }
      const baseName = path.basename(outputPath);
      if (!baseName.endsWith(".mp4")) {
        throw new Error(`Cannot mark episode done: final ${variant} video has an unexpected filename.`);
      }
      await requireNonEmptyFile(outputPath, `final ${variant} video`);
      const measuredDuration = await probeMediaDuration(outputPath);
      if (
        output.durationSeconds === null ||
        Math.abs(output.durationSeconds - measuredDuration) > COMPLETION_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(`Cannot mark episode done: final ${variant} duration metadata is missing or stale.`);
      }
      measuredFinalDurations.push(measuredDuration);
      canonicalOutputPath = outputPath;
    }

    const shortest = Math.min(...measuredFinalDurations);
    const longest = Math.max(...measuredFinalDurations);
    if (longest - shortest > COMPLETION_DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `Cannot mark episode done: final comparison video durations differ ` +
        `(${shortest.toFixed(3)}s to ${longest.toFixed(3)}s).`
      );
    }
    return { outputPath: canonicalOutputPath, durationSeconds: measuredFinalDurations[0]! };
  }

  /** Fail closed before Agnes when narration cannot satisfy one-request-per-scene. */
  async assertEpisodeAudioReady(episodeId: number): Promise<{ totalDurationSeconds: number }> {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT series_id, episode_number, script_json FROM episodes WHERE id = ? LIMIT 1",
      args: [episodeId],
    });
    const episode = result.rows[0];
    if (!episode) throw new Error(`Episode id ${episodeId} was not found.`);
    const productionScript = inspectProductionScript(
      episode.script_json,
      (await this.getSeriesCharacters(Number(episode.series_id))).map((character) => character.name),
    );
    if (!productionScript.pass) {
      throw new Error(
        "Persisted episode script violates the production contract: " +
        productionScript.issues.join(" | "),
      );
    }
    const sceneNumbers = episodeScriptSceneNumbers(episode.script_json);
    const narrationByScene = episodeScriptNarrationMap(episode.script_json);
    const episodeDir = path.resolve(
      CONFIG.outputDir,
      `series_${Number(episode.series_id)}`,
      `episode_${Number(episode.episode_number)}`
    );
    let totalDurationSeconds = 0;
    for (const sceneNumber of sceneNumbers) {
      const narrationPath = path.join(
        episodeDir,
        "audio",
        `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`
      );
      await requireNonEmptyFile(narrationPath, `scene ${sceneNumber} narration`);
      const duration = await probeMediaDuration(narrationPath);
      await requireMatchingNarrationMetadata(
        narrationPath,
        narrationByScene.get(sceneNumber) ?? "",
        duration,
        `scene ${sceneNumber} narration`,
      );
      if (duration > NARRATION_MAX_AUDIO_SECONDS) {
        throw new Error(
          `Scene ${sceneNumber} narration is ${duration.toFixed(3)}s. ` +
          `Split the script scene and regenerate its audio before Agnes submission; the maximum is ${NARRATION_MAX_AUDIO_SECONDS}s.`
        );
      }
      totalDurationSeconds += duration;
    }
    if (totalDurationSeconds < 300) {
      throw new Error(
        `Measured episode narration is ${totalDurationSeconds.toFixed(3)}s. ` +
        "Add short scenes until the narration reaches at least 300 seconds."
      );
    }
    return { totalDurationSeconds };
  }

  async updateEpisodeStatus(
    episodeId: number,
    status: EpisodeRow["status"],
    fields: { scriptJson?: unknown; outputPath?: string } = {}
  ): Promise<void> {
    await this.initialize();
    let canonicalOutputPath = fields.outputPath;
    if (status === "audio") {
      await this.assertEpisodeAudioReady(episodeId);
    }
    if (status === "done") {
      throw new Error(
        "Only finalizeEpisodeUpload may mark an episode done after YouTube confirms the upload.",
      );
    }

    if (status === "script" && fields.scriptJson !== undefined) {
      const serializedScript = canonicalJsonString(fields.scriptJson);
      const existing = await this.client.execute({
        sql: "SELECT series_id, episode_number, status, script_json FROM episodes WHERE id = ? LIMIT 1",
        args: [episodeId],
      });
      const row = existing.rows[0];
      if (!row) throw new Error(`Episode id ${episodeId} was not found.`);
      if (row.status === "done") {
        throw new Error("A completed episode script cannot be replaced.");
      }
      const productionScript = inspectProductionScript(
        fields.scriptJson,
        (await this.getSeriesCharacters(Number(row.series_id))).map((character) => character.name),
      );
      if (!productionScript.pass) {
        throw new Error(
          "Refusing to persist a script that violates the production contract: " +
          productionScript.issues.join(" | "),
        );
      }
      const priorScript = row.script_json == null ? null : canonicalJsonString(row.script_json);
      if (priorScript === serializedScript) {
        const unchanged = await this.client.execute({
          sql: `UPDATE episodes
                SET status = CASE
                      WHEN status IN ('images', 'audio', 'assembly') THEN status
                      ELSE 'script'
                    END,
                    script_json = ?, updated_at = datetime('now')
                WHERE id = ? AND status <> 'done'`,
          args: [serializedScript, episodeId],
        });
        if (unchanged.rowsAffected === 0) {
          throw new Error("A completed episode script cannot be replaced.");
        }
        return;
      }

      const seriesId = Number(row.series_id);
      const episodeNumber = Number(row.episode_number);
      // One ordered write batch makes the no-submission guard and artifact
      // invalidation atomic. Each delete is additionally tied to the newly
      // stored script, so a failed guard cannot remove resumable work.
      const results = await this.client.batch([
        {
          sql: `UPDATE episodes
                SET status = 'script', script_json = ?, output_path = NULL,
                    updated_at = datetime('now')
                WHERE id = ? AND status <> 'done'
                  AND NOT EXISTS (
                    SELECT 1 FROM agnes_scene_generations
                    WHERE series_id = ? AND episode_number = ?
                      AND (
                        attempt_count > 0 OR provider_task_id IS NOT NULL OR
                        provider_receipt_json IS NOT NULL OR submitted_at IS NOT NULL OR
                        status <> 'pending'
                      )
                  )`,
          args: [serializedScript, episodeId, seriesId, episodeNumber],
        },
        {
          sql: `DELETE FROM agnes_scene_generations
                WHERE series_id = ? AND episode_number = ?
                  AND attempt_count = 0
                  AND provider_task_id IS NULL
                  AND provider_receipt_json IS NULL
                  AND submitted_at IS NULL
                  AND status = 'pending'
                  AND NOT EXISTS (
                    SELECT 1 FROM agnes_scene_generations AS submitted
                    WHERE submitted.series_id = ? AND submitted.episode_number = ?
                      AND (
                        submitted.attempt_count > 0 OR submitted.provider_task_id IS NOT NULL OR
                        submitted.provider_receipt_json IS NOT NULL OR
                        submitted.submitted_at IS NOT NULL OR submitted.status <> 'pending'
                      )
                  )
                  AND EXISTS (
                    SELECT 1 FROM episodes WHERE id = ? AND script_json = ?
                  )`,
          args: [
            seriesId,
            episodeNumber,
            seriesId,
            episodeNumber,
            episodeId,
            serializedScript,
          ],
        },
        {
          sql: `DELETE FROM episode_video_outputs
                WHERE series_id = ? AND episode_number = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM agnes_scene_generations AS submitted
                    WHERE submitted.series_id = ? AND submitted.episode_number = ?
                      AND (
                        submitted.attempt_count > 0 OR submitted.provider_task_id IS NOT NULL OR
                        submitted.provider_receipt_json IS NOT NULL OR
                        submitted.submitted_at IS NOT NULL OR submitted.status <> 'pending'
                      )
                  )
                  AND EXISTS (
                    SELECT 1 FROM episodes WHERE id = ? AND script_json = ?
                  )`,
          args: [
            seriesId,
            episodeNumber,
            seriesId,
            episodeNumber,
            episodeId,
            serializedScript,
          ],
        },
      ], "write");
      if (results[0]?.rowsAffected === 0) {
        const current = await this.client.execute({
          sql: `SELECT a.scene_number, a.variant, e.status
                FROM episodes e
                LEFT JOIN agnes_scene_generations a
                  ON a.series_id = e.series_id AND a.episode_number = e.episode_number
                  AND (
                    a.attempt_count > 0 OR a.provider_task_id IS NOT NULL OR
                    a.provider_receipt_json IS NOT NULL OR a.submitted_at IS NOT NULL OR
                    a.status <> 'pending'
                  )
                WHERE e.id = ?
                LIMIT 1`,
          args: [episodeId],
        });
        const currentRow = current.rows[0];
        if (currentRow?.status === "done") {
          throw new Error("A completed episode script cannot be replaced.");
        }
        throw new Error(
          `Cannot replace the episode script after Agnes submission has started` +
          (currentRow?.scene_number == null
            ? "."
            : ` (scene ${String(currentRow.scene_number)}, ${String(currentRow.variant)}).`) +
          " Resume the persisted script and Agnes tasks instead.",
        );
      }
      return;
    }

    await this.client.execute({
      sql: `UPDATE episodes
            SET status = ?,
                script_json = COALESCE(?, script_json),
                output_path = COALESCE(?, output_path),
                updated_at = datetime('now')
            WHERE id = ?`,
      args: [
        status,
        fields.scriptJson !== undefined ? canonicalJsonString(fields.scriptJson) : null,
        canonicalOutputPath ?? null,
        episodeId,
      ],
    });
  }

  /** Returns the durable recovery receipt written immediately after YouTube succeeds. */
  async getYoutubeUploadReceipt(
    seriesId: number,
    episodeNumber: number,
  ): Promise<YoutubeUploadReceiptRow | null> {
    await this.initialize();
    const result = await this.client.execute({
      sql: `SELECT series_id, episode_number, video_id, url, created_at, updated_at
            FROM youtube_upload_receipts
            WHERE series_id = ? AND episode_number = ?
            LIMIT 1`,
      args: [seriesId, episodeNumber],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      seriesId: Number(row.series_id),
      episodeNumber: Number(row.episode_number),
      videoId: String(row.video_id),
      url: String(row.url),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Final preflight before making an irreversible YouTube request. Selection
   * already applies this rule, but this second guard closes stale/concurrent
   * runner races and also counts a recovery outbox as a successful upload.
   */
  async assertEpisodeUploadAllowedToday(
    seriesId: number,
    episodeNumber: number,
    options: EpisodeDailyGateOptions = {},
  ): Promise<void> {
    await this.initialize();
    const gate = episodeDailyGateContext(options);
    const episode = await this.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
    }
    if (
      episode.status === "done" && episode.uploadedAt?.trim() &&
      episode.youtubeVideoId?.trim() && episode.youtubeUrl?.trim()
    ) {
      throw new Error(`Episode ${episodeNumber} already has a completed YouTube upload.`);
    }
    const ownReceipt = await this.getYoutubeUploadReceipt(seriesId, episodeNumber);
    if (ownReceipt) {
      throw new Error(
        `Episode ${episodeNumber} already has a YouTube recovery receipt; finish local finalization instead of uploading again.`,
      );
    }

    const recentUploads = await this.client.execute({
      sql: `SELECT episode_number, uploaded_at
            FROM (
              SELECT episode_number,
                     COALESCE(NULLIF(trim(completed_at), ''), uploaded_at) AS uploaded_at
              FROM episodes
              WHERE series_id = ? AND episode_number <> ? AND status = 'done'
                AND uploaded_at IS NOT NULL AND trim(uploaded_at) <> ''
                AND youtube_video_id IS NOT NULL AND trim(youtube_video_id) <> ''
                AND youtube_url IS NOT NULL AND trim(youtube_url) <> ''
              UNION ALL
              SELECT episode_number, created_at AS uploaded_at
              FROM youtube_upload_receipts
              WHERE series_id = ? AND episode_number <> ?
            )
            ORDER BY julianday(uploaded_at) DESC, episode_number DESC`,
      args: [seriesId, episodeNumber, seriesId, episodeNumber],
    });
    for (const row of recentUploads.rows) {
      const uploadInstant = parseDatabaseTimestamp(
        row.uploaded_at,
        "YouTube upload timestamp",
      );
      const uploadDate = localCalendarDate(
        uploadInstant,
        gate.timeZone,
      );
      if (uploadInstant.getTime() > gate.now.getTime() || uploadDate === gate.localDate) {
        throw new Error(ONE_EPISODE_PER_DAY_MESSAGE);
      }
    }
  }

  /**
   * Persists the irreversible remote result before readiness validation and
   * cleanup. A conflicting video id fails closed instead of hiding a possible
   * duplicate upload.
   */
  async recordYoutubeUploadReceipt(params: {
    seriesId: number;
    episodeNumber: number;
    videoId: string;
    url: string;
  }): Promise<YoutubeUploadReceiptRow> {
    await this.initialize();
    const videoId = params.videoId.trim();
    const url = params.url.trim();
    if (!videoId || !url) {
      throw new Error("A non-empty YouTube video id and URL are required.");
    }
    const episode = await this.getEpisodeByNumber(params.seriesId, params.episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${params.episodeNumber} was not found for series ${params.seriesId}.`);
    }
    if (episode.youtubeVideoId && episode.youtubeVideoId !== videoId) {
      throw new Error(
        `Episode ${params.episodeNumber} is already linked to YouTube video ${episode.youtubeVideoId}.`,
      );
    }

    const result = await this.client.execute({
      sql: `INSERT INTO youtube_upload_receipts (
              series_id, episode_number, video_id, url
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT (series_id, episode_number)
            DO UPDATE SET url = excluded.url, updated_at = datetime('now')
            WHERE youtube_upload_receipts.video_id = excluded.video_id
            RETURNING series_id, episode_number, video_id, url, created_at, updated_at`,
      args: [params.seriesId, params.episodeNumber, videoId, url],
    });
    const returned = result.rows[0];
    if (!returned) {
      const conflicting = await this.getYoutubeUploadReceipt(params.seriesId, params.episodeNumber);
      throw new Error(
        `Episode ${params.episodeNumber} already has a recovery receipt for YouTube video ` +
        `${conflicting?.videoId ?? "an unknown id"}; refusing ${videoId}.`,
      );
    }
    return {
      seriesId: Number(returned.series_id),
      episodeNumber: Number(returned.episode_number),
      videoId: String(returned.video_id),
      url: String(returned.url),
      createdAt: String(returned.created_at),
      updatedAt: String(returned.updated_at),
    };
  }

  /**
   * Backward-compatible entry point. New callers should use
   * finalizeEpisodeUpload, which also removes transient generation state.
   */
  async markEpisodeUploaded(params: {
    seriesId: number;
    episodeNumber: number;
    videoId: string;
    url: string;
  }): Promise<EpisodeRow> {
    return this.finalizeEpisodeUpload(params);
  }

  /** Remove only per-episode working rows after a durable successful upload. */
  async cleanupUploadedEpisodeTracking(seriesId: number, episodeNumber: number): Promise<void> {
    await this.initialize();
    const episode = await this.getEpisodeByNumber(seriesId, episodeNumber);
    if (!episode?.uploadedAt || episode.status !== "done") {
      throw new Error("Episode tracking can be cleaned only after a successful upload is recorded.");
    }
    await this.client.batch([
      {
        sql: `UPDATE episodes
              SET script_json = NULL, updated_at = datetime('now')
              WHERE series_id = ? AND episode_number = ?`,
        args: [seriesId, episodeNumber],
      },
      {
        sql: "DELETE FROM agnes_scene_generations WHERE series_id = ? AND episode_number = ?",
        args: [seriesId, episodeNumber],
      },
      {
        sql: "DELETE FROM episode_video_outputs WHERE series_id = ? AND episode_number = ?",
        args: [seriesId, episodeNumber],
      },
      {
        sql: "DELETE FROM key_art WHERE series_id = ?",
        args: [seriesId],
      },
      {
        sql: "DELETE FROM youtube_upload_receipts WHERE series_id = ? AND episode_number = ?",
        args: [seriesId, episodeNumber],
      },
    ], "write");
  }

  /**
   * Atomically records a successful YouTube upload and removes the bulky,
   * episode-local generation rows. The episode row, canonical output path,
   * YouTube receipt, fixed series roster, and character sheets are retained.
   *
   * Keeping the receipt update and cleanup in one Turso transaction prevents a
   * rerun from seeing a half-cleaned uploaded episode. Repeating the call with
   * the same video id is safe and finishes any cleanup left by an older build.
   */
  async finalizeEpisodeUpload(params: {
    seriesId: number;
    episodeNumber: number;
    videoId: string;
    url: string;
  }): Promise<EpisodeRow> {
    await this.initialize();
    const videoId = params.videoId.trim();
    const url = params.url.trim();
    if (!videoId || !url) {
      throw new Error("A non-empty YouTube video id and URL are required.");
    }

    // This insert intentionally precedes all fallible filesystem/readiness
    // checks. If any later step fails, a rerun can still prove the remote video
    // exists and must not call YouTube again.
    const uploadReceipt = await this.recordYoutubeUploadReceipt({
      seriesId: params.seriesId,
      episodeNumber: params.episodeNumber,
      videoId,
      url,
    });

    const episode = await this.getEpisodeByNumber(params.seriesId, params.episodeNumber);
    if (!episode) {
      throw new Error(`Episode ${params.episodeNumber} was not found for series ${params.seriesId}.`);
    }
    // The outbox created_at is the stable instant when YouTube success was
    // first observed. If local finalization resumes after midnight, retain that
    // original day instead of assigning the recovery invocation's date.
    const completionTimestamp = episode.uploadedAt?.trim() || uploadReceipt.createdAt;
    const completionLocalDate = localCalendarDate(
      parseDatabaseTimestamp(completionTimestamp, "YouTube completion timestamp"),
      CONFIG.episodeDailyTimezone,
    );
    if (episode.uploadedAt?.trim()) {
      if (episode.youtubeVideoId?.trim() && episode.youtubeVideoId !== videoId) {
        throw new Error(
          `Episode ${params.episodeNumber} is already linked to YouTube video ${episode.youtubeVideoId}.`,
        );
      }
      // A prior build may have persisted the irreversible upload timestamp but
      // crashed before setting status done or filling every receipt field. The
      // outbox written above is sufficient proof to repair those fields; do
      // not demand generation artifacts that may already have been cleaned.
      const repaired = await this.client.execute({
        sql: `UPDATE episodes
              SET status = 'done', youtube_video_id = ?, youtube_url = ?,
                  completed_at = COALESCE(NULLIF(trim(completed_at), ''), ?),
                  completion_local_date = ?,
                  updated_at = datetime('now')
              WHERE id = ?
                AND (youtube_video_id IS NULL OR trim(youtube_video_id) = '' OR youtube_video_id = ?)`,
        args: [videoId, url, completionTimestamp, completionLocalDate, episode.id, videoId],
      });
      if (repaired.rowsAffected === 0) {
        const current = await this.getEpisodeByNumber(params.seriesId, params.episodeNumber);
        throw new Error(
          `Episode ${params.episodeNumber} is already linked to YouTube video ` +
          `${current?.youtubeVideoId ?? "an unknown id"}.`,
        );
      }
      await this.cleanupUploadedEpisodeTracking(params.seriesId, params.episodeNumber);
      const existing = await this.getEpisodeByNumber(params.seriesId, params.episodeNumber);
      if (!existing) throw new Error("Uploaded episode disappeared while finishing cleanup.");
      return existing;
    }

    const ready = await this.assertEpisodeReadyForDone(episode.id);
    await this.client.batch([
      {
        sql: `UPDATE episodes
              SET status = 'done', output_path = ?, script_json = NULL,
                  youtube_video_id = ?, youtube_url = ?, uploaded_at = ?,
                  completed_at = ?, completion_local_date = ?,
                  updated_at = datetime('now')
              WHERE id = ? AND (uploaded_at IS NULL OR trim(uploaded_at) = '')`,
        args: [
          ready.outputPath,
          videoId,
          url,
          completionTimestamp,
          completionTimestamp,
          completionLocalDate,
          episode.id,
        ],
      },
      {
        sql: `DELETE FROM agnes_scene_generations
              WHERE series_id = ? AND episode_number = ?
                AND EXISTS (
                  SELECT 1 FROM episodes
                  WHERE id = ? AND youtube_video_id = ? AND uploaded_at IS NOT NULL
                )`,
        args: [params.seriesId, params.episodeNumber, episode.id, videoId],
      },
      {
        sql: `DELETE FROM episode_video_outputs
              WHERE series_id = ? AND episode_number = ?
                AND EXISTS (
                  SELECT 1 FROM episodes
                  WHERE id = ? AND youtube_video_id = ? AND uploaded_at IS NOT NULL
                )`,
        args: [params.seriesId, params.episodeNumber, episode.id, videoId],
      },
      {
        sql: `DELETE FROM key_art
              WHERE series_id = ?
                AND EXISTS (
                  SELECT 1 FROM episodes
                  WHERE id = ? AND youtube_video_id = ? AND uploaded_at IS NOT NULL
                )`,
        args: [params.seriesId, episode.id, videoId],
      },
      {
        sql: `DELETE FROM youtube_upload_receipts
              WHERE series_id = ? AND episode_number = ? AND video_id = ?
                AND EXISTS (
                  SELECT 1 FROM episodes
                  WHERE id = ? AND youtube_video_id = ? AND uploaded_at IS NOT NULL
                )`,
        args: [params.seriesId, params.episodeNumber, videoId, episode.id, videoId],
      },
    ], "write");

    const stored = await this.getEpisodeByNumber(params.seriesId, params.episodeNumber);
    if (!stored?.uploadedAt || !stored.completedAt || !stored.completionLocalDate || stored.youtubeVideoId !== videoId) {
      throw new Error("YouTube receipt finalization did not commit as expected.");
    }
    return stored;
  }

  async getCharacterSheet(seriesId: number, characterName: string): Promise<CharacterSheetRow | null> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, character_name, description, reference_image_paths, generation_prompt, approved_at
            FROM character_sheets WHERE series_id = ? AND character_name = ?`,
      args: [seriesId, characterName],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id as number,
      seriesId: row.series_id as number,
      characterName: row.character_name as string,
      description: row.description as string,
      referenceImagePaths: parseJson<Record<string, ReferenceImage>>(row.reference_image_paths, {}),
      generationPrompt: (row.generation_prompt as string | null),
      approvedAt: (row.approved_at as string | null),
    };
  }

  async upsertCharacterSheet(
    seriesId: number,
    characterName: string,
    description: string,
    referenceImagePaths: Record<string, ReferenceImage>,
    generationPrompt?: string
  ): Promise<void> {
    await this.initialize();
    await this.client.execute({
      sql: `INSERT INTO character_sheets (series_id, character_name, description, reference_image_paths, generation_prompt, approved_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT (series_id, character_name)
            DO UPDATE SET description = excluded.description,
                          reference_image_paths = excluded.reference_image_paths,
                          generation_prompt = COALESCE(excluded.generation_prompt, character_sheets.generation_prompt),
                          approved_at = datetime('now')`,
      args: [seriesId, characterName, description, JSON.stringify(referenceImagePaths), generationPrompt ?? null],
    });
  }

  /**
   * Retrieves key art for a series (artType='series', episodeNumber=null)
   * or a specific episode (artType='episode', episodeNumber=N).
   */
  async getKeyArt(
    seriesId: number,
    artType: "series" | "episode",
    episodeNumber: number | null = null
  ): Promise<KeyArtRow | null> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, art_type, episode_number, candidate_paths,
                   selected_path, rationale, approved_at
            FROM key_art
            WHERE series_id = ? AND art_type = ?
              AND (episode_number IS ? OR (episode_number IS NULL AND ? IS NULL))`,
      args: [seriesId, artType, episodeNumber, episodeNumber],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id as number,
      seriesId: row.series_id as number,
      artType: row.art_type as "series" | "episode",
      episodeNumber: (row.episode_number as number | null),
      candidatePaths: parseJson<Record<string, string>>(row.candidate_paths, {}),
      selectedPath: (row.selected_path as string | null),
      rationale: (row.rationale as string | null),
      approvedAt: (row.approved_at as string | null),
    };
  }

  /** Inserts or updates a key art row for a series or episode. */
  async upsertKeyArt(
    seriesId: number,
    artType: "series" | "episode",
    episodeNumber: number | null,
    candidatePaths: Record<string, string>,
    selectedPath: string,
    rationale: string
  ): Promise<void> {
    await this.initialize();
    await this.client.execute({
      sql: `INSERT INTO key_art (series_id, art_type, episode_number, candidate_paths, selected_path, rationale, approved_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT (series_id, art_type, episode_number)
            DO UPDATE SET candidate_paths = excluded.candidate_paths,
                          selected_path = excluded.selected_path,
                          rationale = excluded.rationale,
                          approved_at = datetime('now')`,
      args: [seriesId, artType, episodeNumber, JSON.stringify(candidatePaths), selectedPath, rationale],
    });
  }

  /** Returns one durable Agnes task receipt, or null when it has not been submitted yet. */
  async getAgnesSceneGeneration(
    seriesId: number,
    episodeNumber: number,
    sceneNumber: number,
    variant: AgnesSceneVariant
  ): Promise<AgnesSceneGenerationRow | null> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, scene_number, variant, status,
                   prompt, request_digest, attempt_count, seed,
                   requested_duration_seconds, provider_duration_seconds,
                   public_reference_url, provider_task_id, provider_receipt_json,
                   provider_video_url, raw_output_path, normalized_output_path, download_status,
                   error, submitted_at, completed_at, created_at, updated_at
            FROM agnes_scene_generations
            WHERE series_id = ? AND episode_number = ? AND scene_number = ? AND variant = ?
            LIMIT 1`,
      args: [seriesId, episodeNumber, sceneNumber, variant],
    });
    const row = res.rows[0];
    return row ? mapAgnesSceneGenerationRow(row as unknown as Record<string, unknown>) : null;
  }

  /**
   * Inserts or advances one Agnes scene task. Remote IDs, receipts, URLs, and
   * local paths are retained when a later status-only update omits them.
   */
  async upsertAgnesSceneGeneration(
    input: UpsertAgnesSceneGenerationInput
  ): Promise<AgnesSceneGenerationRow> {
    await this.initialize();

    if (input.attemptCount !== undefined && (
      !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0
    )) {
      throw new Error("Agnes attemptCount must be a non-negative integer.");
    }
    const requestDigest = input.requestDigest == null ? null : input.requestDigest.trim();
    if (input.requestDigest != null && !requestDigest) {
      throw new Error("Agnes requestDigest must not be empty.");
    }

    const now = new Date().toISOString();
    const submittedAt = input.submittedAt ?? (input.status === "submitted" ? now : null);
    const completedAt = input.completedAt ?? (input.status === "completed" ? now : null);
    let providerReceiptJson: string | null = null;
    if (input.providerReceipt !== undefined && input.providerReceipt !== null) {
      const serializedReceipt = JSON.stringify(input.providerReceipt);
      if (serializedReceipt === undefined) {
        throw new Error("Agnes provider receipt is not JSON-serializable.");
      }
      providerReceiptJson = serializedReceipt;
    }

    await this.client.execute({
      sql: `INSERT INTO agnes_scene_generations (
              series_id, episode_number, scene_number, variant, status, prompt,
              request_digest, attempt_count, seed,
              requested_duration_seconds, provider_duration_seconds, public_reference_url,
              provider_task_id, provider_receipt_json, provider_video_url,
              raw_output_path, normalized_output_path, download_status, error, submitted_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (series_id, episode_number, scene_number, variant)
            DO UPDATE SET status = CASE
                            WHEN agnes_scene_generations.status = 'completed' THEN 'completed'
                            WHEN excluded.status = 'completed' THEN 'completed'
                            WHEN agnes_scene_generations.status = 'in_progress'
                              AND excluded.status IN ('pending', 'submitted', 'queued')
                              THEN agnes_scene_generations.status
                            WHEN agnes_scene_generations.status = 'queued'
                              AND excluded.status IN ('pending', 'submitted')
                              THEN agnes_scene_generations.status
                            WHEN agnes_scene_generations.status = 'submitted'
                              AND excluded.status = 'pending'
                              THEN agnes_scene_generations.status
                            ELSE excluded.status
                          END,
                          prompt = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.prompt
                            ELSE excluded.prompt
                          END,
                          request_digest = CASE
                            WHEN excluded.request_digest IS NULL THEN agnes_scene_generations.request_digest
                            WHEN agnes_scene_generations.provider_task_id IS NULL
                              AND agnes_scene_generations.provider_receipt_json IS NULL
                              THEN excluded.request_digest
                            ELSE COALESCE(agnes_scene_generations.request_digest, excluded.request_digest)
                          END,
                          attempt_count = CASE
                            WHEN ? THEN MAX(
                              excluded.attempt_count,
                              agnes_scene_generations.attempt_count
                            )
                            ELSE agnes_scene_generations.attempt_count
                          END,
                          seed = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.seed
                            ELSE COALESCE(agnes_scene_generations.seed, excluded.seed)
                          END,
                          requested_duration_seconds = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.requested_duration_seconds
                            ELSE excluded.requested_duration_seconds
                          END,
                          provider_duration_seconds = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.provider_duration_seconds
                            ELSE excluded.provider_duration_seconds
                          END,
                          public_reference_url = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.public_reference_url
                            ELSE COALESCE(agnes_scene_generations.public_reference_url, excluded.public_reference_url)
                          END,
                          provider_task_id = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.provider_task_id
                            ELSE COALESCE(excluded.provider_task_id, agnes_scene_generations.provider_task_id)
                          END,
                          provider_receipt_json = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.provider_receipt_json
                            ELSE COALESCE(excluded.provider_receipt_json, agnes_scene_generations.provider_receipt_json)
                          END,
                          provider_video_url = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.provider_video_url
                            ELSE COALESCE(excluded.provider_video_url, agnes_scene_generations.provider_video_url)
                          END,
                          raw_output_path = CASE
                            WHEN agnes_scene_generations.download_status = 'downloaded'
                              THEN COALESCE(agnes_scene_generations.raw_output_path, excluded.raw_output_path)
                            ELSE COALESCE(excluded.raw_output_path, agnes_scene_generations.raw_output_path)
                          END,
                          normalized_output_path = CASE
                            WHEN agnes_scene_generations.download_status = 'downloaded'
                              THEN COALESCE(agnes_scene_generations.normalized_output_path, excluded.normalized_output_path)
                            ELSE COALESCE(excluded.normalized_output_path, agnes_scene_generations.normalized_output_path)
                          END,
                          download_status = CASE
                            WHEN agnes_scene_generations.download_status = 'downloaded' THEN 'downloaded'
                            WHEN ? THEN excluded.download_status
                            ELSE agnes_scene_generations.download_status
                          END,
                          error = CASE
                            WHEN agnes_scene_generations.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN agnes_scene_generations.error
                            WHEN agnes_scene_generations.download_status = 'downloaded'
                              AND excluded.download_status <> 'downloaded'
                              THEN agnes_scene_generations.error
                            ELSE excluded.error
                          END,
                          submitted_at = COALESCE(excluded.submitted_at, agnes_scene_generations.submitted_at),
                          completed_at = COALESCE(agnes_scene_generations.completed_at, excluded.completed_at),
                          updated_at = datetime('now')`,
      args: [
        input.seriesId,
        input.episodeNumber,
        input.sceneNumber,
        input.variant,
        input.status,
        input.prompt,
        requestDigest,
        input.attemptCount ?? null,
        input.seed ?? null,
        input.requestedDurationSeconds,
        input.providerDurationSeconds,
        input.publicReferenceUrl ?? null,
        input.providerTaskId ?? null,
        providerReceiptJson,
        input.providerVideoUrl ?? null,
        input.rawOutputPath ?? null,
        input.normalizedOutputPath ?? null,
        input.downloadStatus ?? "pending",
        input.error ?? null,
        submittedAt,
        completedAt,
        input.attemptCount === undefined ? 0 : 1,
        input.downloadStatus === undefined ? 0 : 1,
      ],
    });

    const stored = await this.getAgnesSceneGeneration(
      input.seriesId,
      input.episodeNumber,
      input.sceneNumber,
      input.variant
    );
    if (!stored) throw new Error("Agnes scene generation was upserted but could not be read back.");
    return stored;
  }

  /**
   * Atomically claims exactly one outbound Agnes POST intent. The caller must
   * persist its unique intent token in providerReceipt before making the POST.
   * A concurrent caller using the same stale attempt count loses the CAS and
   * receives the latest row without permission to submit.
   */
  async claimAgnesSceneSubmission(
    input: ClaimAgnesSceneSubmissionInput,
    expectedAttemptCount: number
  ): Promise<{ claimed: boolean; row: AgnesSceneGenerationRow }> {
    await this.initialize();
    const requestDigest = input.requestDigest.trim();
    if (!requestDigest) throw new Error("Agnes requestDigest must not be empty.");
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new Error("expectedAttemptCount must be a non-negative integer.");
    }
    if (input.providerReceipt === null || input.providerReceipt === undefined) {
      throw new Error("An Agnes pre-submission receipt envelope is required.");
    }
    const providerReceiptJson = JSON.stringify(input.providerReceipt);
    if (providerReceiptJson === undefined) {
      throw new Error("Agnes provider receipt is not JSON-serializable.");
    }
    const submittedAt = input.submittedAt ?? new Date().toISOString();

    const result = await this.client.execute({
      sql: `INSERT INTO agnes_scene_generations (
              series_id, episode_number, scene_number, variant, status, prompt,
              request_digest, attempt_count, seed,
              requested_duration_seconds, provider_duration_seconds, public_reference_url,
              provider_task_id, provider_receipt_json, provider_video_url,
              raw_output_path, normalized_output_path, download_status, error, submitted_at, completed_at
            )
            SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL
            WHERE ? = 0
               OR EXISTS (
                 SELECT 1
                 FROM agnes_scene_generations
                 WHERE series_id = ? AND episode_number = ? AND scene_number = ? AND variant = ?
               )
            ON CONFLICT (series_id, episode_number, scene_number, variant)
            DO UPDATE SET status = 'pending',
                          prompt = excluded.prompt,
                          request_digest = excluded.request_digest,
                          attempt_count = agnes_scene_generations.attempt_count + 1,
                          seed = COALESCE(excluded.seed, agnes_scene_generations.seed),
                          requested_duration_seconds = excluded.requested_duration_seconds,
                          provider_duration_seconds = excluded.provider_duration_seconds,
                          public_reference_url = COALESCE(excluded.public_reference_url, agnes_scene_generations.public_reference_url),
                          provider_task_id = COALESCE(excluded.provider_task_id, agnes_scene_generations.provider_task_id),
                          provider_receipt_json = excluded.provider_receipt_json,
                          provider_video_url = COALESCE(excluded.provider_video_url, agnes_scene_generations.provider_video_url),
                          raw_output_path = COALESCE(excluded.raw_output_path, agnes_scene_generations.raw_output_path),
                          normalized_output_path = COALESCE(excluded.normalized_output_path, agnes_scene_generations.normalized_output_path),
                          download_status = 'pending',
                          error = NULL,
                          submitted_at = COALESCE(excluded.submitted_at, agnes_scene_generations.submitted_at),
                          completed_at = NULL,
                          updated_at = datetime('now')
            WHERE agnes_scene_generations.attempt_count = ?
              AND agnes_scene_generations.status <> 'completed'
              AND agnes_scene_generations.download_status <> 'downloaded'
              AND (agnes_scene_generations.request_digest IS NULL
                OR agnes_scene_generations.request_digest = excluded.request_digest)
            RETURNING id, series_id, episode_number, scene_number, variant, status,
                      prompt, request_digest, attempt_count, seed,
                      requested_duration_seconds, provider_duration_seconds,
                      public_reference_url, provider_task_id, provider_receipt_json,
                      provider_video_url, raw_output_path, normalized_output_path, download_status,
                      error, submitted_at, completed_at, created_at, updated_at`,
      args: [
        input.seriesId,
        input.episodeNumber,
        input.sceneNumber,
        input.variant,
        input.prompt,
        requestDigest,
        expectedAttemptCount + 1,
        input.seed ?? null,
        input.requestedDurationSeconds,
        input.providerDurationSeconds,
        input.publicReferenceUrl ?? null,
        input.providerTaskId ?? null,
        providerReceiptJson,
        input.providerVideoUrl ?? null,
        input.rawOutputPath ?? null,
        input.normalizedOutputPath ?? null,
        submittedAt,
        expectedAttemptCount,
        input.seriesId,
        input.episodeNumber,
        input.sceneNumber,
        input.variant,
        expectedAttemptCount,
      ],
    });

    const returned = result.rows[0];
    if (returned) {
      return {
        claimed: true,
        row: mapAgnesSceneGenerationRow(returned as unknown as Record<string, unknown>),
      };
    }

    const row = await this.getAgnesSceneGeneration(
      input.seriesId,
      input.episodeNumber,
      input.sceneNumber,
      input.variant
    );
    if (!row) {
      throw new Error("Agnes submission claim lost but no current row could be read.");
    }
    return { claimed: false, row };
  }

  /**
   * CAS-reset a stale request after the caller has inspected its receipt
   * envelope and proved it contains no accepted, submitting, or ambiguous
   * provider attempt. The database deliberately does not infer that safety
   * decision from provider-specific JSON.
   */
  async resetAgnesSceneGenerationForRequest(
    input: ResetAgnesSceneGenerationForRequestInput,
    expected: { requestDigest: string | null; attemptCount: number }
  ): Promise<{ reset: boolean; row: AgnesSceneGenerationRow }> {
    await this.initialize();
    const requestDigest = input.requestDigest.trim();
    if (!requestDigest) throw new Error("Agnes requestDigest must not be empty.");
    if (!Number.isSafeInteger(expected.attemptCount) || expected.attemptCount < 0) {
      throw new Error("expected.attemptCount must be a non-negative integer.");
    }

    const result = await this.client.execute({
      sql: `UPDATE agnes_scene_generations
            SET status = 'pending',
                prompt = ?,
                request_digest = ?,
                attempt_count = 0,
                seed = ?,
                requested_duration_seconds = ?,
                provider_duration_seconds = ?,
                public_reference_url = ?,
                provider_task_id = NULL,
                provider_receipt_json = NULL,
                provider_video_url = NULL,
                raw_output_path = NULL,
                normalized_output_path = NULL,
                download_status = 'pending',
                error = NULL,
                submitted_at = NULL,
                completed_at = NULL,
                updated_at = datetime('now')
            WHERE series_id = ? AND episode_number = ? AND scene_number = ? AND variant = ?
              AND attempt_count = ?
              AND status <> 'completed'
              AND download_status <> 'downloaded'
              AND ((? IS NULL AND request_digest IS NULL) OR request_digest = ?)
            RETURNING id, series_id, episode_number, scene_number, variant, status,
                      prompt, request_digest, attempt_count, seed,
                      requested_duration_seconds, provider_duration_seconds,
                      public_reference_url, provider_task_id, provider_receipt_json,
                      provider_video_url, raw_output_path, normalized_output_path, download_status,
                      error, submitted_at, completed_at, created_at, updated_at`,
      args: [
        input.prompt,
        requestDigest,
        input.seed ?? null,
        input.requestedDurationSeconds,
        input.providerDurationSeconds,
        input.publicReferenceUrl ?? null,
        input.seriesId,
        input.episodeNumber,
        input.sceneNumber,
        input.variant,
        expected.attemptCount,
        expected.requestDigest,
        expected.requestDigest,
      ],
    });

    const returned = result.rows[0];
    if (returned) {
      return {
        reset: true,
        row: mapAgnesSceneGenerationRow(returned as unknown as Record<string, unknown>),
      };
    }
    const row = await this.getAgnesSceneGeneration(
      input.seriesId,
      input.episodeNumber,
      input.sceneNumber,
      input.variant
    );
    if (!row) throw new Error("Agnes request reset lost but no current row could be read.");
    return { reset: false, row };
  }

  /** Lists all Agnes task receipts for an episode, ordered for deterministic assembly. */
  async listAgnesSceneGenerations(
    seriesId: number,
    episodeNumber: number,
    variant?: AgnesSceneVariant
  ): Promise<AgnesSceneGenerationRow[]> {
    await this.initialize();
    const res = variant
      ? await this.client.execute({
          sql: `SELECT id, series_id, episode_number, scene_number, variant, status,
                       prompt, request_digest, attempt_count, seed,
                       requested_duration_seconds, provider_duration_seconds,
                       public_reference_url, provider_task_id, provider_receipt_json,
                       provider_video_url, raw_output_path, normalized_output_path, download_status,
                       error, submitted_at, completed_at, created_at, updated_at
                FROM agnes_scene_generations
                WHERE series_id = ? AND episode_number = ? AND variant = ?
                ORDER BY scene_number ASC`,
          args: [seriesId, episodeNumber, variant],
        })
      : await this.client.execute({
          sql: `SELECT id, series_id, episode_number, scene_number, variant, status,
                       prompt, request_digest, attempt_count, seed,
                       requested_duration_seconds, provider_duration_seconds,
                       public_reference_url, provider_task_id, provider_receipt_json,
                       provider_video_url, raw_output_path, normalized_output_path, download_status,
                       error, submitted_at, completed_at, created_at, updated_at
                FROM agnes_scene_generations
                WHERE series_id = ? AND episode_number = ?
                ORDER BY scene_number ASC, variant ASC`,
          args: [seriesId, episodeNumber],
        });
    return res.rows.map((row) => mapAgnesSceneGenerationRow(row as unknown as Record<string, unknown>));
  }

  /** Inserts or updates one of the supported assembled video variants. */
  async upsertEpisodeVideoOutput(
    input: UpsertEpisodeVideoOutputInput
  ): Promise<EpisodeVideoOutputRow> {
    await this.initialize();
    const status = input.status ?? (input.outputPath ? "completed" : "pending");
    const completedAt = input.completedAt !== undefined
      ? input.completedAt
      : status === "completed" ? new Date().toISOString() : null;

    await this.client.execute({
      sql: `INSERT INTO episode_video_outputs (
              series_id, episode_number, variant, status, output_path,
              duration_seconds, error, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (series_id, episode_number, variant)
            DO UPDATE SET status = CASE
                            WHEN episode_video_outputs.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN episode_video_outputs.status
                            ELSE excluded.status
                          END,
                          output_path = CASE
                            WHEN episode_video_outputs.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN episode_video_outputs.output_path
                            ELSE excluded.output_path
                          END,
                          duration_seconds = CASE
                            WHEN episode_video_outputs.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN episode_video_outputs.duration_seconds
                            ELSE excluded.duration_seconds
                          END,
                          error = CASE
                            WHEN episode_video_outputs.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN episode_video_outputs.error
                            ELSE excluded.error
                          END,
                          completed_at = CASE
                            WHEN episode_video_outputs.status = 'completed'
                              AND excluded.status <> 'completed'
                              THEN episode_video_outputs.completed_at
                            ELSE excluded.completed_at
                          END,
                          updated_at = datetime('now')`,
      args: [
        input.seriesId,
        input.episodeNumber,
        input.variant,
        status,
        input.outputPath ?? null,
        input.durationSeconds ?? null,
        input.error ?? null,
        completedAt,
      ],
    });

    const rows = await this.listEpisodeVideoOutputs(input.seriesId, input.episodeNumber);
    const stored = rows.find((row) => row.variant === input.variant);
    if (!stored) throw new Error("Episode video output was upserted but could not be read back.");
    return stored;
  }

  /** Lists current and legacy final episode outputs in stable variant order. */
  async listEpisodeVideoOutputs(
    seriesId: number,
    episodeNumber: number
  ): Promise<EpisodeVideoOutputRow[]> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, variant, status, output_path,
                   duration_seconds, error, completed_at, created_at, updated_at
            FROM episode_video_outputs
            WHERE series_id = ? AND episode_number = ?
            ORDER BY CASE variant
              WHEN 'static' THEN 0
              WHEN 'agnes_text' THEN 1
              WHEN 'agnes_reference' THEN 2
              ELSE 3
            END ASC`,
      args: [seriesId, episodeNumber],
    });
    return res.rows.map((row) => mapEpisodeVideoOutputRow(row as unknown as Record<string, unknown>));
  }

  /**
   * Returns high-level series metadata (concept name, episode formula, characters)
   * needed by episode metadata and legacy inspection tools.
   */
  async getSeriesInfo(seriesId: number): Promise<{
    conceptName: string;
    episodeFormula: string;
    charactersJson: CharacterDef[];
  } | null> {
    await this.initialize();
    const res = await this.client.execute({
      sql: "SELECT concept_name, episode_formula, characters_json FROM series WHERE id = ?",
      args: [seriesId],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      conceptName: row.concept_name as string,
      episodeFormula: (row.episode_formula as string) ?? "",
      charactersJson: parseJson<CharacterDef[]>(row.characters_json, []),
    };
  }

  /** Returns every episode in stable episode-number order for series-level metadata. */
  async listEpisodes(seriesId: number): Promise<EpisodeRow[]> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, title, premise, status, script_json, output_path,
                   youtube_video_id, youtube_url, uploaded_at, completed_at, completion_local_date
            FROM episodes
            WHERE series_id = ?
            ORDER BY episode_number ASC`,
      args: [seriesId],
    });
    return res.rows.map((row) => mapEpisodeRow(row as Record<string, unknown>));
  }

  /**
   * Returns a single episode row by series id and episode number.
   */
  async getEpisodeByNumber(seriesId: number, episodeNumber: number): Promise<EpisodeRow | null> {
    await this.initialize();
    const res = await this.client.execute({
      sql: `SELECT id, series_id, episode_number, title, premise, status, script_json, output_path,
                   youtube_video_id, youtube_url, uploaded_at, completed_at, completion_local_date
            FROM episodes
            WHERE series_id = ? AND episode_number = ?
            LIMIT 1`,
      args: [seriesId, episodeNumber],
    });
    const row = res.rows[0];
    if (!row) return null;
    return mapEpisodeRow(row as Record<string, unknown>);
  }
}
