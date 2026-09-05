import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { loadAgnesAccounts } from "./providers/agnes/accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function optionalInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

const agnesAccounts = loadAgnesAccounts();

/** Central, typed configuration for the content-generator project. */
export const CONFIG = {
  neonDatabaseUrl: () => required("NEON_DATABASE_URL"),

  // Turso (libSQL) database for series, episodes, character sheets, Agnes
  // receipts, assembled outputs, and YouTube receipts. Legacy key-art rows are
  // retained only long enough to be cleaned after a successful upload.
  tursoDatabaseUrl: () => required("TURSO_DATABASE_URL"),
  tursoAuthToken: () => process.env.TURSO_AUTH_TOKEN ?? "",

  // Calendar boundary used by the one-successful-episode-per-day gate. This
  // is intentionally an IANA zone instead of a fixed UTC offset so daylight
  // saving rules (for deployments outside India) remain correct.
  episodeDailyTimezone: process.env.EPISODE_DAILY_TIMEZONE?.trim() || "Asia/Kolkata",

  // OpenRouter keys for vision/reasoning calls (candidate judging, voice selection)
  // Supports up to 5 keys for better rate limit distribution
  openRouterApiKeys: [
    process.env.OPENROUTER_API_KEY ?? "",
    process.env.OPENROUTER_API_KEY_2 ?? "",
    process.env.OPENROUTER_API_KEY_3 ?? "",
    process.env.OPENROUTER_API_KEY_4 ?? "",
    process.env.OPENROUTER_API_KEY_5 ?? "",
  ].filter((key): key is string => Boolean(key)),
  openRouterJudgeModel: process.env.OPENROUTER_JUDGE_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",

  groqApiKey: process.env.GROQ_API_KEY ?? process.env.GROQ_API_KEY_1 ?? "",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",

  // Single narrator voice used for the entire episode (see Groq TTS docs for
  // available Orpheus voices). The whole video is narrated by one voice, so
  // no per-character voice mapping is needed.
  groqTtsModel: process.env.GROQ_TTS_MODEL ?? "canopylabs/orpheus-v1-english",
  groqTtsVoice: process.env.GROQ_TTS_VOICE ?? "hannah",

  // AnyAPI is used only for the one-time main-character portrait/sheet flow.
  anyApiKeys: [
    process.env.ANYAPI_KEY ?? "",
    process.env.ANYAPI_KEY_2 ?? "",
    process.env.ANYAPI_KEY_3 ?? "",
    process.env.ANYAPI_KEY_4 ?? "",
    process.env.ANYAPI_KEY_5 ?? "",
  ].filter((key): key is string => Boolean(key)),
  anyApiModel: process.env.ANYAPI_MODEL ?? "google/gemini-3.1-flash-image",
  sceneQaAnyApiRegenAttempts: Math.max(0, Number.parseInt(process.env.SCENE_QA_ANYAPI_REGEN_ATTEMPTS ?? "0", 10) || 0),

  // Agnes Video 2.5 Flash direct key-art/scene text-to-video. Submission,
  // verification, and download are separate resumable phases backed by Turso.
  agnesAccounts,
  // Backward-compatible flat view for standalone helpers. Production scene
  // scheduling uses the account metadata above and one client per account.
  agnesApiKeys: agnesAccounts.map(({ apiKey }) => apiKey),
  agnesBaseUrl: process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com",
  agnesRequestTimeoutMs: positiveInteger("AGNES_REQUEST_TIMEOUT_MS", 60_000),
  agnesPollIntervalMs: positiveInteger("AGNES_POLL_INTERVAL_MS", 30_000),
  agnesPollWindowMs: positiveInteger("AGNES_POLL_WINDOW_MS", 8 * 60_000),
  agnesQueuePollIntervalMs: positiveInteger("AGNES_QUEUE_POLL_INTERVAL_MS", 30_000),
  agnesQueuePollWindowMs: positiveInteger("AGNES_QUEUE_POLL_WINDOW_MS", 5 * 60_000),
  agnesSubmissionBatchSize: positiveInteger("AGNES_SUBMISSION_BATCH_SIZE", 2),
  agnesSubmissionRpmPerAccount: positiveInteger("AGNES_SUBMISSION_RPM_PER_ACCOUNT", 2),
  agnesStatusRpmPerAccount: positiveInteger("AGNES_STATUS_RPM_PER_ACCOUNT", 2),
  agnesMaxDownloadBytes: positiveInteger("AGNES_MAX_DOWNLOAD_BYTES", 500_000_000),
  // An additional minimum beyond the per-account RPM gate. Zero adds no extra
  // delay; it does not disable durable per-account rate limiting.
  agnesSubmissionIntervalMs: nonNegativeInteger("AGNES_SUBMISSION_INTERVAL_MS", 0),
  agnesSeed: optionalInteger("AGNES_SEED"),

  // Cloudflare Workers AI model used for episode scene frames (fallback provider)
  cloudflareSceneModel: process.env.CLOUDFLARE_SCENE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell",
  cloudflareImg2ImgModel: process.env.CLOUDFLARE_IMG2IMG_MODEL ?? "@cf/runwayml/stable-diffusion-v1-5-img2img",
  sceneQaEditAttempts: Math.max(0, Number.parseInt(process.env.SCENE_QA_EDIT_ATTEMPTS ?? process.env.SCENE_QA_REGEN_ATTEMPTS ?? "2", 10) || 0),
  cloudflareImageAccounts: [1, 2, 3].flatMap((index) => {
    const accountId = process.env[`CLOUDFLARE_IMG2IMG_ACCOUNT_ID_${index}`];
    const apiToken = process.env[`CLOUDFLARE_IMG2IMG_API_TOKEN_${index}`];
    return accountId && apiToken ? [{ accountId, apiToken }] : [];
  }),

  outputDir: path.resolve(process.env.OUTPUT_DIR ?? path.join(projectRoot, "output")),
  assetsDir: path.resolve(process.env.ASSETS_DIR ?? path.join(projectRoot, "assets")),
  ffmpegPath: process.env.FFMPEG_PATH ?? ffmpegInstaller.path,
  ffprobePath: process.env.FFPROBE_PATH ?? ffprobeInstaller.path,

  // Subtitle burn-in toggle: if false (default), videos are created clean without hardcoded subtitles.
  // When false, YouTube uses its automatic/uploaded closed captions (CC).
  burnSubtitles: process.env.BURN_SUBTITLES === "true",

  // YouTube Data API v3 credentials for video upload
  // Obtain from Google Cloud Console: https://console.cloud.google.com/apis/credentials
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID ?? "",
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
  youtubeRefreshToken: process.env.YOUTUBE_REFRESH_TOKEN ?? "",
};

/** Throws with a clear message if any required config is missing before a run starts. */
export function validateProjectConfig(): void {
  CONFIG.neonDatabaseUrl();
  CONFIG.tursoDatabaseUrl();
}
