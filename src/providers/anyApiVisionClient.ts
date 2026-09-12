import {
  CONFIG,
  isIncompatibleAnyApiVideoQaModel,
  resolveAnyApiVideoQaModel,
} from "../config.js";
import { createHash } from "node:crypto";
import {
  AnyApiModelBusyError,
  AnyApiNetworkError,
  AnyApiQuotaExhaustedError,
  AnyApiRateLimitError,
} from "./anyApiImageClient.js";

export interface AnyApiVisionImage {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  label: string;
}

export interface AnyApiVisionAnalysisParams {
  systemPrompt: string;
  userText: string;
  images: readonly AnyApiVisionImage[];
  model?: string;
}

export interface AnyApiVisionClientOptions {
  apiKeys?: readonly string[];
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  retriesPerKey?: number;
  /** Override production's conservative per-key request-start spacing. */
  requestIntervalMs?: number;
}

class AnyApiAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyApiAccessDeniedError";
  }
}

/** A deterministic payload/model rejection that cannot be repaired by rotating credentials. */
export class AnyApiRequestRejectedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AnyApiRequestRejectedError";
    this.status = status;
  }
}

function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === "object"
      && typeof parsed.error.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // The HTTP status remains authoritative when the body is not JSON.
  }
  return body.trim().slice(0, 500) || "Unknown AnyAPI error";
}

function classifyResponseError(status: number, statusText: string, body: string): Error {
  const message = errorMessageFromBody(body);
  const normalized = message.toLowerCase();
  if (status === 429 || normalized.includes("rate limit")) {
    return new AnyApiRateLimitError(`Rate limit exceeded: ${message}`);
  }
  if (
    status === 402
    || normalized.includes("quota")
    || normalized.includes("insufficient")
    || normalized.includes("credit")
  ) {
    return new AnyApiQuotaExhaustedError(`Quota exhausted: ${message}`);
  }
  if (status === 401 || status === 403) {
    return new AnyApiAccessDeniedError(`AnyAPI authentication/access denied: ${message}`);
  }
  if (status === 503 || normalized.includes("busy") || normalized.includes("overloaded")) {
    return new AnyApiModelBusyError(`Model busy: ${message}`);
  }
  if (status === 400 || status === 404 || status === 405 || status === 413 || status === 415 || status === 422) {
    return new AnyApiRequestRejectedError(
      status,
      `AnyAPI rejected the vision request (${status} ${statusText}): ${message}`,
    );
  }
  return new AnyApiNetworkError(`AnyAPI vision request failed (${status} ${statusText}): ${message}`);
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const value = part as { text?: unknown; content?: unknown };
    return typeof value.text === "string"
      ? value.text
      : typeof value.content === "string"
        ? value.content
        : "";
  }).join("").trim();
}

function safeLogError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/giu, "[url omitted]")
    .replace(/\b(?:bearer|authorization|api[-_ ]?key|token)\b\s*[:=]?\s*[^\s,;]+/giu, "credential=[redacted]")
    .slice(0, 300);
}

function normalizedAnyApiBaseUrl(rawValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error("ANYAPI_BASE_URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("ANYAPI_BASE_URL must use HTTPS because it receives credentials and private QA images.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("ANYAPI_BASE_URL must not contain credentials, query parameters, or a fragment.");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

let nextQaKeyIndex = 0;
const nextQaRequestAtByKey = new Map<string, number>();

async function waitForQaKeySlot(
  apiKey: string,
  intervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (intervalMs <= 0) return;
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  const now = Date.now();
  const slot = Math.max(now, nextQaRequestAtByKey.get(fingerprint) ?? 0);
  nextQaRequestAtByKey.set(fingerprint, slot + intervalMs);
  if (slot > now) await sleep(slot - now);
}

/**
 * Sends a structured multi-image vision request through AnyAPI. Calls rotate
 * across configured keys even after success so an episode-level QA pass does
 * not concentrate its roughly 20 requests on one account.
 */
export async function analyzeImagesWithAnyApi(
  params: AnyApiVisionAnalysisParams,
  options: AnyApiVisionClientOptions = {},
): Promise<string> {
  const apiKeys = [...(options.apiKeys ?? CONFIG.anyApiKeys)].filter(Boolean);
  if (apiKeys.length === 0) {
    throw new Error("No AnyAPI keys configured for Agnes video QA.");
  }
  if (params.images.length === 0) throw new Error("AnyAPI video QA requires at least one image.");
  const configuredModel = params.model?.trim() || CONFIG.anyApiVideoQaModel;
  if (isIncompatibleAnyApiVideoQaModel(configuredModel)) {
    throw new AnyApiRequestRejectedError(
      400,
      `AnyAPI model ${JSON.stringify(configuredModel)} is not supported by the documented Agnes contact-sheet ` +
      `vision-analysis chat contract. Use ${JSON.stringify(CONFIG.anyApiVideoQaModel)}.`,
    );
  }
  const model = resolveAnyApiVideoQaModel(configuredModel);
  const baseUrl = normalizedAnyApiBaseUrl(options.baseUrl ?? CONFIG.anyApiBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const retriesPerKey = Math.max(1, Math.min(3, options.retriesPerKey ?? 2));
  const timeoutMs = options.requestTimeoutMs ?? CONFIG.videoQaRequestTimeoutMs;
  const requestIntervalMs = options.requestIntervalMs
    ?? Math.ceil(60_000 / CONFIG.videoQaAnyApiRpmPerKey);
  let lastError: Error | null = null;

  for (let keyOffset = 0; keyOffset < apiKeys.length; keyOffset++) {
    const keyIndex = (nextQaKeyIndex + keyOffset) % apiKeys.length;
    const apiKey = apiKeys[keyIndex]!;
    let maxTokens = 8_192;
    for (let attempt = 1; attempt <= retriesPerKey; attempt++) {
      await waitForQaKeySlot(apiKey, requestIntervalMs, sleep);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        console.log("[AgnesVideoQA] anyapi_analysis_start", {
          model,
          keySlot: keyIndex + 1,
          keyCount: apiKeys.length,
          imageCount: params.images.length,
          attempt,
          maxTokens,
        });
        const content: Array<Record<string, unknown>> = [
          { type: "text", text: params.userText },
        ];
        for (const image of params.images) {
          content.push({ type: "text", text: `IMAGE: ${image.label}` });
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
            },
          });
        }
        const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            stream: false,
            // Gemini 3.1 reasoning is counted inside some OpenAI-compatible
            // routing budgets. Leave enough room for thinking plus the small
            // visible QA verdict so a valid JSON object is not cut in half.
            max_tokens: maxTokens,
            // This is a bounded classification/extraction task. Low thinking
            // preserves the Pro model's visual capability without allowing
            // hidden reasoning to consume the whole completion budget.
            thinking_level: "low",
            // AnyAPI's Gemini 3.1 adapter accepts json_object but currently
            // rejects the generic json_schema envelope with HTTP 400. The
            // complete schema is enforced locally before any verdict persists.
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: params.systemPrompt },
              { role: "user", content },
            ],
          }),
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) throw classifyResponseError(response.status, response.statusText, body);
        let parsed: { choices?: Array<{ message?: unknown; finish_reason?: unknown }> };
        try {
          parsed = JSON.parse(body) as {
            choices?: Array<{ message?: unknown; finish_reason?: unknown }>;
          };
        } catch {
          throw new AnyApiNetworkError(`AnyAPI vision returned invalid JSON: ${body.slice(0, 300)}`);
        }
        const choice = parsed.choices?.[0];
        const output = messageText(choice?.message);
        if (!output) throw new AnyApiNetworkError("AnyAPI vision returned an empty analysis response.");
        if (choice?.finish_reason === "length") {
          console.warn("[AgnesVideoQA] anyapi_analysis_length_limited", {
            model,
            keySlot: keyIndex + 1,
            outputChars: output.length,
            maxTokens,
            action: attempt < retriesPerKey
              ? "retry_with_larger_completion_budget"
              : "strict_local_parse_before_use",
          });
          if (attempt < retriesPerKey) {
            maxTokens = 16_384;
            continue;
          }
        } else if (choice?.finish_reason !== "stop") {
          throw new AnyApiRequestRejectedError(
            422,
            `AnyAPI vision returned a non-terminal or incomplete finish_reason: ${JSON.stringify(choice?.finish_reason ?? null)}.`,
          );
        }
        nextQaKeyIndex = (keyIndex + 1) % apiKeys.length;
        console.log("[AgnesVideoQA] anyapi_analysis_complete", {
          model,
          keySlot: keyIndex + 1,
          outputChars: output.length,
        });
        return output;
      } catch (error) {
        const normalizedError = error instanceof Error && error.name === "AbortError"
          ? new AnyApiNetworkError(`AnyAPI vision request timed out after ${timeoutMs}ms.`)
          : error instanceof Error ? error : new Error(String(error));
        lastError = normalizedError;
        console.warn("[AgnesVideoQA] anyapi_analysis_error", {
          keySlot: keyIndex + 1,
          attempt,
          error: safeLogError(normalizedError),
        });
        if (normalizedError instanceof AnyApiRequestRejectedError) {
          console.warn("[AgnesVideoQA] anyapi_request_rejected", {
            model,
            status: normalizedError.status,
            retryable: false,
            keyRotationUseful: false,
          });
          throw normalizedError;
        }
        const failoverReason = normalizedError instanceof AnyApiRateLimitError
          ? "rate_limit"
          : normalizedError instanceof AnyApiQuotaExhaustedError
            ? "quota_exhausted"
            : normalizedError instanceof AnyApiAccessDeniedError
              ? "access_denied"
              : null;
        if (failoverReason) {
          const hasNextKey = keyOffset + 1 < apiKeys.length;
          console.warn("[AgnesVideoQA] anyapi_key_failover", {
            fromKeySlot: keyIndex + 1,
            nextKeySlot: hasNextKey ? ((keyIndex + 1) % apiKeys.length) + 1 : null,
            reason: failoverReason,
          });
          break;
        }
        if (attempt < retriesPerKey) await sleep(2_000 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  nextQaKeyIndex = (nextQaKeyIndex + 1) % apiKeys.length;
  throw lastError ?? new Error("AnyAPI video QA failed for every configured key.");
}
