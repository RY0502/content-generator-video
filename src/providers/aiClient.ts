import {
  createProviders,
  defaultClassify,
  defaultLogger,
  FreeTierOrchestrator,
  ErrorKind,
  type LlmInput,
  type Logger,
  type OrchestratorOptions,
  type Provider,
  type ProviderStatus,
} from "@freetier/orchestrator";
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

type StructuredNarrationInvocation = LlmInput & {
  /**
   * Kept inside the local orchestrator state. The validating provider strips
   * this function before it delegates to the remote provider.
   */
  parse: (raw: string) => unknown;
};

class InvalidNarrationRepairOutputError extends Error {
  constructor(providerName: string) {
    super(`${providerName} returned an incomplete or invalid narration-repair response.`);
    this.name = "InvalidNarrationRepairOutputError";
  }
}

function isCloudflareProvider(provider: Provider<LlmInput, string>): boolean {
  return /^cloudflare(?:\s+#\d+)?$/iu.test(provider.name.trim());
}

function isNvidiaProvider(provider: Provider<LlmInput, string>): boolean {
  return /^nvidia(?:\s+#\d+)?$/iu.test(provider.name.trim());
}

function providerInstanceNumber(provider: Provider<LlmInput, string>): number {
  const match = provider.name.trim().match(/#(\d+)$/u);
  return match ? Number(match[1]) : 1;
}

class NarrationRepairProvider implements Provider<StructuredNarrationInvocation, unknown> {
  readonly name: string;

  constructor(private readonly provider: Provider<LlmInput, string>) {
    this.name = provider.name;
  }

  async invoke(input: StructuredNarrationInvocation): Promise<unknown> {
    const raw = await this.provider.invoke({
      system: input.system,
      prompt: input.prompt,
      ...(input.imageBase64 === undefined ? {} : { imageBase64: input.imageBase64 }),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });

    try {
      return input.parse(raw);
    } catch {
      // Never attach the raw model output or parser error. Besides keeping
      // diagnostics compact, this prevents a malformed response from leaking
      // a large partial script into logs or the parent agent transcript.
      throw new InvalidNarrationRepairOutputError(this.name);
    }
  }

  classifyError(error: unknown): ErrorKind | undefined {
    if (error instanceof InvalidNarrationRepairOutputError) {
      // The orchestrator has no separate "advance immediately" classification.
      // Quota gives the required behavior without retrying the same deterministic
      // malformed response. This orchestrator is isolated, so the cooldown does
      // not suppress the provider in ordinary text or vision workflows.
      return ErrorKind.Quota;
    }
    const delegated = this.provider.classifyError?.(error);
    if (delegated !== undefined && delegated !== ErrorKind.Fatal) return delegated;

    // A bad/expired account, provider-specific request rejection, or unsupported
    // model must not prevent the isolated repair pool from reaching the next
    // configured account/family. This does not affect the main agent or any
    // general text/vision call because only the tiny narration repair is wrapped.
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    } | null;
    const status = typeof candidate?.status === "number"
      ? candidate.status
      : typeof candidate?.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate?.response?.status === "number"
          ? candidate.response.status
          : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const messageStatusMatch = message.match(/\((\d{3})\)/u);
    const messageStatus = messageStatusMatch ? Number(messageStatusMatch[1]) : undefined;
    if (
      (status !== undefined && status >= 400 && status < 500)
      || (
        status === undefined
        && message.toLocaleLowerCase().startsWith(`${this.name.toLocaleLowerCase()} api error`)
        && (messageStatus === undefined || (messageStatus >= 400 && messageStatus < 500))
      )
    ) {
      return ErrorKind.Quota;
    }
    return delegated;
  }
}

export interface NarrationRepairOrchestrator {
  invoke(input: StructuredNarrationInvocation): Promise<unknown>;
  getCurrentProvider(): string;
  getStatus(): ProviderStatus[];
}

/**
 * A strict-priority dispatcher for the very small narration-repair pool.
 *
 * FreeTierOrchestrator intentionally makes its last successful provider the
 * sticky default. That is useful for general workloads but would mean one
 * NVIDIA fallback silently became the first choice for every later repair.
 * This dispatcher retains timestamp-based account cooldowns while beginning
 * each independent repair at the first eligible Cloudflare account.
 */
class PriorityNarrationRepairOrchestrator implements NarrationRepairOrchestrator {
  private readonly cooldownUntil: number[];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly cooldownMs: number;
  private readonly logger: Logger;
  private lastSuccessfulIndex = 0;

  constructor(
    private readonly providers: Provider<StructuredNarrationInvocation, unknown>[],
    options: OrchestratorOptions,
  ) {
    this.cooldownUntil = providers.map(() => 0);
    this.maxRetries = options.retry?.maxRetries ?? 0;
    this.retryDelayMs = options.retry?.retryDelayMs ?? 0;
    this.cooldownMs = options.cooldown?.cooldownMs ?? 120_000;
    this.logger = options.logger ?? defaultLogger;
    this.logger.info(
      `[Narration-Repair] Initialized strict priority: ${providers.map(({ name }) => name).join(", ")}`,
    );
  }

  async invoke(input: StructuredNarrationInvocation): Promise<unknown> {
    let lastError: string | undefined;

    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index]!;
      if (Date.now() < this.cooldownUntil[index]!) {
        this.logger.info(`[Narration-Repair] Provider "${provider.name}" is in cooldown, skipping.`);
        continue;
      }

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        this.logger.info(
          `[Narration-Repair] Calling "${provider.name}" ` +
          `(attempt ${attempt + 1}/${this.maxRetries + 1}).`,
        );
        try {
          const output = await provider.invoke(input);
          this.cooldownUntil[index] = 0;
          this.lastSuccessfulIndex = index;
          this.logger.info(`[Narration-Repair] Provider "${provider.name}" succeeded.`);
          return output;
        } catch (error) {
          const kind = provider.classifyError?.(error) ?? defaultClassify(error);
          lastError = error instanceof Error ? error.message : String(error);

          if (kind === ErrorKind.Retryable && attempt < this.maxRetries) {
            this.logger.warn(
              `[Narration-Repair] Provider "${provider.name}" transient error, retrying: ${lastError}`,
            );
            if (this.retryDelayMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
            }
            continue;
          }

          if (kind === ErrorKind.Fatal) {
            this.logger.error(
              `[Narration-Repair] Provider "${provider.name}" fatal error: ${lastError}`,
            );
            throw new Error(
              `[Narration-Repair] Provider "${provider.name}" failed with a non-recoverable error: ${lastError}`,
            );
          }

          if (kind === ErrorKind.Quota) {
            this.cooldownUntil[index] = Date.now() + this.cooldownMs;
            this.logger.warn(
              `[Narration-Repair] Provider "${provider.name}" is cooling down; advancing: ${lastError}`,
            );
          } else {
            this.logger.warn(
              `[Narration-Repair] Provider "${provider.name}" transient error exhausted; advancing: ${lastError}`,
            );
          }
          break;
        }
      }
    }

    throw new Error(
      `[Narration-Repair] All ${this.providers.length} provider(s) exhausted ` +
      `(${this.providers.map(({ name }) => name).join(", ")}). ` +
      `Last error: ${lastError ?? "all eligible accounts are cooling down"}`,
    );
  }

  getCurrentProvider(): string {
    return this.providers[this.lastSuccessfulIndex]!.name;
  }

  getStatus(): ProviderStatus[] {
    const now = Date.now();
    return this.providers.map((provider, index) => ({
      provider: provider.name,
      inCooldown: now < this.cooldownUntil[index]!,
      cooldownMsRemaining: Math.max(0, this.cooldownUntil[index]! - now),
    }));
  }
}

/**
 * The only production script rewrite still delegated to a model is a tiny,
 * narration-only shortening response. Cloudflare is deliberately first for
 * this small payload, followed by NVIDIA; unrelated providers are excluded so
 * the fallback order cannot drift when the framework's general pool changes.
 */
export function buildNarrationRepairOrchestrator(
  providers: Provider<LlmInput, string>[],
  options: OrchestratorOptions = {},
): NarrationRepairOrchestrator {
  const byInstance = (
    left: Provider<LlmInput, string>,
    right: Provider<LlmInput, string>,
  ): number => providerInstanceNumber(left) - providerInstanceNumber(right);
  const cloudflareProviders = providers.filter(isCloudflareProvider).sort(byInstance);
  const nvidiaProviders = providers.filter(isNvidiaProvider).sort(byInstance);
  const eligibleProviders = [...cloudflareProviders, ...nvidiaProviders]
    .map((provider) => new NarrationRepairProvider(provider));

  if (eligibleProviders.length === 0) {
    throw new Error(
      "Narration repair requires at least one Cloudflare or NVIDIA text provider.",
    );
  }

  return new PriorityNarrationRepairOrchestrator(eligibleProviders, {
    ...options,
    retry: {
      maxRetries: options.retry?.maxRetries ?? 0,
      retryDelayMs: options.retry?.retryDelayMs ?? 0,
    },
  });
}

let narrationRepairOrchestrator: NarrationRepairOrchestrator | undefined;

function getNarrationRepairOrchestrator(): NarrationRepairOrchestrator {
  if (!narrationRepairOrchestrator) {
    narrationRepairOrchestrator = buildNarrationRepairOrchestrator(
      createProviders("text"),
    );
  }
  return narrationRepairOrchestrator;
}

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
 * Structured call reserved for shortening one measured-overlong narration.
 * Its deliberately tiny schema fits Cloudflare's response budget; NVIDIA is
 * the ordered fallback when Cloudflare is unavailable or returns invalid JSON.
 */
export async function chatStructuredNarrationRepair<T>(params: {
  systemPrompt: string;
  userText: string;
  parse: (raw: string) => T;
}): Promise<T> {
  try {
    return await getNarrationRepairOrchestrator().invoke({
      system: params.systemPrompt,
      prompt: params.userText,
      parse: params.parse,
    }) as T;
  } catch (error) {
    console.error("[chatStructuredNarrationRepair] Provider rotation failed:", error);
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
