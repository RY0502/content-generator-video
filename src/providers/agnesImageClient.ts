import { CONFIG } from "../config.js";

export const DEFAULT_AGNES_IMAGE_MODEL = "agnes-image-2.5-flash";

export class AgnesImageClientError extends Error {
  constructor(message: string, readonly status?: number, readonly keyLabel?: string) {
    super(message);
    this.name = "AgnesImageClientError";
  }
}

export class AgnesImageAllKeysFailedError extends Error {
  constructor(message: string, readonly errors: Array<{ keyLabel: string; error: string }>) {
    super(message);
    this.name = "AgnesImageAllKeysFailedError";
  }
}

export interface AgnesImageOptions {
  model?: string;
  size?: "1K" | "2K" | "3K" | "4K" | string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
  n?: number;
  apiKeys?: readonly string[];
  accounts?: Array<{ accountId: string; apiKey: string; keyLabel?: string }>;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface AgnesImageResult {
  bytes: Buffer;
  url: string;
  model: string;
  keyLabel?: string;
}

interface AgnesImageResponseData {
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  created?: number;
  task_id?: string;
  error?: {
    message?: string;
    code?: string;
  };
}

let rotatingKeyCursor = 0;

/**
 * Executes an image generation call against the Agnes OpenAI-compatible image endpoint:
 * POST /v1/images/generations with model `agnes-image-2.5-flash`.
 * Rotates across configured Agnes keys/accounts upon failure or sequentially.
 */
export async function generateAgnesImage(
  prompt: string,
  options: AgnesImageOptions = {},
): Promise<AgnesImageResult> {
  const model = options.model || CONFIG.agnesImageModel || DEFAULT_AGNES_IMAGE_MODEL;
  const baseUrl = (options.baseUrl || CONFIG.agnesBaseUrl || "https://apihub.agnes-ai.com").replace(/\/+$/gu, "");
  const versionedBaseUrl = /\/v1$/iu.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
  const endpoint = `${versionedBaseUrl}/images/generations`;
  const timeoutMs = options.timeoutMs ?? CONFIG.agnesRequestTimeoutMs ?? 60_000;

  // Resolve keys/accounts to rotate across
  let configuredAccounts: Array<{ accountId: string; apiKey: string; keyLabel: string }>;
  if (options.accounts && options.accounts.length > 0) {
    configuredAccounts = options.accounts.map((a, i) => ({
      accountId: a.accountId,
      apiKey: a.apiKey,
      keyLabel: a.keyLabel || `account-${i + 1}`,
    }));
  } else if (options.apiKeys && options.apiKeys.length > 0) {
    configuredAccounts = options.apiKeys.map((key, i) => ({
      accountId: `key-${i + 1}`,
      apiKey: key,
      keyLabel: `key-${i + 1}`,
    }));
  } else if (CONFIG.agnesAccounts && CONFIG.agnesAccounts.length > 0) {
    configuredAccounts = CONFIG.agnesAccounts.map((a) => ({
      accountId: a.accountId,
      apiKey: a.apiKey,
      keyLabel: a.keyLabel || a.accountId,
    }));
  } else if (CONFIG.agnesApiKeys && CONFIG.agnesApiKeys.length > 0) {
    configuredAccounts = CONFIG.agnesApiKeys.map((key, i) => ({
      accountId: `key-${i + 1}`,
      apiKey: key,
      keyLabel: `key-${i + 1}`,
    }));
  } else {
    throw new AgnesImageClientError("No Agnes API keys configured for image generation.");
  }

  const payload: Record<string, unknown> = {
    model,
    prompt,
    n: options.n ?? 1,
    size: options.size ?? "1K",
    aspect_ratio: options.aspectRatio ?? "1:1",
  };

  const keyCount = configuredAccounts.length;
  const startIndex = rotatingKeyCursor % keyCount;
  rotatingKeyCursor = (rotatingKeyCursor + 1) % keyCount;

  const failureLog: Array<{ keyLabel: string; error: string }> = [];

  for (let attempt = 0; attempt < keyCount; attempt++) {
    const accountIndex = (startIndex + attempt) % keyCount;
    const account = configuredAccounts[accountIndex]!;
    const { apiKey, keyLabel } = account;

    if (!apiKey) continue;

    console.log(`[AgnesImage] Attempting image generation with account ${keyLabel} (model: ${model})...`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const responseText = await response.text();
      let data: AgnesImageResponseData | undefined;
      try {
        data = JSON.parse(responseText) as AgnesImageResponseData;
      } catch {
        // Response wasn't valid JSON
      }

      if (!response.ok) {
        const errorMsg = data?.error?.message || responseText.slice(0, 300) || `HTTP ${response.status}`;
        console.warn(`[AgnesImage] Key ${keyLabel} returned HTTP ${response.status}: ${errorMsg}`);
        failureLog.push({ keyLabel, error: `HTTP ${response.status}: ${errorMsg}` });
        continue;
      }

      const imageUrl = data?.data?.[0]?.url;
      const b64Json = data?.data?.[0]?.b64_json;

      if (b64Json) {
        const bytes = Buffer.from(b64Json, "base64");
        console.log(`[AgnesImage] ✓ Image generated successfully on ${keyLabel} (${bytes.length} bytes base64)`);
        return {
          bytes,
          url: imageUrl || "",
          model,
          keyLabel,
        };
      }

      if (imageUrl) {
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) {
          throw new AgnesImageClientError(
            `Failed to download generated image from ${imageUrl}: HTTP ${imageRes.status}`,
            imageRes.status,
            keyLabel,
          );
        }
        const bytes = Buffer.from(await imageRes.arrayBuffer());
        if (bytes.length === 0) {
          throw new AgnesImageClientError("Downloaded empty image buffer from Agnes output URL", 0, keyLabel);
        }
        console.log(`[AgnesImage] ✓ Image generated and downloaded from ${keyLabel} (${bytes.length} bytes)`);
        return {
          bytes,
          url: imageUrl,
          model,
          keyLabel,
        };
      }

      throw new AgnesImageClientError("Agnes response contained neither url nor b64_json", response.status, keyLabel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[AgnesImage] Key ${keyLabel} failed: ${message}`);
      failureLog.push({ keyLabel, error: message });
    }
  }

  const summary = failureLog.map((f) => `[${f.keyLabel}: ${f.error}]`).join(", ");
  throw new AgnesImageAllKeysFailedError(
    `Agnes image generation failed on all ${keyCount} keys: ${summary}`,
    failureLog,
  );
}
