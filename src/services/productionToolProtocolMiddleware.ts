import {
  AIMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { NARRATION_MAX_SPOKEN_WORDS } from "./narrationContract.js";

export const PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME =
  "ProductionToolProtocolMiddleware";

export const PRODUCTION_TOOL_PROTOCOL_ERROR_CODE =
  "PRODUCTION_TOOL_CALL_PROTOCOL_VIOLATION";

const MAX_MODEL_ATTEMPTS_PER_NONTERMINAL_TURN = 2;

const PROTOCOL_RETRY_INSTRUCTION =
  "PRODUCTION PROTOCOL CORRECTION: this turn is nonterminal. Return exactly one " +
  "structured domain-tool call now. Do not emit planning, analysis, manual counting, " +
  "draft content, JSON text, or a prose preamble.";

/**
 * These tools are followed by more deterministic production work. A normal
 * model message after one of them would incorrectly end the LangGraph run and
 * let DeepAgentRunner record a successful task without advancing durable
 * episode state.
 */
const NONTERMINAL_WORKFLOW_TOOLS = new Set([
  "get_or_create_series",
  "bulk_insert_episode_list",
  "ensure_series_character_portraits",
  "write_episode_script_chunk",
  "stage_episode_script_draft",
  "refine_episode_script",
  "synthesize_episode_narration_audio",
]);

const TERMINAL_EPISODE_AVAILABILITY_KINDS = new Set([
  "daily_limit",
  "series_complete",
  "no_episodes",
  "series_missing",
]);

type ToolLike = ClientTool | ServerTool;

type ProtocolRequest = {
  messages: BaseMessage[];
  tools: ToolLike[];
};

type JsonRecord = Record<string, unknown>;

type RequiredProductionToolDecision = {
  turn: string;
  toolName: string | null;
  expectedArgs: JsonRecord | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0
    ? value as number
    : null;
}

function hasValidRequestedSceneRange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const startScene = positiveInteger(value.nextSceneNumber ?? value.startScene);
  const endScene = positiveInteger(value.nextSceneEnd ?? value.endScene);
  return startScene !== null && endScene !== null && endScene >= startScene;
}

function toolName(tool: ToolLike): string | null {
  if (!isRecord(tool)) return null;
  return typeof tool.name === "string" ? tool.name : null;
}

function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("");
}

function parseReceipt(message: BaseMessage): JsonRecord | null {
  const text = messageText(message.content).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function resolveToolMessageName(
  messages: readonly BaseMessage[],
  toolMessageIndex: number,
): string | null {
  const message = messages[toolMessageIndex];
  if (!isToolMessage(message)) return null;
  if (typeof message.name === "string" && message.name.length > 0) {
    return message.name;
  }

  // ToolMessage.name is normally populated by ReactAgent. Retain a bounded
  // compatibility fallback for providers/framework versions that only copy
  // the tool-call id onto the result.
  for (let index = toolMessageIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isAIMessage(candidate)) continue;
    const call = candidate.tool_calls?.find(
      (entry) => entry.id === message.tool_call_id,
    );
    return call?.name ?? null;
  }
  return null;
}

function resolveToolMessageArgs(
  messages: readonly BaseMessage[],
  toolMessageIndex: number,
): JsonRecord | null {
  const message = messages[toolMessageIndex];
  if (!isToolMessage(message)) return null;

  for (let index = toolMessageIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isAIMessage(candidate)) continue;
    const call = candidate.tool_calls?.find(
      (entry) => entry.id === message.tool_call_id,
    );
    return call && isRecord(call.args) ? call.args : null;
  }
  return null;
}

function isExplicitTerminalReceipt(
  toolMessage: BaseMessage,
  name: string,
): boolean {
  const receipt = parseReceipt(toolMessage);
  if (!receipt) return false;

  // Script tools use this exact flag to declare a fresh-run boundary. Their
  // normal graph path is returnDirect; honoring it here as well keeps this
  // middleware safe if that routing implementation changes.
  if (receipt.retryThisInvocation === false) return true;

  if (name !== "get_next_episode") return false;
  return receipt.resumeAction === "stop"
    || (
      typeof receipt.kind === "string"
      && TERMINAL_EPISODE_AVAILABILITY_KINDS.has(receipt.kind)
    );
}

function bootstrapToolAfterReceipt(
  lastToolName: string,
  receipt: JsonRecord | null,
  lastToolArgs: JsonRecord | null,
): { toolName: string; expectedArgs: JsonRecord | null } | null {
  if (!receipt) return null;

  const status = typeof receipt.status === "string" ? receipt.status : null;
  const kind = typeof receipt.kind === "string" ? receipt.kind : null;
  const receiptSeriesId = Number.isInteger(receipt.seriesId)
    && (receipt.seriesId as number) > 0
    ? receipt.seriesId as number
    : null;
  const callSeriesId = Number.isInteger(lastToolArgs?.seriesId)
    && (lastToolArgs?.seriesId as number) > 0
    ? lastToolArgs?.seriesId as number
    : null;
  const seriesId = receiptSeriesId ?? callSeriesId;
  const conceptName = typeof receipt.conceptName === "string"
    && receipt.conceptName.length > 0
    ? receipt.conceptName
    : null;

  if (lastToolName === "write_episode_script_chunk") {
    if (receipt.retryThisInvocation !== true) return null;

    const episodeId = positiveInteger(receipt.episodeId)
      ?? positiveInteger(lastToolArgs?.episodeId);
    const draftRevision = positiveInteger(receipt.draftRevision);
    if (episodeId === null) return null;

    if (
      receipt.persisted === true
      && (
        status === "script_draft_complete"
        || (status === "script_chunk_already_present" && receipt.scriptComplete === true)
      )
    ) {
      return draftRevision === null
        ? null
        : {
            toolName: "refine_episode_script",
            expectedArgs: { episodeId, draftRevision },
          };
    }

    if (
      status === "script_chunk_replan_required"
      && receipt.persisted === false
      && draftRevision !== null
    ) {
      const minimumReplacementSpokenWords = positiveInteger(
        receipt.minimumReplacementSpokenWords,
      );
      return minimumReplacementSpokenWords === null
        ? null
        : {
            toolName: "write_episode_script_chunk",
            expectedArgs: {
              episodeId,
              operation: "restart",
              expectedDraftRevision: draftRevision,
              minimumReplacementSpokenWords,
            },
          };
    }

    if (
      status === "script_chunk_restart_required"
      && receipt.persisted === true
      && draftRevision !== null
      && isRecord(receipt.restartPlan)
    ) {
      const targetSceneCount = positiveInteger(receipt.restartPlan.targetSceneCount);
      const minimumReplacementSpokenWords = positiveInteger(
        receipt.restartPlan.minimumReplacementSpokenWords,
      );
      const authoringPlan = isRecord(receipt.restartPlan.authoringPlan)
        ? receipt.restartPlan.authoringPlan
        : null;
      if (targetSceneCount !== null && authoringPlan !== null) {
        const planIsReachable = minimumReplacementSpokenWords === null
          || targetSceneCount * NARRATION_MAX_SPOKEN_WORDS
            >= minimumReplacementSpokenWords;
        return {
          toolName: "write_episode_script_chunk",
          expectedArgs: {
            episodeId,
            operation: "restart",
            expectedDraftRevision: draftRevision,
            ...(minimumReplacementSpokenWords === null
              ? {}
              : { minimumReplacementSpokenWords }),
            ...(planIsReachable ? { targetSceneCount, authoringPlan } : {}),
          },
        };
      }
    }

    const authoringProgress = isRecord(receipt.authoringProgress)
      ? receipt.authoringProgress
      : null;
    if (
      (
        (
          receipt.persisted === true
          && (
            status === "script_chunk_staged"
            || status === "script_chunk_appended"
            || status === "script_chunk_already_present"
          )
        )
        || (
          status === "invalid_script_chunk"
          && receipt.persisted === true
        )
      )
      && draftRevision !== null
      && hasValidRequestedSceneRange(authoringProgress)
    ) {
      return {
        toolName: "write_episode_script_chunk",
        expectedArgs: {
          episodeId,
          operation: "append",
          expectedDraftRevision: draftRevision,
        },
      };
    }

    if (
      status === "script_chunk_too_large"
      && hasValidRequestedSceneRange(receipt.requestedSceneRange)
    ) {
      const operation = receipt.operation;
      if (operation === "append") {
        return draftRevision === null
          ? null
          : {
              toolName: "write_episode_script_chunk",
              expectedArgs: {
                episodeId,
                operation,
                expectedDraftRevision: draftRevision,
              },
            };
      }
      if (operation === "start" || operation === "restart") {
        const targetSceneCount = positiveInteger(lastToolArgs?.targetSceneCount);
        const minimumReplacementSpokenWords = positiveInteger(
          lastToolArgs?.minimumReplacementSpokenWords,
        );
        const authoringPlan = isRecord(lastToolArgs?.authoringPlan)
          ? lastToolArgs.authoringPlan
          : null;
        const expectedDraftRevision = draftRevision
          ?? positiveInteger(lastToolArgs?.expectedDraftRevision);
        if (
          targetSceneCount === null
          || authoringPlan === null
          || (operation === "restart" && expectedDraftRevision === null)
        ) {
          return null;
        }
        return {
          toolName: "write_episode_script_chunk",
          expectedArgs: {
            episodeId,
            operation,
            ...(operation === "restart" ? { expectedDraftRevision } : {}),
            targetSceneCount,
            ...(operation !== "restart" || minimumReplacementSpokenWords === null
              ? {}
              : { minimumReplacementSpokenWords }),
            authoringPlan,
          },
        };
      }
    }

    if (
      receipt.persisted === false
      && (status === "invalid_input" || status === "invalid_script_chunk")
    ) {
      const operation = receipt.operation ?? lastToolArgs?.operation;
      if (operation === "append") {
        const expectedDraftRevision = positiveInteger(receipt.draftRevision)
          ?? positiveInteger(lastToolArgs?.expectedDraftRevision);
        return expectedDraftRevision === null
          ? null
          : {
              toolName: "write_episode_script_chunk",
              expectedArgs: {
                episodeId,
                operation,
                expectedDraftRevision,
              },
            };
      }
      if (operation === "start" || operation === "restart") {
        const targetSceneCount = positiveInteger(lastToolArgs?.targetSceneCount);
        const minimumReplacementSpokenWords = positiveInteger(
          lastToolArgs?.minimumReplacementSpokenWords,
        );
        const authoringPlan = isRecord(lastToolArgs?.authoringPlan)
          ? lastToolArgs.authoringPlan
          : null;
        const expectedDraftRevision = positiveInteger(receipt.draftRevision)
          ?? positiveInteger(lastToolArgs?.expectedDraftRevision);
        if (
          targetSceneCount === null
          || authoringPlan === null
          || (operation === "restart" && expectedDraftRevision === null)
        ) {
          return null;
        }
        return {
          toolName: "write_episode_script_chunk",
          expectedArgs: {
            episodeId,
            operation,
            ...(operation === "restart" ? { expectedDraftRevision } : {}),
            targetSceneCount,
            ...(operation !== "restart" || minimumReplacementSpokenWords === null
              ? {}
              : { minimumReplacementSpokenWords }),
            authoringPlan,
          },
        };
      }
    }
    return null;
  }

  if (lastToolName === "stage_episode_script_draft") {
    const episodeId = positiveInteger(receipt.episodeId);
    const draftRevision = positiveInteger(receipt.draftRevision);
    if (
      receipt.persisted === true
      && episodeId !== null
      && draftRevision !== null
      && [
        "draft_staged",
        "draft_replaced",
        "draft_already_staged",
        "draft_conflict",
      ].includes(status ?? "")
    ) {
      return {
        toolName: "refine_episode_script",
        expectedArgs: { episodeId, draftRevision },
      };
    }
    return null;
  }

  if (lastToolName === "synthesize_episode_narration_audio") {
    if (status !== "repair_required" || receipt.readyForAgnes !== false) return null;
    const episodeId = positiveInteger(receipt.episodeId);
    const measuredNarrationSceneCount = positiveInteger(
      receipt.measuredNarrationSceneCount,
    );
    const measuredTotalNarrationSeconds = receipt.measuredTotalNarrationSeconds;
    const rawDurationEvidence = receipt.durationExceededScenes;
    if (
      episodeId === null
      || measuredNarrationSceneCount === null
      || typeof measuredTotalNarrationSeconds !== "number"
      || !Number.isFinite(measuredTotalNarrationSeconds)
      || measuredTotalNarrationSeconds <= 0
      || !Array.isArray(rawDurationEvidence)
      || rawDurationEvidence.length > 60
    ) return null;
    const durationExceededScenes = rawDurationEvidence.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const sceneNumber = positiveInteger(entry.sceneNumber);
      const durationSeconds = entry.durationSeconds;
      if (
        sceneNumber === null
        || typeof durationSeconds !== "number"
        || !Number.isFinite(durationSeconds)
        || durationSeconds <= 0
        || durationSeconds > 300
      ) return [];
      return [{ sceneNumber, durationSeconds }];
    });
    if (durationExceededScenes.length !== rawDurationEvidence.length) return null;
    return {
      toolName: "refine_episode_script",
      expectedArgs: {
        episodeId,
        durationExceededScenes,
        measuredTotalNarrationSeconds,
        measuredNarrationSceneCount,
      },
    };
  }

  if (lastToolName === "refine_episode_script") {
    if (status !== "ready" || receipt.persisted !== true) return null;
    const seriesId = positiveInteger(receipt.seriesId);
    const episodeNumber = positiveInteger(receipt.episodeNumber);
    if (seriesId === null) return null;
    if (receipt.scriptReloadRequired === true) {
      return {
        toolName: "get_next_episode",
        expectedArgs: { seriesId },
      };
    }
    if (receipt.scriptReloadRequired === false && episodeNumber !== null) {
      return {
        toolName: "synthesize_episode_narration_audio",
        expectedArgs: { seriesId, episodeNumber },
      };
    }
    return null;
  }

  if (
    status === "series_missing"
    || status === "invalid_series_id"
    || kind === "series_missing"
  ) {
    return {
      toolName: "get_or_create_series",
      expectedArgs: conceptName === null ? null : { conceptName },
    };
  }

  if (lastToolName === "get_or_create_series") {
    if (status === "needs_definition") {
      return {
        toolName: "get_or_create_series",
        expectedArgs: conceptName === null ? null : { conceptName },
      };
    }
    return seriesId === null
      ? null
      : {
          toolName: "bulk_insert_episode_list",
          expectedArgs: { seriesId },
        };
  }

  if (lastToolName === "bulk_insert_episode_list") {
    if (status === "manifest_required") {
      return seriesId === null
        ? null
        : {
            toolName: "bulk_insert_episode_list",
            expectedArgs: { seriesId },
          };
    }
    return (
      status === "ok" || status === "verified" || status === "inserted"
    )
      ? {
          toolName: "get_next_episode",
          expectedArgs: seriesId === null ? null : { seriesId },
        }
      : null;
  }

  if (lastToolName === "get_next_episode") {
    const resumeAction = typeof receipt.resumeAction === "string"
      ? receipt.resumeAction
      : null;
    const episode = isRecord(receipt.episode) ? receipt.episode : null;
    const episodeId = Number.isInteger(episode?.id) && (episode?.id as number) > 0
      ? episode?.id as number
      : null;
    const episodeSeriesId = Number.isInteger(episode?.seriesId)
      && (episode?.seriesId as number) > 0
      ? episode?.seriesId as number
      : null;
    const episodeNumber = Number.isInteger(episode?.episodeNumber)
      && (episode?.episodeNumber as number) > 0
      ? episode?.episodeNumber as number
      : null;
    const authoritativeSeriesId = episodeSeriesId ?? seriesId;
    const scriptDraft = isRecord(receipt.scriptDraft)
      ? receipt.scriptDraft
      : null;
    const draftRevision = Number.isInteger(scriptDraft?.revision)
      && (scriptDraft?.revision as number) > 0
      ? scriptDraft?.revision as number
      : null;
    const authoringProgress = isRecord(scriptDraft?.authoringProgress)
      ? scriptDraft.authoringProgress
      : null;
    const authoringRequiredAction = typeof authoringProgress?.requiredAction === "string"
      ? authoringProgress.requiredAction
      : null;
    const draftValidation = isRecord(scriptDraft?.validation)
      ? scriptDraft.validation
      : null;
    const draftValidationRequiredAction = typeof draftValidation?.requiredAction === "string"
      ? draftValidation.requiredAction
      : null;
    const durableTimingEvidence = isRecord(draftValidation?.durableTimingEvidence)
      ? draftValidation.durableTimingEvidence
      : null;
    const minimumReplacementSpokenWords = positiveInteger(
      durableTimingEvidence?.minimumReplacementSpokenWords,
    );

    switch (resumeAction) {
      case "script_and_audio":
        return authoritativeSeriesId === null
          ? null
          : {
              toolName: "ensure_series_character_portraits",
              expectedArgs: { seriesId: authoritativeSeriesId },
            };
      case "script_authoring":
        if (draftValidationRequiredAction === "reauthor_complete_script") {
          return episodeId === null || draftRevision === null
            ? null
            : {
                toolName: "write_episode_script_chunk",
                expectedArgs: {
                  episodeId,
                  operation: "restart",
                  expectedDraftRevision: draftRevision,
                  ...(minimumReplacementSpokenWords === null
                    ? {}
                    : { minimumReplacementSpokenWords }),
                },
              };
        }
        if (authoringRequiredAction === "restart_script_authoring") {
          const targetSceneCount = positiveInteger(authoringProgress?.targetSceneCount);
          const authoringMinimumSpokenWords = positiveInteger(
            authoringProgress?.minimumSpokenWords,
          );
          const authoringPlan = isRecord(authoringProgress?.authoringPlan)
            ? authoringProgress.authoringPlan
            : null;
          return episodeId === null
            || draftRevision === null
            || targetSceneCount === null
            || authoringPlan === null
            ? null
            : {
                toolName: "write_episode_script_chunk",
                expectedArgs: {
                  episodeId,
                  operation: "restart",
                  expectedDraftRevision: draftRevision,
                  ...(authoringMinimumSpokenWords === null
                    ? {}
                    : {
                        minimumReplacementSpokenWords:
                          authoringMinimumSpokenWords,
                      }),
                  ...(authoringMinimumSpokenWords !== null
                    && targetSceneCount * NARRATION_MAX_SPOKEN_WORDS
                      < authoringMinimumSpokenWords
                    ? {}
                    : { targetSceneCount, authoringPlan }),
                },
              };
        }
        return episodeId === null || draftRevision === null
          ? null
          : {
              toolName: "write_episode_script_chunk",
              expectedArgs: {
                episodeId,
                operation: "append",
                expectedDraftRevision: draftRevision,
              },
            };
      case "repair_script":
        return episodeId === null
          ? null
          : {
              toolName: "refine_episode_script",
              expectedArgs: {
                episodeId,
                ...(draftRevision === null ? {} : { draftRevision }),
              },
            };
      case "audio_repair":
        return authoritativeSeriesId === null || episodeNumber === null
          ? null
          : {
              toolName: "synthesize_episode_narration_audio",
              expectedArgs: { seriesId: authoritativeSeriesId, episodeNumber },
            };
      case "agnes":
        return authoritativeSeriesId === null || episodeNumber === null
          ? null
          : {
              toolName: "submit_agnes_scene_videos",
              expectedArgs: { seriesId: authoritativeSeriesId, episodeNumber },
            };
      default:
        return null;
    }
  }

  return null;
}

function findEarlierToolReceipt(
  messages: readonly BaseMessage[],
  beforeIndex: number,
  name: string,
): { receipt: JsonRecord; args: JsonRecord | null } | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolMessage(message)) continue;
    if (resolveToolMessageName(messages, index) !== name) continue;
    const receipt = parseReceipt(message);
    if (!receipt) return null;
    return {
      receipt,
      args: resolveToolMessageArgs(messages, index),
    };
  }
  return null;
}

function toolAfterRosterPreflight(
  messages: readonly BaseMessage[],
  rosterToolMessageIndex: number,
): { toolName: string; expectedArgs: JsonRecord | null } | null {
  const getNext = findEarlierToolReceipt(
    messages,
    rosterToolMessageIndex,
    "get_next_episode",
  );
  if (!getNext || getNext.receipt.resumeAction !== "script_and_audio") {
    return null;
  }

  const episode = isRecord(getNext.receipt.episode)
    ? getNext.receipt.episode
    : null;
  const scriptValidation = isRecord(getNext.receipt.scriptValidation)
    ? getNext.receipt.scriptValidation
    : null;
  const episodeId = Number.isInteger(episode?.id) && (episode?.id as number) > 0
    ? episode?.id as number
    : null;
  const receiptSeriesId = Number.isInteger(episode?.seriesId)
    && (episode?.seriesId as number) > 0
    ? episode?.seriesId as number
    : null;
  const callSeriesId = Number.isInteger(getNext.args?.seriesId)
    && (getNext.args?.seriesId as number) > 0
    ? getNext.args?.seriesId as number
    : null;
  const seriesId = receiptSeriesId ?? callSeriesId;
  const episodeNumber = Number.isInteger(episode?.episodeNumber)
    && (episode?.episodeNumber as number) > 0
    ? episode?.episodeNumber as number
    : null;

  if (scriptValidation?.status === "not_started") {
    return episodeId === null
      ? null
      : {
          toolName: "write_episode_script_chunk",
          expectedArgs: { episodeId, operation: "start" },
        };
  }
  if (scriptValidation?.status === "ready") {
    return seriesId === null || episodeNumber === null
      ? null
      : {
          toolName: "synthesize_episode_narration_audio",
          expectedArgs: { seriesId, episodeNumber },
        };
  }
  return null;
}

function requiredProductionToolDecision(
  request: ProtocolRequest,
): RequiredProductionToolDecision | null {
  const availableToolNames = new Set(
    request.tools.map(toolName).filter((name): name is string => name !== null),
  );
  // Harness profiles can also be inherited by unrelated OpenAI agents. Scope
  // the policy to this project's production tool surface.
  if (!availableToolNames.has("get_or_create_series")) return null;

  const availableExactTool = (name: string | null): string | null =>
    name !== null && availableToolNames.has(name) ? name : null;

  const hasAgentOutput = request.messages.some(
    (message) => isAIMessage(message) || isToolMessage(message),
  );
  if (!hasAgentOutput) {
    return {
      turn: "initial_production_turn",
      toolName: availableExactTool("get_or_create_series"),
      expectedArgs: null,
    };
  }

  let lastToolMessageIndex = -1;
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (isToolMessage(request.messages[index])) {
      lastToolMessageIndex = index;
      break;
    }
    // A completed assistant answer is not reclassified as nonterminal merely
    // because an older tool message exists in history.
    if (isAIMessage(request.messages[index])) return null;
  }
  if (lastToolMessageIndex < 0) return null;

  const lastToolMessage = request.messages[lastToolMessageIndex];
  const lastToolName = resolveToolMessageName(
    request.messages,
    lastToolMessageIndex,
  );
  if (!lastToolName || !availableToolNames.has(lastToolName)) return null;
  if (isExplicitTerminalReceipt(lastToolMessage, lastToolName)) return null;

  if (
    lastToolName === "get_next_episode"
    || NONTERMINAL_WORKFLOW_TOOLS.has(lastToolName)
  ) {
    const bootstrapTransition = lastToolName === "ensure_series_character_portraits"
      ? toolAfterRosterPreflight(request.messages, lastToolMessageIndex)
      : bootstrapToolAfterReceipt(
          lastToolName,
          parseReceipt(lastToolMessage),
          resolveToolMessageArgs(request.messages, lastToolMessageIndex),
        );
    const exactToolName = availableExactTool(
      bootstrapTransition?.toolName ?? null,
    );
    // Never force an unspecified tool. Unknown, malformed, or unavailable
    // transitions retain the model's normal behavior; durable state remains
    // resumable, and this guard cannot turn that edge into a protocol failure.
    if (bootstrapTransition === null || exactToolName === null) return null;
    return {
      turn: `after_${lastToolName}`,
      toolName: exactToolName,
      expectedArgs: bootstrapTransition.expectedArgs,
    };
  }
  return null;
}

/**
 * Returns why this model turn must advance through a structured tool call, or
 * null when a normal final answer is permitted.
 */
export function requiredProductionToolTurn(
  request: ProtocolRequest,
): string | null {
  return requiredProductionToolDecision(request)?.turn ?? null;
}

function hasStructuredToolCall(
  message: BaseMessage,
  requiredToolName: string | null,
  expectedArgs: JsonRecord | null,
): boolean {
  if (
    !isAIMessage(message)
    || !Array.isArray(message.tool_calls)
    || message.tool_calls.length !== 1
  ) {
    return false;
  }
  if (requiredToolName === null) return true;
  if (
    message.tool_calls[0].name !== requiredToolName
  ) {
    return false;
  }
  if (expectedArgs === null) return true;

  const actualArgs = message.tool_calls[0].args;
  return isRecord(actualArgs) && Object.entries(expectedArgs).every(
    ([key, value]) => actualArgs[key] === value,
  );
}

type BoundToolCallResult = {
  message: AIMessage;
  boundArgKeys: string[];
  removedArgKeys: string[];
};

/**
 * The preceding durable tool receipt, rather than the model, owns workflow
 * routing identifiers. Some OpenAI-compatible providers occasionally select
 * the correct forced tool but omit or copy one of those small control fields
 * incorrectly. Bind only that authoritative subset locally and leave the
 * authored payload (notably `scenes`) byte-for-byte/object-for-object intact.
 * The domain tool remains responsible for validating all content fields.
 */
function bindAuthoritativeToolCallArgs(
  message: AIMessage,
  requiredToolName: string | null,
  expectedArgs: JsonRecord | null,
): BoundToolCallResult {
  if (
    requiredToolName === null
    || expectedArgs === null
    || !isAIMessage(message)
    || !Array.isArray(message.tool_calls)
    || message.tool_calls.length !== 1
  ) {
    return { message, boundArgKeys: [], removedArgKeys: [] };
  }

  const call = message.tool_calls[0];
  if (call.name !== requiredToolName || !isRecord(call.args)) {
    return { message, boundArgKeys: [], removedArgKeys: [] };
  }

  const normalizedArgs: JsonRecord = { ...call.args };
  const boundArgKeys = Object.entries(expectedArgs)
    .filter(([key, value]) => normalizedArgs[key] !== value)
    .map(([key]) => key);
  Object.assign(normalizedArgs, expectedArgs);

  const removedArgKeys: string[] = [];
  if (requiredToolName === "write_episode_script_chunk") {
    const incompatibleKeys = expectedArgs.operation === "append"
      ? ["targetSceneCount", "minimumReplacementSpokenWords", "authoringPlan"] as const
      : expectedArgs.operation === "start"
        ? ["expectedDraftRevision", "minimumReplacementSpokenWords"] as const
        : [];
    for (const key of incompatibleKeys) {
      if (key in normalizedArgs) {
        delete normalizedArgs[key];
        removedArgKeys.push(key);
      }
    }
    if (
      expectedArgs.operation === "restart"
      && !Object.prototype.hasOwnProperty.call(
        expectedArgs,
        "minimumReplacementSpokenWords",
      )
      && "minimumReplacementSpokenWords" in normalizedArgs
    ) {
      delete normalizedArgs.minimumReplacementSpokenWords;
      removedArgKeys.push("minimumReplacementSpokenWords");
    }
  }
  if (
    requiredToolName === "refine_episode_script"
    && Object.prototype.hasOwnProperty.call(
      expectedArgs,
      "measuredTotalNarrationSeconds",
    )
  ) {
    for (const key of Object.keys(normalizedArgs)) {
      if (!Object.prototype.hasOwnProperty.call(expectedArgs, key)) {
        delete normalizedArgs[key];
        removedArgKeys.push(key);
      }
    }
  }

  if (boundArgKeys.length === 0 && removedArgKeys.length === 0) {
    return { message, boundArgKeys, removedArgKeys };
  }

  // Parsed tool_calls are what ToolNode executes. Drop any duplicate raw
  // provider representation so a later serialization cannot retain stale
  // pre-normalization arguments alongside the canonical parsed call.
  const {
    tool_calls: _rawToolCalls,
    function_call: _rawFunctionCall,
    ...additionalKwargs
  } = message.additional_kwargs;
  const normalizedContent = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (
          isRecord(block)
          && block.type === "tool_call"
          && block.name === call.name
          && (call.id === undefined || block.id === call.id)
        ) {
          return { ...block, args: normalizedArgs };
        }
        return block;
      }) as MessageContent
    : message.content;
  return {
    message: new AIMessage({
      id: message.id,
      name: message.name,
      content: normalizedContent,
      additional_kwargs: additionalKwargs,
      response_metadata: message.response_metadata,
      tool_calls: [{ ...call, args: normalizedArgs }],
      invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata,
    }),
    boundArgKeys,
    removedArgKeys,
  };
}

function retryInstruction(
  requiredToolName: string | null,
  expectedArgs: JsonRecord | null,
): string {
  if (requiredToolName === null) return PROTOCOL_RETRY_INSTRUCTION;
  const requiredArgs = expectedArgs === null
    ? ""
    : ` Preserve these exact arguments: ${JSON.stringify(expectedArgs)}.`;
  const pendingChunkHint = requiredToolName === "write_episode_script_chunk"
    && expectedArgs?.operation === "append"
    ? " If the preceding receipt has pendingRepair, copy only its candidateScenes named by " +
      "requiredSceneNumbers and change only its per-scene editableFields."
    : "";
  return `${PROTOCOL_RETRY_INSTRUCTION} Call only ${requiredToolName}.${requiredArgs}${pendingChunkHint}`;
}

function jsonValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function rejectedToolCallDiagnostics(
  message: BaseMessage,
  requiredToolName: string | null,
  expectedArgs: JsonRecord | null,
): JsonRecord {
  const calls = isAIMessage(message) && Array.isArray(message.tool_calls)
    ? message.tool_calls
    : [];
  return {
    toolCallCount: calls.length,
    calls: calls.map((call) => {
      const args = isRecord(call.args) ? call.args : null;
      const expectedEntries = expectedArgs === null
        ? []
        : Object.entries(expectedArgs);
      return {
        argsType: jsonValueType(call.args),
        argKeyCount: args === null ? 0 : Object.keys(args).length,
        unexpectedArgKeyCount: args === null || expectedArgs === null
          ? 0
          : Object.keys(args).filter((key) => !(key in expectedArgs)).length,
        missingExpectedArgKeys: expectedEntries
          .filter(([key]) => args === null || !(key in args))
          .map(([key]) => key),
        authoritativeArgMismatchKeys: expectedEntries
          .filter(([key, value]) => args !== null && key in args && args[key] !== value)
          .map(([key]) => key),
        typeMismatches: expectedEntries
          .filter(([key, value]) =>
            args !== null
            && key in args
            && jsonValueType(args[key]) !== jsonValueType(value)
          )
          .map(([key, value]) => ({
            key,
            expectedType: jsonValueType(value),
            actualType: args === null ? "missing" : jsonValueType(args[key]),
          })),
        toolNameMatches: requiredToolName === null || call.name === requiredToolName,
      };
    }),
  };
}

/** A bounded failure: callers must start a fresh run instead of looping. */
export class ProductionToolCallProtocolError extends Error {
  readonly code = PRODUCTION_TOOL_PROTOCOL_ERROR_CODE;
  readonly attempts = MAX_MODEL_ATTEMPTS_PER_NONTERMINAL_TURN;
  readonly turn: string;

  constructor(turn: string) {
    super(
      "The production model did not return the single expected structured tool call " +
      `for nonterminal workflow turn ${turn} after ` +
      `${MAX_MODEL_ATTEMPTS_PER_NONTERMINAL_TURN} bounded attempts.`,
    );
    this.name = "ProductionToolCallProtocolError";
    this.turn = turn;
  }
}

/**
 * Prevents a prose-only response from becoming a false-success boundary while
 * durable episode work is explicitly unfinished. The second attempt reuses
 * the original messages and adds only a compact system correction, so the
 * rejected prose is never appended to context and cannot inflate or corrupt
 * the next call.
 */
export function createProductionToolProtocolMiddleware() {
  return createMiddleware({
    name: PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const decision = requiredProductionToolDecision(request);
      if (decision === null) return handler(request);

      const {
        turn: requiredTurn,
        toolName: requiredToolName,
        expectedArgs,
      } = decision;
      const toolChoice = requiredToolName === null
        ? "required" as const
        : {
            type: "function" as const,
            function: { name: requiredToolName },
          };

      const requiredRequest = {
        ...request,
        toolChoice,
        modelSettings: {
          ...request.modelSettings,
          parallel_tool_calls: false,
        },
      };
      const first = bindAuthoritativeToolCallArgs(
        await handler(requiredRequest),
        requiredToolName,
        expectedArgs,
      );
      if (first.boundArgKeys.length > 0 || first.removedArgKeys.length > 0) {
        console.info(
          "[production-tool-protocol] Bound deterministic routing arguments " +
          JSON.stringify({
            turn: requiredTurn,
            toolName: requiredToolName,
            boundArgKeys: first.boundArgKeys,
            removedArgKeys: first.removedArgKeys,
          }),
        );
      }
      if (hasStructuredToolCall(first.message, requiredToolName, expectedArgs)) {
        return first.message;
      }

      console.warn(
        "[production-tool-protocol] Model ignored required tool choice; retrying once " +
        JSON.stringify({
          turn: requiredTurn,
          requiredToolName,
          rejection: rejectedToolCallDiagnostics(
            first.message,
            requiredToolName,
            expectedArgs,
          ),
        }),
      );
      const second = bindAuthoritativeToolCallArgs(
        await handler({
          ...requiredRequest,
          systemMessage: request.systemMessage.concat(
            retryInstruction(requiredToolName, expectedArgs),
          ),
        }),
        requiredToolName,
        expectedArgs,
      );
      if (second.boundArgKeys.length > 0 || second.removedArgKeys.length > 0) {
        console.info(
          "[production-tool-protocol] Bound deterministic routing arguments " +
          JSON.stringify({
            turn: requiredTurn,
            toolName: requiredToolName,
            boundArgKeys: second.boundArgKeys,
            removedArgKeys: second.removedArgKeys,
          }),
        );
      }
      if (hasStructuredToolCall(second.message, requiredToolName, expectedArgs)) {
        return second.message;
      }

      console.warn(
        "[production-tool-protocol] Model ignored required tool choice twice " +
        JSON.stringify({
          turn: requiredTurn,
          requiredToolName,
          rejection: rejectedToolCallDiagnostics(
            second.message,
            requiredToolName,
            expectedArgs,
          ),
        }),
      );

      throw new ProductionToolCallProtocolError(requiredTurn);
    },
  });
}
