import { getHarnessProfile, registerHarnessProfile } from "deepagents";
import {
  createProductionToolProtocolMiddleware,
  PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME,
} from "./productionToolProtocolMiddleware.js";
import {
  createProductionModelCallFailoverMiddleware,
  PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME,
} from "./productionModelCallFailoverMiddleware.js";

/**
 * This workflow is fully represented by domain tools and durable database
 * state. Exposing generic filesystem, web, media, and delegation tools invites
 * the orchestration model to copy a 40-60 scene script through scratch files or
 * unrelated tool calls, multiplying the conversation context without adding
 * production quality.
 */
export const PRODUCTION_EXCLUDED_AGENT_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
  "task",
  "write_todos",
  "tavily_search",
  "tavily_crawl",
  "vision_scrape",
  "analyze_page_components",
  "generate_image",
  "generate_audio",
  "generate_image_cloudflare_img2img",
] as const;

/**
 * Each CLI invocation begins with an empty framework checkpoint and follows a
 * compact, database-backed state machine. Summarizing that disposable agent
 * transcript adds another model call and can offload large script tool calls,
 * while the authoritative resumable state already lives in Turso.
 */
export const PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE = [
  "SummarizationMiddleware",
] as const;

let configured = false;

/**
 * DeepAgentRunner supplies OpenAI-compatible ChatOpenAI instances for every
 * provider, so DeepAgents resolves all of them through the `openai` harness
 * profile. Registration is process-global and additive; guard it so repeated
 * in-process invocations remain deterministic.
 */
export function configureProductionHarness(): void {
  if (configured) return;
  registerHarnessProfile("openai", {
    excludedTools: [...PRODUCTION_EXCLUDED_AGENT_TOOLS],
    excludedMiddleware: [...PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE],
    extraMiddleware: () => [
      createProductionToolProtocolMiddleware(),
      createProductionModelCallFailoverMiddleware(),
    ],
    generalPurposeSubagent: { enabled: false },
  });
  configured = true;
}

/** Visible for a startup assertion and focused regression tests. */
export function assertProductionHarnessConfigured(): void {
  const profile = getHarnessProfile("openai");
  const missing = PRODUCTION_EXCLUDED_AGENT_TOOLS.filter(
    (toolName) => !profile?.excludedTools.has(toolName),
  );
  const missingMiddleware = PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE.filter(
    (middlewareName) => !profile?.excludedMiddleware.has(middlewareName),
  );
  const extraMiddleware = typeof profile?.extraMiddleware === "function"
    ? profile.extraMiddleware()
    : profile?.extraMiddleware ?? [];
  const expectedMiddlewareOrder = [
    PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME,
    PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME,
  ];
  const actualMiddlewareOrder = extraMiddleware.map(
    (middleware) => middleware.name,
  );
  const middlewareOrderCorrect = expectedMiddlewareOrder.length
    === actualMiddlewareOrder.length
    && expectedMiddlewareOrder.every(
      (name, index) => actualMiddlewareOrder[index] === name,
    );
  if (
    missing.length > 0
    || missingMiddleware.length > 0
    || !middlewareOrderCorrect
    || profile?.generalPurposeSubagent?.enabled !== false
  ) {
    throw new Error(
      "Production DeepAgent harness is incomplete; " +
      `missing tool exclusions: ${missing.join(", ") || "none"}; ` +
      `missing middleware exclusions: ${missingMiddleware.join(", ") || "none"}; ` +
      `extra middleware order: ${actualMiddlewareOrder.join(" -> ") || "none"}.`,
    );
  }
}
