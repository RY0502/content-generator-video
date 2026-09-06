import { ProviderManager } from "freetier-deepagent-framework/dist/providers/providerManager.js";

export const NVIDIA_DEEP_AGENT_MAX_TOKENS = 32_768;
export const NVIDIA_DEEP_AGENT_REASONING_BUDGET = 8_192;
export const NVIDIA_DEEP_AGENT_REASONING_EFFORT = "high";
export const NVIDIA_DEEP_AGENT_TEMPERATURE = 1;
export const NVIDIA_DEEP_AGENT_TOP_P = 0.95;

const INSTALL_MARKER = Symbol.for(
  "content-generator.nvidia-deep-agent-profile.installed",
);

type ProviderModel = ReturnType<ProviderManager["getModel"]>;

type ProviderModelFields = Record<string, unknown> & {
  modelKwargs?: Record<string, unknown>;
};

type ModelWithConstructionFields = ProviderModel & {
  /**
   * ChatOpenAI keeps its constructor input here and uses it again when
   * bindTools()/withConfig() creates the runnable model used by DeepAgents.
   */
  fields?: ProviderModelFields;
};

type ProviderManagerPrototype = typeof ProviderManager.prototype & {
  [INSTALL_MARKER]?: boolean;
};

type InvocationParamsModel = {
  invocationParams(options?: unknown): Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reconstructs the NVIDIA ChatOpenAI model instead of mutating it. LangChain's
 * bindTools() creates another ChatOpenAI instance from the original protected
 * `fields`, so mutating only maxTokens/modelKwargs on the first instance would
 * silently lose the production limits before the first request.
 */
export function withNvidiaDeepAgentProfile(model: ProviderModel): ProviderModel {
  const fields = (model as ModelWithConstructionFields).fields;
  if (!isRecord(fields)) {
    throw new Error(
      "Cannot configure the NVIDIA deep-agent model: ChatOpenAI construction fields are unavailable.",
    );
  }

  const ModelConstructor = model.constructor as unknown as new (
    fields: ProviderModelFields,
  ) => ProviderModel;
  if (typeof ModelConstructor !== "function") {
    throw new Error(
      "Cannot configure the NVIDIA deep-agent model: ChatOpenAI constructor is unavailable.",
    );
  }

  return new ModelConstructor({
    ...fields,
    maxTokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
    temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
    topP: NVIDIA_DEEP_AGENT_TOP_P,
    modelKwargs: {
      ...(isRecord(fields.modelKwargs) ? fields.modelKwargs : {}),
      reasoning_effort: NVIDIA_DEEP_AGENT_REASONING_EFFORT,
      reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
    },
  });
}

/**
 * Installs a process-local profile at the framework's provider factory seam.
 * The original ProviderManager still selects keys, classifies failures, and
 * rotates providers; only models created for its NVIDIA branch are rebuilt.
 */
export function configureNvidiaDeepAgentProfile(): void {
  const prototype = ProviderManager.prototype as ProviderManagerPrototype;
  if (prototype[INSTALL_MARKER] === true) return;

  const originalGetModel = prototype.getModel;
  if (typeof originalGetModel !== "function") {
    throw new Error(
      "Cannot configure the NVIDIA deep-agent model: ProviderManager.getModel is unavailable.",
    );
  }

  Object.defineProperty(prototype, "getModel", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function configuredGetModel(this: ProviderManager): ProviderModel {
      const model = originalGetModel.call(this);
      return this.current === "nvidia"
        ? withNvidiaDeepAgentProfile(model)
        : model;
    },
  });
  Object.defineProperty(prototype, INSTALL_MARKER, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: true,
  });
}

/**
 * Fails before a paid/slow generation if a framework or LangChain upgrade
 * stops carrying the NVIDIA limits through bindTools() to the actual request.
 */
export function assertNvidiaDeepAgentProfileConfigured(): void {
  const prototype = ProviderManager.prototype as ProviderManagerPrototype;
  if (prototype[INSTALL_MARKER] !== true) {
    throw new Error("The NVIDIA deep-agent model profile was not installed.");
  }

  const configuredModel = new ProviderManager("nvidia").getModel();
  const boundModel = configuredModel.bindTools([]) as unknown as InvocationParamsModel;
  if (typeof boundModel.invocationParams !== "function") {
    throw new Error(
      "Cannot verify the NVIDIA deep-agent model: bound invocation parameters are unavailable.",
    );
  }
  const params = boundModel.invocationParams();
  if (
    params.max_tokens !== NVIDIA_DEEP_AGENT_MAX_TOKENS
    || params.temperature !== NVIDIA_DEEP_AGENT_TEMPERATURE
    || params.top_p !== NVIDIA_DEEP_AGENT_TOP_P
    || params.reasoning_effort !== NVIDIA_DEEP_AGENT_REASONING_EFFORT
    || params.reasoning_budget !== NVIDIA_DEEP_AGENT_REASONING_BUDGET
  ) {
    throw new Error(
      "The NVIDIA deep-agent model profile did not survive tool binding; refusing to run with an unsafe output budget.",
    );
  }
}
