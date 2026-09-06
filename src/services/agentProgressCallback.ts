import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";

export interface AgentProgressLogger {
  info(message: string, metadata: Record<string, unknown>): void;
  error(message: string, metadata: Record<string, unknown>): void;
}

export interface AgentProgressCallbackOptions {
  logger?: AgentProgressLogger;
  now?: () => number;
  /** Set to zero to disable periodic in-flight progress messages. */
  heartbeatMs?: number;
}

interface ActiveRun {
  startedAtMs: number;
  label: string;
  heartbeat?: NodeJS.Timeout;
}

const defaultLogger: AgentProgressLogger = {
  info: (message, metadata) => console.log(message, metadata),
  error: (message, metadata) => console.error(message, metadata),
};

function compactRunId(runId: string): string {
  return runId.slice(0, 8);
}

/**
 * Accept only identifier-like text in logs. In particular, never stringify a
 * serialized model/tool object: it can contain provider configuration and
 * secret placeholders in addition to the harmless component name.
 */
function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._:/# -]/gu, "_")
    .slice(0, 96);
  return normalized || fallback;
}

function serializedLabel(serialized: Serialized, fallback: string): string {
  return safeIdentifier(serialized.name ?? serialized.id.at(-1), fallback);
}

function textContentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") total += text.length;
  }
  return total;
}

function messageTextLength(messages: BaseMessage[][]): number {
  let total = 0;
  for (const batch of messages) {
    for (const message of batch) total += textContentLength(message.content);
  }
  return total;
}

function generationTextLength(output: LLMResult): number {
  let total = 0;
  for (const batch of output.generations) {
    for (const generation of batch) {
      total += typeof generation.text === "string" ? generation.text.length : 0;
    }
  }
  return total;
}

interface SafeLlmCompletionMetadata {
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Extracts only bounded status/usage scalars; no model content is retained. */
function safeLlmCompletionMetadata(output: LLMResult): SafeLlmCompletionMetadata {
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let reasoningTokens: number | undefined;

  for (const batch of output.generations) {
    for (const generation of batch) {
      const candidate = generation as unknown as {
        generationInfo?: { finish_reason?: unknown };
        message?: {
          response_metadata?: { finish_reason?: unknown };
          usage_metadata?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            total_tokens?: unknown;
            output_token_details?: { reasoning?: unknown };
          };
        };
      };
      const rawFinishReason = candidate.generationInfo?.finish_reason
        ?? candidate.message?.response_metadata?.finish_reason;
      if (finishReason === undefined && typeof rawFinishReason === "string") {
        finishReason = safeIdentifier(rawFinishReason, "unknown");
      }
      const usage = candidate.message?.usage_metadata;
      inputTokens ??= safeTokenCount(usage?.input_tokens);
      outputTokens ??= safeTokenCount(usage?.output_tokens);
      totalTokens ??= safeTokenCount(usage?.total_tokens);
      reasoningTokens ??= safeTokenCount(usage?.output_token_details?.reasoning);
    }
  }

  const llmOutput = output.llmOutput as unknown as {
    tokenUsage?: {
      promptTokens?: unknown;
      completionTokens?: unknown;
      totalTokens?: unknown;
    };
    estimatedTokenUsage?: {
      promptTokens?: unknown;
      completionTokens?: unknown;
      totalTokens?: unknown;
    };
  } | undefined;
  const fallbackUsage = llmOutput?.tokenUsage ?? llmOutput?.estimatedTokenUsage;
  inputTokens ??= safeTokenCount(fallbackUsage?.promptTokens);
  outputTokens ??= safeTokenCount(fallbackUsage?.completionTokens);
  totalTokens ??= safeTokenCount(fallbackUsage?.totalTokens);

  return {
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function valueTextLength(value: unknown): number | undefined {
  if (typeof value === "string") return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (!value || typeof value !== "object") return undefined;

  // LangChain commonly wraps tool results in a message whose content is safe
  // to measure directly. Do not JSON.stringify arbitrary results merely to
  // calculate their size: custom serializers could reveal their contents.
  const content = (value as { content?: unknown }).content;
  const measured = textContentLength(content);
  return measured > 0 || content === "" ? measured : undefined;
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status = typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : typeof candidate.response?.status === "number"
        ? candidate.response.status
        : undefined;
  return Number.isSafeInteger(status) ? status : undefined;
}

function errorName(error: unknown): string {
  return safeIdentifier(
    error && typeof error === "object" ? (error as { name?: unknown }).name : undefined,
    "Error",
  );
}

/**
 * Compact production progress logs for the otherwise opaque DeepAgent stream.
 *
 * This callback intentionally records only allow-listed metadata: component
 * names, counts, elapsed time, and numeric HTTP status. Prompt text, tool
 * arguments, model output, tool output, error messages, serialized provider
 * configuration, metadata, and tags are never logged.
 */
export class AgentProgressCallback extends BaseCallbackHandler {
  name = "agent_progress_callback";

  private readonly logger: AgentProgressLogger;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly llmRuns = new Map<string, ActiveRun>();
  private readonly toolRuns = new Map<string, ActiveRun>();

  constructor(options: AgentProgressCallbackOptions = {}) {
    super();
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  private activeRun(params: {
    kind: "LLM" | "Tool";
    label: string;
    runId: string;
    startedAtMs: number;
  }): ActiveRun {
    const active: ActiveRun = {
      startedAtMs: params.startedAtMs,
      label: params.label,
    };
    if (this.heartbeatMs > 0) {
      active.heartbeat = setInterval(() => {
        this.logger.info(`[agent-progress] ${params.kind} call still running`, {
          runId: compactRunId(params.runId),
          [params.kind === "LLM" ? "model" : "tool"]: params.label,
          elapsedMs: Math.max(0, this.now() - params.startedAtMs),
        });
      }, this.heartbeatMs);
      active.heartbeat.unref();
    }
    return active;
  }

  private finishRun(active: ActiveRun | undefined): void {
    if (active?.heartbeat) clearInterval(active.heartbeat);
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
  ): void {
    const startedAtMs = this.now();
    const model = serializedLabel(llm, "chat-model");
    this.llmRuns.set(runId, this.activeRun({
      kind: "LLM",
      label: model,
      runId,
      startedAtMs,
    }));
    this.logger.info("[agent-progress] LLM call started", {
      runId: compactRunId(runId),
      model,
      messageCount: messages.reduce((count, batch) => count + batch.length, 0),
      inputTextChars: messageTextLength(messages),
    });
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const active = this.llmRuns.get(runId);
    this.llmRuns.delete(runId);
    this.finishRun(active);
    this.logger.info("[agent-progress] LLM call completed", {
      runId: compactRunId(runId),
      model: active?.label ?? "chat-model",
      ...(active ? { elapsedMs: Math.max(0, this.now() - active.startedAtMs) } : {}),
      outputTextChars: generationTextLength(output),
      ...safeLlmCompletionMetadata(output),
    });
  }

  handleLLMError(error: unknown, runId: string): void {
    const active = this.llmRuns.get(runId);
    this.llmRuns.delete(runId);
    this.finishRun(active);
    const status = numericStatus(error);
    this.logger.error("[agent-progress] LLM call failed", {
      runId: compactRunId(runId),
      model: active?.label ?? "chat-model",
      ...(active ? { elapsedMs: Math.max(0, this.now() - active.startedAtMs) } : {}),
      errorName: errorName(error),
      ...(status === undefined ? {} : { status }),
    });
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const startedAtMs = this.now();
    const toolName = safeIdentifier(runName, serializedLabel(tool, "tool"));
    this.toolRuns.set(runId, this.activeRun({
      kind: "Tool",
      label: toolName,
      runId,
      startedAtMs,
    }));
    this.logger.info("[agent-progress] Tool call started", {
      runId: compactRunId(runId),
      tool: toolName,
      inputChars: input.length,
    });
  }

  handleToolEnd(output: unknown, runId: string): void {
    const active = this.toolRuns.get(runId);
    this.toolRuns.delete(runId);
    this.finishRun(active);
    const outputChars = valueTextLength(output);
    this.logger.info("[agent-progress] Tool call completed", {
      runId: compactRunId(runId),
      tool: active?.label ?? "tool",
      ...(active ? { elapsedMs: Math.max(0, this.now() - active.startedAtMs) } : {}),
      ...(outputChars === undefined ? {} : { outputChars }),
    });
  }

  handleToolError(error: unknown, runId: string): void {
    const active = this.toolRuns.get(runId);
    this.toolRuns.delete(runId);
    this.finishRun(active);
    const status = numericStatus(error);
    this.logger.error("[agent-progress] Tool call failed", {
      runId: compactRunId(runId),
      tool: active?.label ?? "tool",
      ...(active ? { elapsedMs: Math.max(0, this.now() - active.startedAtMs) } : {}),
      errorName: errorName(error),
      ...(status === undefined ? {} : { status }),
    });
  }
}
