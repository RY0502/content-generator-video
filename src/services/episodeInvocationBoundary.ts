import { ToolMessage } from "@langchain/core/messages";
import {
  DynamicStructuredTool,
  type ToolRunnableConfig,
} from "@langchain/core/tools";
import { z } from "zod";

export const END_EPISODE_INVOCATION_TOOL_NAME = "end_episode_invocation";

function isTopLevelTerminalReceipt(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { retryThisInvocation?: unknown }).retryThisInvocation === false;
}

/**
 * Converts an explicit terminal episode-tool receipt into the name of a
 * return-direct routing sentinel. The receipt itself is not changed.
 *
 * Direct tool-function calls intentionally keep returning strings: LangChain
 * only supplies `config.toolCall.id` while the tool is executing inside an
 * agent graph, where a paired ToolMessage is required.
 */
export function wrapTerminalEpisodeInvocationReceipt(
  result: string,
  config?: ToolRunnableConfig,
): string | ToolMessage {
  const toolCallId = config?.toolCall?.id;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return result;

  let receipt: unknown;
  try {
    receipt = JSON.parse(result) as unknown;
  } catch {
    return result;
  }
  if (!isTopLevelTerminalReceipt(receipt)) return result;

  return new ToolMessage({
    name: END_EPISODE_INVOCATION_TOOL_NAME,
    tool_call_id: toolCallId,
    content: result,
  });
}

/**
 * Adds the conditional boundary to an episode tool without changing its public
 * schema, name, metadata, or direct-call behavior. Only graph executions have
 * a tool-call id, so existing unit callers continue to receive plain strings.
 */
export function guardTerminalEpisodeInvocationReceipts<
  TTool extends DynamicStructuredTool,
>(tool: TTool): TTool {
  const originalFunc = tool.func;
  tool.func = (async (input, runManager, config) => {
    const result = await originalFunc(input, runManager, config);
    return typeof result === "string"
      ? wrapTerminalEpisodeInvocationReceipt(result, config)
      : result;
  }) as typeof tool.func;
  return tool;
}

/**
 * Internal routing sentinel. Episode tools return a ToolMessage bearing this
 * name only after their durable work has completed and their receipt explicitly
 * says `retryThisInvocation: false`. ReactAgent then ends the current graph run
 * without asking the model to improvise another recovery attempt.
 */
export function buildEndEpisodeInvocationTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: END_EPISODE_INVOCATION_TOOL_NAME,
    description:
      "Internal episode-invocation boundary. Never call this tool directly; terminal episode receipts route through it automatically.",
    schema: z.object({}).strict(),
    returnDirect: true,
    func: async () => JSON.stringify({
      status: "invocation_stopped",
      persisted: false,
      retryThisInvocation: false,
      nextAction: "Start a fresh agent run and resume from durable episode state.",
    }),
  });
}
