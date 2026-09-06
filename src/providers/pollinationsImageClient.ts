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

async function generateWithPollinations(
  prompt: string,
  model: string = "flux",
  width: number = 1024,
  height: number = 1024
): Promise<Buffer> {
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=${model}&width=${width}&height=${height}&nologo=true&enhance=true`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "content-generator/1.0",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 503 || response.status === 429) {
          throw new PollinationsModelBusyError(`Pollinations API busy (${response.status}): ${errorText}`);
        }
        throw new PollinationsNetworkError(`Pollinations API error (${response.status}): ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length === 0) {
        throw new PollinationsNetworkError("Pollinations returned an empty image buffer");
      }

      console.log(`[Pollinations] ✓ Image generated successfully with ${model} (${buffer.length} bytes)`);
      return buffer;
    } catch (error) {
      lastError = error as Error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (error instanceof PollinationsModelBusyError) {
        if (attempt < 3) {
          console.warn(`[Pollinations] Attempt ${attempt}/3 failed (busy): ${errorMessage}, retrying in ${attempt * 5}s...`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
          continue;
        }
      } else if (error instanceof PollinationsNetworkError) {
        if (attempt < 3) {
          console.warn(`[Pollinations] Attempt ${attempt}/3 failed: ${errorMessage}, retrying in ${attempt * 2}s...`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
          continue;
        }
      }

      throw error;
    }
  }

  throw lastError || new Error("Pollinations image generation failed after 3 attempts");
}

export async function generatePollinationsImage(
  prompt: string,
  model: "flux" | "flux-realism" | "flux-anime" | "flux-3d" | "turbo" = "flux",
  width: number = 1024,
  height: number = 1024
): Promise<Buffer> {
  return generateWithPollinations(prompt, model, width, height);
}
