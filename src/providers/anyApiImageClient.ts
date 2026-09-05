import { CONFIG } from "../config.js";

interface AnyApiImageResponse {
  data: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

interface AnyApiErrorResponse {
  error: {
    message: string;
    type: string | null;
    param: string | null;
    code: string;
  };
}

export class AnyApiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyApiRateLimitError";
  }
}

export class AnyApiQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyApiQuotaExhaustedError";
  }
}

export class AnyApiNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyApiNetworkError";
  }
}

export class AnyApiModelBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyApiModelBusyError";
  }
}

async function generateWithAnyApiKey(
  prompt: string,
  apiKey: string,
  model: string = "google/gemini-3.1-flash-image",
  size: string = "1792x1024"
): Promise<Buffer> {
  // Extract key identifier for logging (first 8 chars + last 4 chars)
  const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";
  
  const response = await fetch("https://api.anyapi.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: prompt,
      model: model,
      n: 1,
      size: size,
      response_format: "b64_json",
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorData: AnyApiErrorResponse;
    try {
      errorData = JSON.parse(responseText) as AnyApiErrorResponse;
    } catch {
      throw new AnyApiNetworkError(`AnyAPI request failed: ${response.status} ${response.statusText}`);
    }

    const errorMessage = errorData.error?.message || responseText;
    const errorCode = errorData.error?.code || String(response.status);

    if (response.status === 429 || errorMessage.toLowerCase().includes("rate limit")) {
      console.warn(`[AnyAPI] Rate limit on key ${keyId}: ${errorMessage}`);
      throw new AnyApiRateLimitError(`Rate limit exceeded: ${errorMessage}`);
    }

    if (
      errorMessage.toLowerCase().includes("quota") ||
      errorMessage.toLowerCase().includes("insufficient") ||
      errorMessage.toLowerCase().includes("credit")
    ) {
      console.warn(`[AnyAPI] Quota exhausted on key ${keyId}: ${errorMessage}`);
      throw new AnyApiQuotaExhaustedError(`Quota exhausted: ${errorMessage}`);
    }

    if (
      errorMessage.toLowerCase().includes("busy") ||
      errorMessage.toLowerCase().includes("overloaded") ||
      response.status === 503
    ) {
      console.warn(`[AnyAPI] Model busy on key ${keyId}: ${errorMessage}`);
      throw new AnyApiModelBusyError(`Model busy: ${errorMessage}`);
    }

    console.warn(`[AnyAPI] Error on key ${keyId} (${errorCode}): ${errorMessage}`);
    throw new AnyApiNetworkError(`AnyAPI error (${errorCode}): ${errorMessage}`);
  }

  let result: AnyApiImageResponse;
  try {
    result = JSON.parse(responseText) as AnyApiImageResponse;
  } catch {
    throw new Error(`Invalid JSON response from AnyAPI: ${responseText}`);
  }

  if (!result.data || !result.data[0]) {
    console.warn(`[AnyAPI] Empty/invalid response on key ${keyId}: ${responseText.slice(0, 200)}`);
    throw new AnyApiNetworkError(`Invalid AnyAPI response structure (empty data array): ${responseText.slice(0, 200)}`);
  }

  const first = result.data[0];
  if (first.b64_json) {
    console.log(`[AnyAPI] ✓ Image generated successfully on key ${keyId}`);
    return Buffer.from(first.b64_json, "base64");
  }

  if (first.url) {
    console.log(`[AnyAPI] Fetching generated image from URL on key ${keyId}`);
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) throw new AnyApiNetworkError(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
    console.log(`[AnyAPI] ✓ Image generated and downloaded successfully on key ${keyId}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new AnyApiNetworkError(`Invalid AnyAPI response structure (no b64_json or url): ${responseText.slice(0, 200)}`);
}

/**
 * Extracts a base64-encoded image from an AnyAPI chat completion response.
 * Handles both message.images array (OpenAI multimodal format) and
 * message.content (markdown ![image](data:image/...) or direct data URIs).
 */
function extractImageFromChatResponse(message: any): Buffer | null {
  if (!message) return null;

  // 1. Check message.images array
  if (Array.isArray(message.images) && message.images.length > 0) {
    const url = message.images[0]?.image_url?.url || message.images[0]?.url || message.images[0];
    if (typeof url === "string") {
      const cleanB64 = url.replace(/^data:image\/\w+;base64,/, "");
      return Buffer.from(cleanB64, "base64");
    }
  }

  // 2. Check message.content
  const content = typeof message === "string" ? message : message.content;
  if (typeof content === "string") {
    const match = content.match(/!\[.*?\]\(data:image\/\w+;base64,([^)]+)\)/);
    if (match && match[1]) {
      return Buffer.from(match[1], "base64");
    }
    const dataUriMatch = content.match(/data:image\/\w+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch && dataUriMatch[1]) {
      return Buffer.from(dataUriMatch[1], "base64");
    }
  }

  return null;
}

/**
 * Classifies an AnyAPI error response and throws the appropriate typed error.
 */
function classifyAnyApiError(
  response: { ok: boolean; status: number; statusText: string },
  responseText: string,
  keyId: string,
  label: string,
): never {
  let errorData: AnyApiErrorResponse;
  try {
    errorData = JSON.parse(responseText) as AnyApiErrorResponse;
  } catch {
    throw new AnyApiNetworkError(`${label} request failed: ${response.status} ${response.statusText}`);
  }

  const errorMessage = errorData.error?.message || responseText;
  const errorCode = errorData.error?.code || String(response.status);

  if (response.status === 429 || errorMessage.toLowerCase().includes("rate limit")) {
    console.warn(`[AnyAPI] Rate limit on key ${keyId}: ${errorMessage}`);
    throw new AnyApiRateLimitError(`Rate limit exceeded: ${errorMessage}`);
  }

  if (
    errorMessage.toLowerCase().includes("quota") ||
    errorMessage.toLowerCase().includes("insufficient") ||
    errorMessage.toLowerCase().includes("credit")
  ) {
    console.warn(`[AnyAPI] Quota exhausted on key ${keyId}: ${errorMessage}`);
    throw new AnyApiQuotaExhaustedError(`Quota exhausted: ${errorMessage}`);
  }

  if (
    errorMessage.toLowerCase().includes("busy") ||
    errorMessage.toLowerCase().includes("overloaded") ||
    response.status === 503
  ) {
    console.warn(`[AnyAPI] Model busy on key ${keyId}: ${errorMessage}`);
    throw new AnyApiModelBusyError(`Model busy: ${errorMessage}`);
  }

  console.warn(`[AnyAPI] Error on key ${keyId} (${errorCode}): ${errorMessage}`);
  throw new AnyApiNetworkError(`AnyAPI error (${errorCode}): ${errorMessage}`);
}

/**
 * Edits an existing image via AnyAPI chat completions using Gemini's native
 * image editing capability. Sends the source image + correction prompt and
 * returns the edited image bytes.
 */
async function editWithAnyApiKey(params: {
  prompt: string;
  imageBytes: Buffer;
  apiKey: string;
  model?: string;
}): Promise<Buffer> {
  const { prompt, imageBytes, apiKey, model = CONFIG.anyApiModel } = params;
  const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";

  const base64Image = imageBytes.toString("base64");

  const response = await fetch("https://api.anyapi.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    classifyAnyApiError(response, responseText, keyId, "AnyAPI edit");
  }

  let result: { choices?: Array<{ message?: any }> };
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new AnyApiNetworkError(`Invalid JSON response from AnyAPI edit: ${responseText.slice(0, 200)}`);
  }

  const message = result.choices?.[0]?.message;
  if (!message) {
    console.warn(`[AnyAPI-Edit] Empty message on key ${keyId}: ${responseText.slice(0, 200)}`);
    throw new AnyApiNetworkError("AnyAPI edit returned empty message");
  }

  const imageBuffer = extractImageFromChatResponse(message);
  if (!imageBuffer || imageBuffer.length === 0) {
    console.warn(`[AnyAPI-Edit] No image found in response on key ${keyId}: ${responseText.slice(0, 200)}`);
    throw new AnyApiNetworkError("AnyAPI edit response did not contain an image");
  }

  console.log(`[AnyAPI-Edit] ✓ Image edited successfully on key ${keyId}`);
  return imageBuffer;
}

/**
 * Shared key index so parallel calls continue from the last working key
 * instead of always restarting from key 0.
 */
let currentKeyIndex = 0;

export async function generateAnyApiSceneImage(prompt: string, model?: string): Promise<Buffer> {
  const apiKeys = CONFIG.anyApiKeys;

  if (apiKeys.length === 0) {
    throw new Error("No AnyAPI keys configured");
  }

  let lastError: Error | null = null;
  let keysTriedCount = 0;

  // Try all keys starting from the current shared index, wrapping around
  while (keysTriedCount < apiKeys.length) {
    const keyIndex = currentKeyIndex % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";

    try {
      console.log(`[AnyAPI] Attempting with key ${keyIndex + 1}/${apiKeys.length} (${keyId})`);

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const buffer = await generateWithAnyApiKey(prompt, apiKey, model);
          if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            console.warn(`[AnyAPI] Empty buffer from key ${keyId} on attempt ${attempt}/3`);
            throw new AnyApiNetworkError("AnyAPI returned an empty image buffer");
          }
          return buffer;
        } catch (error) {
          if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
            throw error;
          }

          if (error instanceof AnyApiNetworkError || error instanceof AnyApiModelBusyError) {
            const msg = error instanceof Error ? error.message : String(error);
            if (attempt < 3) {
              console.warn(`[AnyAPI] Attempt ${attempt}/3 failed on key ${keyId}: ${msg}, retrying in 10s...`);
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              continue;
            }
            console.warn(`[AnyAPI] All 3 attempts failed on key ${keyId}: ${msg}`);
          }

          throw error;
        }
      }
    } catch (error) {
      lastError = error as Error;

      if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
        console.warn(`[AnyAPI] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) exhausted — advancing to next key`);
        currentKeyIndex = (keyIndex + 1) % apiKeys.length;
        keysTriedCount++;
        continue;
      }

      // Non-quota/rate-limit errors after all retries on this key — advance and try next key
      console.warn(`[AnyAPI] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) failed with non-quota error: ${(error as Error).message}`);
      currentKeyIndex = (keyIndex + 1) % apiKeys.length;
      keysTriedCount++;
      continue;
    }
  }

  if (lastError instanceof AnyApiRateLimitError || lastError instanceof AnyApiQuotaExhaustedError) {
    throw new Error(`All ${apiKeys.length} AnyAPI keys exhausted: ${lastError.message}`);
  }

  throw lastError || new Error("AnyAPI image generation failed after trying all keys");
}

/**
 * Edits an existing scene image via AnyAPI chat completions using Gemini's
 * native image editing. Sends the source image + a correction prompt and
 * returns the edited image. Rotates through configured API keys on
 * rate-limit / quota errors, same as generateAnyApiSceneImage.
 */
export async function editAnyApiSceneImage(params: {
  prompt: string;
  imageBytes: Buffer;
  model?: string;
}): Promise<Buffer> {
  const apiKeys = CONFIG.anyApiKeys;

  if (apiKeys.length === 0) {
    throw new Error("No AnyAPI keys configured for image editing");
  }

  let lastError: Error | null = null;
  let keysTriedCount = 0;

  while (keysTriedCount < apiKeys.length) {
    const keyIndex = currentKeyIndex % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";

    try {
      console.log(`[AnyAPI-Edit] Attempting edit with key ${keyIndex + 1}/${apiKeys.length} (${keyId})`);

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const buffer = await editWithAnyApiKey({
            prompt: params.prompt,
            imageBytes: params.imageBytes,
            apiKey,
            model: params.model,
          });
          if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            console.warn(`[AnyAPI-Edit] Empty buffer from key ${keyId} on attempt ${attempt}/3`);
            throw new AnyApiNetworkError("AnyAPI edit returned an empty image buffer");
          }
          return buffer;
        } catch (error) {
          if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
            throw error;
          }

          if (error instanceof AnyApiNetworkError || error instanceof AnyApiModelBusyError) {
            const msg = error instanceof Error ? error.message : String(error);
            if (attempt < 3) {
              console.warn(`[AnyAPI-Edit] Attempt ${attempt}/3 failed on key ${keyId}: ${msg}, retrying in 10s...`);
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              continue;
            }
            console.warn(`[AnyAPI-Edit] All 3 attempts failed on key ${keyId}: ${msg}`);
          }

          throw error;
        }
      }
    } catch (error) {
      lastError = error as Error;

      if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
        console.warn(`[AnyAPI-Edit] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) exhausted — advancing to next key`);
        currentKeyIndex = (keyIndex + 1) % apiKeys.length;
        keysTriedCount++;
        continue;
      }

      console.warn(`[AnyAPI-Edit] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) failed with non-quota error: ${(error as Error).message}`);
      currentKeyIndex = (keyIndex + 1) % apiKeys.length;
      keysTriedCount++;
      continue;
    }
  }

  if (lastError instanceof AnyApiRateLimitError || lastError instanceof AnyApiQuotaExhaustedError) {
    throw new Error(`All ${apiKeys.length} AnyAPI keys exhausted for image editing: ${lastError.message}`);
  }

  throw lastError || new Error("AnyAPI image editing failed after trying all keys");
}

/**
 * Edits an existing image using a reference image (e.g. series key art) via
 * AnyAPI chat completions. Sends the reference image first, then the scene
 * image, plus the correction prompt — so the model can align the scene's
 * character appearance to the canonical reference.
 */
async function editWithReferenceAnyApiKey(params: {
  prompt: string;
  imageBytes: Buffer;
  referenceImageBytes: Buffer;
  apiKey: string;
  model?: string;
}): Promise<Buffer> {
  const { prompt, imageBytes, referenceImageBytes, apiKey, model = CONFIG.anyApiModel } = params;
  const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";

  const base64Reference = referenceImageBytes.toString("base64");
  const base64Scene = imageBytes.toString("base64");

  const response = await fetch("https://api.anyapi.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Reference}`,
              },
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Scene}`,
              },
            },
          ],
        },
      ],
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    classifyAnyApiError(response, responseText, keyId, "AnyAPI ref-edit");
  }

  let result: { choices?: Array<{ message?: any }> };
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new AnyApiNetworkError(`Invalid JSON response from AnyAPI ref-edit: ${responseText.slice(0, 200)}`);
  }

  const message = result.choices?.[0]?.message;
  if (!message) {
    console.warn(`[AnyAPI-RefEdit] Empty message on key ${keyId}: ${responseText.slice(0, 200)}`);
    throw new AnyApiNetworkError("AnyAPI ref-edit returned empty message");
  }

  const imageBuffer = extractImageFromChatResponse(message);
  if (!imageBuffer || imageBuffer.length === 0) {
    console.warn(`[AnyAPI-RefEdit] No image found in response on key ${keyId}: ${responseText.slice(0, 200)}`);
    throw new AnyApiNetworkError("AnyAPI ref-edit response did not contain an image");
  }

  console.log(`[AnyAPI-RefEdit] ✓ Image edited with reference successfully on key ${keyId}`);
  return imageBuffer;
}

/**
 * Edits an existing scene image using a reference image (e.g. series key art)
 * via AnyAPI chat completions with Gemini's native image editing. Sends the
 * reference image + scene image + a correction prompt so the model can align
 * character appearance in the scene to the canonical reference. Rotates through
 * configured API keys on rate-limit / quota errors.
 */
export async function editAnyApiSceneImageWithReference(params: {
  prompt: string;
  imageBytes: Buffer;
  referenceImageBytes: Buffer;
  model?: string;
}): Promise<Buffer> {
  const apiKeys = CONFIG.anyApiKeys;

  if (apiKeys.length === 0) {
    throw new Error("No AnyAPI keys configured for reference-guided image editing");
  }

  let lastError: Error | null = null;
  let keysTriedCount = 0;

  while (keysTriedCount < apiKeys.length) {
    const keyIndex = currentKeyIndex % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    const keyId = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : "unknown";

    try {
      console.log(`[AnyAPI-RefEdit] Attempting ref-edit with key ${keyIndex + 1}/${apiKeys.length} (${keyId})`);

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const buffer = await editWithReferenceAnyApiKey({
            prompt: params.prompt,
            imageBytes: params.imageBytes,
            referenceImageBytes: params.referenceImageBytes,
            apiKey,
            model: params.model,
          });
          if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            console.warn(`[AnyAPI-RefEdit] Empty buffer from key ${keyId} on attempt ${attempt}/3`);
            throw new AnyApiNetworkError("AnyAPI ref-edit returned an empty image buffer");
          }
          return buffer;
        } catch (error) {
          if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
            throw error;
          }

          if (error instanceof AnyApiNetworkError || error instanceof AnyApiModelBusyError) {
            const msg = error instanceof Error ? error.message : String(error);
            if (attempt < 3) {
              console.warn(`[AnyAPI-RefEdit] Attempt ${attempt}/3 failed on key ${keyId}: ${msg}, retrying in 10s...`);
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              continue;
            }
            console.warn(`[AnyAPI-RefEdit] All 3 attempts failed on key ${keyId}: ${msg}`);
          }

          throw error;
        }
      }
    } catch (error) {
      lastError = error as Error;

      if (error instanceof AnyApiRateLimitError || error instanceof AnyApiQuotaExhaustedError) {
        console.warn(`[AnyAPI-RefEdit] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) exhausted — advancing to next key`);
        currentKeyIndex = (keyIndex + 1) % apiKeys.length;
        keysTriedCount++;
        continue;
      }

      console.warn(`[AnyAPI-RefEdit] Key ${keyIndex + 1}/${apiKeys.length} (${keyId}) failed with non-quota error: ${(error as Error).message}`);
      currentKeyIndex = (keyIndex + 1) % apiKeys.length;
      keysTriedCount++;
      continue;
    }
  }

  if (lastError instanceof AnyApiRateLimitError || lastError instanceof AnyApiQuotaExhaustedError) {
    throw new Error(`All ${apiKeys.length} AnyAPI keys exhausted for reference-guided image editing: ${lastError.message}`);
  }

  throw lastError || new Error("AnyAPI reference-guided image editing failed after trying all keys");
}
