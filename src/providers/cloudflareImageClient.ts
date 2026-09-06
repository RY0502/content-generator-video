import { CONFIG } from "../config.js";

function isRetryableStatus(status: number): boolean {
  return status === 400 || status === 408 || status === 429 || status >= 500;
}

/** Waits between retries without blocking the event loop. */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeJsonImage(payload: unknown): Buffer | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (typeof result === "string") return Buffer.from(result, "base64");
  if (result && typeof result === "object") {
    const image = (result as { image?: unknown }).image;
    if (typeof image === "string") return Buffer.from(image, "base64");
  }
  return null;
}

function normalizePrompt(prompt: string, maxChars: number = 2040): string {
  return prompt.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function postCloudflareImageRequest(params: {
  body: Record<string, unknown>;
  model: string;
  errorLabel: string;
}): Promise<Buffer> {
  if (CONFIG.cloudflareImageAccounts.length === 0) {
    throw new Error(
      "Cloudflare scene generation requires at least one complete CLOUDFLARE_IMG2IMG_ACCOUNT_ID_n and CLOUDFLARE_IMG2IMG_API_TOKEN_n pair."
    );
  }

  let lastError: unknown;
  for (const account of CONFIG.cloudflareImageAccounts) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${params.model}`;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params.body),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          lastError = new Error(
            `${params.errorLabel} failed (${response.status}): ${body.slice(0, 500)}`
          );
          if (isRetryableStatus(response.status) && attempt < 5) {
            await wait(5000);
            continue;
          }
          if (isRetryableStatus(response.status)) break;
          throw lastError;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const image = decodeJsonImage(await response.json());
          if (!image) throw new Error(`${params.errorLabel} returned JSON without image data.`);
          return image;
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
        if (error instanceof TypeError) continue;
        if (error instanceof Error) {
          const statusMatch = error.message.match(/failed \((\d+)\)/);
          if (!statusMatch || isRetryableStatus(Number(statusMatch[1]))) continue;
          throw error;
        }
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`All Cloudflare accounts failed for ${params.errorLabel}.`);
}

/**
 * Generates a scene image with Cloudflare Workers AI, rotating through the
 * configured account/token pairs after rate limits, server failures, or
 * network errors. Credentials are read only from environment configuration.
 */
export async function generateCloudflareSceneImage(prompt: string): Promise<Buffer> {
  // buildStylizedScenePrompt guarantees the prompt fits within its 2000-char
  // budget. This normalization is a safety net, capped at 2040 to stay well
  // under Cloudflare's documented 2048-character limit.
  const normalizedPrompt = normalizePrompt(prompt, 2040);
  if (!normalizedPrompt) throw new Error("Cloudflare scene generation requires a non-empty prompt.");
  return postCloudflareImageRequest({
    model: CONFIG.cloudflareSceneModel,
    errorLabel: `Cloudflare scene generation (prompt ${normalizedPrompt.length} chars)`,
    body: {
      prompt: normalizedPrompt,
      width: 1792,
      height: 1024,
    },
  });
}

export async function generateCloudflareSceneImageImg2Img(params: {
  prompt: string;
  referenceImageBytes: Buffer;
  strength?: number;
  seed?: number;
}): Promise<Buffer> {
  const normalizedPrompt = normalizePrompt(params.prompt, 2040);
  if (!normalizedPrompt) throw new Error("Cloudflare img2img generation requires a non-empty prompt.");
  if (!Buffer.isBuffer(params.referenceImageBytes) || params.referenceImageBytes.length === 0) {
    throw new Error("Cloudflare img2img generation requires a non-empty reference image.");
  }

  return postCloudflareImageRequest({
    model: CONFIG.cloudflareImg2ImgModel,
    errorLabel: `Cloudflare img2img generation (prompt ${normalizedPrompt.length} chars)`,
    body: {
      prompt: normalizedPrompt,
      image_b64: params.referenceImageBytes.toString("base64"),
      strength: params.strength ?? 0.4,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}
