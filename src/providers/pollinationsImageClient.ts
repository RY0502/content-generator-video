import { CONFIG } from "../config.js";

export class PollinationsNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollinationsNetworkError";
  }
}

export class PollinationsModelBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollinationsModelBusyError";
  }
}

export class PollinationsAllModelsFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollinationsAllModelsFailedError";
  }
}

export interface PollinationsImageResult {
  bytes: Buffer;
  model: string;
}

/**
 * Executes a single image generation request to the Pollinations API for a specific model.
 */
async function generateWithSpecificModel(
  prompt: string,
  model: string,
  width: number,
  height: number,
  seed?: number,
  timeoutMs: number = 35_000
): Promise<Buffer> {
  const encodedPrompt = encodeURIComponent(prompt);
  let url = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=${encodeURIComponent(model)}&width=${width}&height=${height}&nologo=true&enhance=true`;
  if (seed !== undefined) {
    url += `&seed=${seed}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "content-generator/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 503 || response.status === 429) {
      throw new PollinationsModelBusyError(`Pollinations API busy (${response.status}): ${errorText.slice(0, 300)}`);
    }
    throw new PollinationsNetworkError(`Pollinations API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new PollinationsNetworkError("Pollinations returned an empty image buffer");
  }

  return buffer;
}

/**
 * Generates an image using Pollinations with a 2-model failover strategy:
 * It tries Model 1 first. If Model 1 fails or errors, it tries the call with Model 2.
 * Returns the image buffer and the name of the model that succeeded.
 */
export async function generatePollinationsImageDetailed(
  prompt: string,
  model1: string = CONFIG.pollinationsModel1 ?? "flux",
  model2: string = CONFIG.pollinationsModel2 ?? "turbo",
  width: number = 1024,
  height: number = 1024,
  seed?: number
): Promise<PollinationsImageResult> {
  const primary = model1 || CONFIG.pollinationsModel1 || "flux";
  const fallback = model2 || CONFIG.pollinationsModel2 || "turbo";

  // Attempt 1: Try with primary model first
  console.log(`[Pollinations] Trying model 1: "${primary}" (${width}x${height})...`);
  try {
    const bytes = await generateWithSpecificModel(prompt, primary, width, height, seed);
    console.log(`[Pollinations] ✓ Image generated successfully with model 1: "${primary}" (${bytes.length} bytes)`);
    return { bytes, model: primary };
  } catch (model1Err) {
    const err1Message = model1Err instanceof Error ? model1Err.message : String(model1Err);
    console.warn(`[Pollinations] ⚠️ Model 1 ("${primary}") failed: ${err1Message}`);
    console.log(`[Pollinations] Switching and trying call with model 2: "${fallback}"...`);

    // Attempt 2: If model 1 doesn't work, try the call with second model
    try {
      const bytes = await generateWithSpecificModel(prompt, fallback, width, height, seed);
      console.log(`[Pollinations] ✓ Image generated successfully with fallback model 2: "${fallback}" (${bytes.length} bytes)`);
      return { bytes, model: fallback };
    } catch (model2Err) {
      const err2Message = model2Err instanceof Error ? model2Err.message : String(model2Err);
      console.error(`[Pollinations] ✗ Both models failed! Model 1 ("${primary}"): ${err1Message} | Model 2 ("${fallback}"): ${err2Message}`);
      throw new PollinationsAllModelsFailedError(
        `Pollinations image generation failed on both models. ` +
        `Model 1 ("${primary}"): ${err1Message}; Model 2 ("${fallback}"): ${err2Message}`
      );
    }
  }
}

/**
 * Main export for Pollinations image generation.
 * Supports the 2-model try-first-then-fallback strategy:
 * Tries model1 first; if it doesn't work, tries model2.
 * Returns a Buffer of the generated image.
 */
export async function generatePollinationsImage(
  prompt: string,
  model1: string = CONFIG.pollinationsModel1 ?? "flux",
  model2: string = CONFIG.pollinationsModel2 ?? "turbo",
  width: number = 1024,
  height: number = 1024,
  seed?: number
): Promise<Buffer> {
  const result = await generatePollinationsImageDetailed(prompt, model1, model2, width, height, seed);
  return result.bytes;
}
