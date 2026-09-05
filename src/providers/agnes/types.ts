import type { AgnesError } from "./errors.js";

export const AGNES_VIDEO_MODEL = "agnes-video-2.5-flash" as const;
export const AGNES_DEFAULT_BASE_URL = "https://apihub.agnes-ai.com" as const;
export const AGNES_CREATE_VIDEO_URL = "https://apihub.agnes-ai.com/v1/videos" as const;
export const AGNES_RETRIEVE_VIDEO_URL = "https://apihub.agnes-ai.com/agnesapi" as const;
export const AGNES_VIDEO_SIZE = "720P" as const;
export const AGNES_VIDEO_ASPECT_RATIO = "16:9" as const;
export const AGNES_MIN_SECONDS = 4 as const;
export const AGNES_MAX_SECONDS = 12 as const;
export const AGNES_MAX_REFERENCE_IMAGES = 5 as const;

export type AgnesVideoMode = "text" | "reference";
/**
 * `submitted` and `pending` are accepted pre-queue states observed/allowed by
 * asynchronous Agnes deployments. They carry a durable video id but are not a
 * queue acknowledgement yet, so callers must reconcile them through retrieval.
 */
export type AgnesTaskStatus =
  | "submitted"
  | "pending"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed";

export type AgnesFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AgnesSleep = (milliseconds: number) => Promise<void>;
export type AgnesClock = () => number;

export interface AgnesClientOptions {
  /** Explicit keys take precedence over environment discovery, including when empty. */
  apiKeys?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Agnes origin or its documented `/v1` API base. */
  baseUrl?: string;
  fetch?: AgnesFetch;
  sleep?: AgnesSleep;
  now?: AgnesClock;
  /** Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Defaults to eight minutes. */
  pollWindowMs?: number;
  /** Per submit/retrieve HTTP deadline. Defaults to 60 seconds. */
  requestTimeoutMs?: number;
  /** Maximum accepted media download size. Defaults to 256 MiB. */
  maxDownloadBytes?: number;
}

interface AgnesSubmitVideoRequestBase {
  prompt: string;
  /** Agnes Flash accepts integer durations from 4 through 12 seconds. */
  seconds: number;
  /** Optional provider random seed. Agnes documents no narrower integer range. */
  seed?: number;
  /** Secret-free notification immediately before each provider POST. */
  onAttempt?: (attempt: { keyLabel: string }) => void;
}

export interface AgnesTextVideoRequest extends AgnesSubmitVideoRequestBase {
  mode: "text";
  images?: never;
}

export interface AgnesReferenceVideoRequest extends AgnesSubmitVideoRequestBase {
  mode: "reference";
  /** One to five public HTTP(S) image URLs that remain valid until completion. */
  images: readonly string[];
}

export type AgnesSubmitVideoRequest = AgnesTextVideoRequest | AgnesReferenceVideoRequest;

export interface AgnesTaskMetadata {
  /** Canonical completed media URL after normalizing supported provider shapes. */
  url?: string;
}

/**
 * Secret-safe asynchronous receipt. The key fingerprint binds every later
 * retrieval to the exact credential that submitted the task.
 */
export interface AgnesVideoTask {
  id: string;
  task_id: string;
  video_id: string;
  model: typeof AGNES_VIDEO_MODEL;
  status: AgnesTaskStatus;
  progress: number;
  keyLabel: string;
  /** Full lowercase SHA-256 of the exact submission key. */
  keyFingerprint: string;
  object?: string;
  created_at?: number;
  completed_at?: number | null;
  seconds?: string;
  size?: string;
  metadata?: AgnesTaskMetadata;
  error?: unknown;
}

export interface AgnesPollOptions {
  pollIntervalMs?: number;
  pollWindowMs?: number;
  sleep?: AgnesSleep;
  now?: AgnesClock;
  /** Awaited after every successful retrieval, including terminal responses. */
  onPoll?: (task: AgnesVideoTask) => void | Promise<void>;
  /** Awaited for transient retrieval failures retried inside this poll window. */
  onPollError?: (error: AgnesError, task: AgnesVideoTask) => void | Promise<void>;
}

export type AgnesPollResult =
  | { outcome: "completed"; task: AgnesVideoTask }
  | { outcome: "failed"; task: AgnesVideoTask }
  | { outcome: "timed_out"; task: AgnesVideoTask };

export interface AgnesDownloadOptions {
  maxBytes?: number;
}

export interface AgnesDownloadResult {
  outputPath: string;
  url: string;
  bytes: number;
  sha256: string;
  contentType?: string;
}
