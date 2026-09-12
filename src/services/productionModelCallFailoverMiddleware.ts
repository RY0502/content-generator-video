import type { ModelRequest } from "langchain";
import { createMiddleware } from "langchain";
import {
  ProviderManager,
  type ProviderName,
} from "freetier-deepagent-framework/dist/providers/providerManager.js";
import {
  classifyProviderError,
  type ErrorKind,
} from "freetier-deepagent-framework/dist/providers/errorClassifier.js";
import {
  DEEP_AGENT_PROVIDER_MAX_RETRIES,
  DEEP_AGENT_PROVIDER_TIMEOUT_MS,
} from "./nvidiaDeepAgentProfile.js";

export const PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME =
  "ProductionModelCallFailoverMiddleware";

export const PRODUCTION_MODEL_CALL_TIMEOUT_MS = DEEP_AGENT_PROVIDER_TIMEOUT_MS;

export const PRODUCTION_MODEL_PROVIDER_POOL_EXHAUSTED_CODE =
  "PRODUCTION_MODEL_PROVIDER_POOL_EXHAUSTED";

type Model = ModelRequest["model"];

/** The small ProviderManager surface used by the middleware and its tests. */
export type ProductionProviderManager = {
  readonly current: ProviderName;
  readonly currentNvidiaKeyIndex: number;
  readonly currentAnyApiKeyIndex: number;
  getModel(): Model;
  switchToNext(): ProviderName | null;
};

export type ProductionModelCallFailoverOptions = {
  /** Production always starts the framework runner on NVIDIA. */
  primaryProvider?: ProviderName;
  /** Injectable only so the retry state machine can be tested without network calls. */
  providerManagerFactory?: (
    primaryProvider: ProviderName,
  ) => ProductionProviderManager;
  classifyError?: (error: unknown) => ErrorKind;
};

type SafeErrorMetadata = {
  name: string;
  status?: number;
  code?: string;
};

type CandidateFailureKind = ErrorKind | "access_denied";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCauseChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    chain.length < 16
    && isRecord(current)
    && !seen.has(current)
  ) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * Authentication and permission failures belong to one model candidate, not
 * to the episode workflow. OpenAI-compatible SDKs normally expose `status`,
 * and LangChain's MiddlewareError retains that object down its `cause` chain.
 * Deliberately do not infer access failure from message text: model/schema
 * errors may legitimately contain strings such as "403 Access denied".
 */
function isProviderAccessFailure(error: unknown): boolean {
  return errorCauseChain(error).some((entry) => {
    const status = typeof entry.status === "number"
      ? entry.status
      : typeof entry.statusCode === "number"
        ? entry.statusCode
        : null;
    return status === 401 || status === 403;
  });
}

function candidateFailureKind(
  error: unknown,
  classifyError: (error: unknown) => ErrorKind,
): CandidateFailureKind {
  return isProviderAccessFailure(error)
    ? "access_denied"
    : classifyError(error);
}

/**
 * Provider failures can contain request bodies in their message/stack. Keep
 * production logs useful without ever copying either field into them.
 */
function safeErrorMetadata(error: unknown): SafeErrorMetadata {
  const record = isRecord(error) ? error : null;
  const status = record === null
    ? undefined
    : typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : undefined;
  const rawCode = record?.code;
  const code = typeof rawCode === "string" && rawCode.length <= 80
    ? rawCode
    : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  };
}

function providerCandidateLabel(manager: ProductionProviderManager): string {
  if (manager.current === "nvidia") {
    return `nvidia-key-${manager.currentNvidiaKeyIndex + 1}`;
  }
  if (manager.current === "anyapi") {
    return `anyapi-key-${manager.currentAnyApiKeyIndex + 1}`;
  }
  return manager.current;
}

/**
 * This error deliberately has a stable, provider-neutral message. The
 * framework's outer runner classifies errors from their top-level message; a
 * copied timeout/429 message would make it start a second provider rotation
 * around an already exhausted in-turn rotation.
 */
export class ProductionModelProviderPoolExhaustedError extends Error {
  readonly code = PRODUCTION_MODEL_PROVIDER_POOL_EXHAUSTED_CODE;
  readonly attempts: number;

  constructor(lastError: unknown, attempts: number) {
    super("No production model candidate completed the request.", {
      cause: lastError,
    });
    this.name = "ProductionModelProviderPoolExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Rotates model calls, not whole graph executions. Therefore a timeout can be
 * retried safely before ToolNode sees a response, without replaying any domain
 * tool that already completed on an earlier agent turn.
 *
 * The ProviderManager cursor begins at the primary model. We invoke that model
 * through the supplied request, then call switchToNext() before constructing
 * the first fallback so keys and providers retain the framework's configured
 * order. A successful fallback remains selected for all later model turns in
 * this agent invocation.
 */
export function createProductionModelCallFailoverMiddleware(
  options: ProductionModelCallFailoverOptions = {},
) {
  const primaryProvider = options.primaryProvider ?? "nvidia";
  const manager = (options.providerManagerFactory
    ?? ((provider: ProviderName) => new ProviderManager(provider)))(
      primaryProvider,
    );
  const classifyError = options.classifyError ?? classifyProviderError;

  let stickyFallbackModel: Model | null = null;
  let stickyFallbackLabel: string | null = null;

  return createMiddleware({
    name: PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const boundedSettings = {
        ...request.modelSettings,
        timeout: PRODUCTION_MODEL_CALL_TIMEOUT_MS,
        maxRetries: DEEP_AGENT_PROVIDER_MAX_RETRIES,
      };
      let attempts = 1;
      let activeLabel = stickyFallbackLabel
        ?? providerCandidateLabel(manager);
      const firstRequest = {
        ...request,
        ...(stickyFallbackModel === null
          ? {}
          : { model: stickyFallbackModel }),
        modelSettings: boundedSettings,
      };

      try {
        return await handler(firstRequest);
      } catch (error) {
        const kind = candidateFailureKind(error, classifyError);
        if (kind === "fatal") throw error;

        let lastError = error;
        let lastKind = kind;
        while (true) {
          const previousLabel = activeLabel;
          const next = manager.switchToNext();
          if (next === null) {
            console.error(
              "[production-model-failover] Configured model candidates exhausted",
              {
                provider: previousLabel,
                kind: lastKind,
                attempts,
                error: safeErrorMetadata(lastError),
              },
            );
            throw new ProductionModelProviderPoolExhaustedError(
              lastError,
              attempts,
            );
          }

          activeLabel = providerCandidateLabel(manager);
          console.warn(
            "[production-model-failover] Switching model candidate",
            {
              from: previousLabel,
              to: activeLabel,
              kind: lastKind,
              error: safeErrorMetadata(lastError),
            },
          );

          const fallbackModel = manager.getModel();
          attempts += 1;
          try {
            const response = await handler({
              ...request,
              model: fallbackModel,
              modelSettings: boundedSettings,
            });
            stickyFallbackModel = fallbackModel;
            stickyFallbackLabel = activeLabel;
            console.info(
              "[production-model-failover] Model candidate succeeded",
              { provider: activeLabel, attempts },
            );
            return response;
          } catch (fallbackError) {
            const fallbackKind = candidateFailureKind(
              fallbackError,
              classifyError,
            );
            if (fallbackKind === "fatal") throw fallbackError;
            lastError = fallbackError;
            lastKind = fallbackKind;
          }
        }
      }
    },
  });
}
