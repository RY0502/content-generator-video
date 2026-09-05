import { createProviders, FreeTierOrchestrator, ErrorKind, type Provider, type LlmInput } from "@freetier/orchestrator";
import { CONFIG } from "../config.js";

/**
 * OpenAI-compatible Provider for Requesty (vision only)
 * conforming to @freetier/orchestrator's Provider interface
 * so it can be dropped into the same rotation/cooldown machinery as the
 * framework's built-in providers. Tried first for vision calls;
 * on quota/failure the orchestrator automatically falls through to other providers.
 */
class RequestyProvider implements Provider<LlmInput, string> {
  readonly name = "requesty";
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async invoke(input: LlmInput): Promise<string> {
    const content: unknown[] = [{ type: "text", text: input.prompt }];
    if (input.imageBase64) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${input.mimeType ?? "image/png"};base64,${input.imageBase64}` },
      });
    }

    const res = await fetch("https://router.requesty.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = new Error(`Requesty request failed (${res.status}): ${body.slice(0, 500)}`);
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  classifyError(error: unknown): ErrorKind | undefined {
    const status = (error as { status?: number })?.status;
    if (status === 429 || status === 402) return ErrorKind.Quota;
    return undefined;
  }
}

/**
 * Minimal OpenAI-compatible Provider (text + vision via `image_url` content)
 * for OpenRouter, conforming to @freetier/orchestrator's Provider interface
 * so it can be dropped into the same rotation/cooldown machinery as the
 * framework's built-in Groq/HuggingFace/NVIDIA/SambaNova/Cerebras/Cloudflare
 * providers. Tried after Requesty (per project requirement to use OpenRouter's free
 * nemotron-omni model for judging/reasoning calls); on quota/failure the
 * orchestrator automatically falls through to those other free-tier providers.
 */
class OpenRouterProvider implements Provider<LlmInput, string> {
  readonly name = "openrouter";
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async invoke(input: LlmInput): Promise<string> {
    const content: unknown[] = [{ type: "text", text: input.prompt }];
    if (input.imageBase64) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${input.mimeType ?? "image/png"};base64,${input.imageBase64}` },
      });
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = new Error(`OpenRouter request failed (${res.status}): ${body.slice(0, 500)}`);
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  classifyError(error: unknown): ErrorKind | undefined {
    const status = (error as { status?: number })?.status;
    if (status === 429 || status === 402) return ErrorKind.Quota;
    return undefined;
  }
}

let orchestrator: FreeTierOrchestrator<LlmInput, string> | undefined;

/**
 * Shared orchestrator for every text/vision LLM call this project makes
 * outside of the main deep-agent loop itself (image-candidate judging, voice
 * selection reasoning). Requesty is tried first for vision calls (if configured);
 * then OpenRouter's free nemotron-omni model; on quota exhaustion or failure
 * it falls through to the framework's own free-tier provider rotation
 * (same keys as the main deep agent's sub-agents), so these calls share the
 * "keys get rotated" behavior end-to-end.
 */
function getOrchestrator(): FreeTierOrchestrator<LlmInput, string> {
  if (!orchestrator) {
    const providers: Provider<LlmInput, string>[] = [];
    // Add Requesty provider first if available (vision only)
    // if (process.env.VISION_REQUESTY_KEY && process.env.VISION_REQUESTY_MODEL) {
    //   providers.push(new RequestyProvider(process.env.VISION_REQUESTY_KEY, process.env.VISION_REQUESTY_MODEL));
    // }
    // Add OpenRouter provider if available
    // if (CONFIG.openRouterApiKeys.length > 0) {
    //   providers.push(new OpenRouterProvider(CONFIG.openRouterApiKeys[0], CONFIG.openRouterJudgeModel));
    // }
    providers.push(...createProviders("vision"));
    if (providers.length === 0) {
      throw new Error(
        "No AI providers configured: set VISION_REQUESTY_KEY+VISION_REQUESTY_MODEL, OPENROUTER_API_KEY, or any of the @freetier/orchestrator provider keys."
      );
    }
    orchestrator = new FreeTierOrchestrator(providers);
  }
  return orchestrator;
}

/** Plain text reasoning call (e.g. voice selection). */
export async function chatText(params: { systemPrompt: string; userText: string }): Promise<string> {
  try {
    return await getOrchestrator().invoke({ system: params.systemPrompt, prompt: params.userText });
  } catch (error) {
    console.error("[chatText] Error during orchestrator invoke:", error);
    throw error;
  }
}

/**
 * Vision call over one or more images, encoded as base64. Only the first
 * image is sent (LlmInput supports a single imageBase64) -- when judging
 * multiple candidates, callers should build one combined prompt/image or
 * call this once per candidate and compare scores; see characterSheetTool.
 */
export async function chatVision(params: {
  systemPrompt: string;
  userText: string;
  imageBase64: string;
  mimeType?: string;
}): Promise<string> {
  try {
    return await getOrchestrator().invoke({
      system: params.systemPrompt,
      prompt: params.userText,
      imageBase64: params.imageBase64,
      mimeType: params.mimeType ?? "image/png",
    });
  } catch (error) {
    console.error("[chatVision] Error during orchestrator invoke:", error);
    throw error;
  }
}

let frameworkOnlyOrchestrator: FreeTierOrchestrator<LlmInput, string> | undefined;

/**
 * Same shared free-tier provider rotation the framework's own sub-agents use
 * (createProviders()). Used for calls that should stick to the framework's
 * default model rotation. The orchestrator will automatically try providers
 * in sequence if one fails (e.g., if Cloudflare returns empty, it tries HuggingFace).
 */
function getFrameworkOnlyOrchestrator(): FreeTierOrchestrator<LlmInput, string> {
  if (!frameworkOnlyOrchestrator) {
    const providers = createProviders();
    if (providers.length === 0) {
      throw new Error("No @freetier/orchestrator provider keys configured for the framework-only vision call.");
    }
    frameworkOnlyOrchestrator = new FreeTierOrchestrator(providers);
  }
  return frameworkOnlyOrchestrator;
}

/**
 * Vision call that uses the freetier-deepagent-framework's default provider
 * rotation (Cloudflare, HuggingFace, Groq, NVIDIA). The orchestrator
 * automatically tries providers in sequence if one fails. Used for character
 * detail-extraction vision calls.
 */
export async function chatVisionFrameworkOnly(params: {
  systemPrompt: string;
  userText: string;
  imageBase64: string;
  mimeType?: string;
}): Promise<string> {
  try {
    return await getFrameworkOnlyOrchestrator().invoke({
      system: params.systemPrompt,
      prompt: params.userText,
      imageBase64: params.imageBase64,
      mimeType: params.mimeType ?? "image/png",
    });
  } catch (error) {
    console.error("[chatVisionFrameworkOnly] Error during orchestrator invoke:", error);
    throw error;
  }
}

/**
 * Multi-image comparison call: sends ALL given images together in one
 * OpenAI-style content array to OpenRouter (which supports multi-image
 * vision input), so the judge model can directly compare candidates
 * side-by-side rather than scoring them independently. Rotates through
 * available OpenRouter API keys on quota exhaustion.
 */
export async function chatVisionCompare(params: {
  systemPrompt: string;
  userText: string;
  images: Array<{ base64: string; label: string; mimeType?: string }>;
}): Promise<string> {
  const apiKeys = CONFIG.openRouterApiKeys;

  if (apiKeys.length === 0) {
    throw new Error("At least one OPENROUTER_API_KEY is required for multi-image candidate comparison judging. Set OPENROUTER_API_KEY or OPENROUTER_API_KEY_2, etc.");
  }

  const content: unknown[] = [{ type: "text", text: params.userText }];
  for (const image of params.images) {
    content.push({ type: "text", text: `Candidate labeled "${image.label}":` });
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType ?? "image/png"};base64,${image.base64}` },
    });
  }

  let lastError: Error | null = null;

  for (const apiKey of apiKeys) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CONFIG.openRouterJudgeModel,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const error = new Error(`OpenRouter multi-image comparison failed (${res.status}): ${body.slice(0, 500)}`);
        
        // Check if it's a quota/rate limit error (402, 429)
        if (res.status === 402 || res.status === 429) {
          console.warn(`[OpenRouter] Key exhausted (${res.status}), trying next key...`);
          lastError = error;
          continue;
        }
        
        throw error;
      }

      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? "";
    } catch (error) {
      lastError = error as Error;
      // If it's not a quota error, throw immediately
      if (!(error as Error).message.includes("402") && !(error as Error).message.includes("429")) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("All OpenRouter API keys exhausted for multi-image comparison");
}
