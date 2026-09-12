import {
  PROVIDER_ORDER,
  ProviderManager,
} from "freetier-deepagent-framework/dist/providers/providerManager.js";
import { Agent, fetch as undiciFetch } from "undici";

/** Allow one complex production LLM turn to run for up to 30 minutes. */
export const DEEP_AGENT_PROVIDER_TIMEOUT_MS = 30 * 60_000;
export const DEEP_AGENT_PROVIDER_MAX_RETRIES = 0;
export const DEEP_AGENT_PROVIDER_HTTP_TIMEOUTS = Object.freeze({
  headersTimeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
  bodyTimeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
});
export const NVIDIA_DEEP_AGENT_MAX_TOKENS = 32_768;
/**
 * Keep the hard thinking allowance below the observed failure boundary so a
 * long internal plan cannot consume the response before the structured tool
 * call. The full completion allowance remains available for detailed scenes.
 */
export const NVIDIA_DEEP_AGENT_REASONING_BUDGET = 2_048;
export const NVIDIA_DEEP_AGENT_TEMPERATURE = 1;
export const NVIDIA_DEEP_AGENT_TOP_P = 0.95;
export const NVIDIA_DEEP_AGENT_CHAT_TEMPLATE_KWARGS = Object.freeze({
  enable_thinking: true,
  low_effort: true,
  force_nonempty_content: true,
});

const INSTALL_MARKER = Symbol.for(
  "content-generator.nvidia-deep-agent-profile.installed",
);

type ProviderModel = ReturnType<ProviderManager["getModel"]>;

type ProviderModelFields = Record<string, unknown> & {
  configuration?: Record<string, unknown>;
  modelKwargs?: Record<string, unknown>;
};

type ModelWithConstructionFields = ProviderModel & {
  /**
   * ChatOpenAI keeps its constructor input here and uses it again when
   * bindTools()/withConfig() creates the runnable model used by DeepAgents.
   */
  fields?: ProviderModelFields;
  clientConfig?: Record<string, unknown>;
  timeout?: number;
  caller?: {
    maxRetries?: number;
  };
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

function constructionFields(model: ProviderModel): ProviderModelFields {
  const fields = (model as ModelWithConstructionFields).fields;
  if (!isRecord(fields)) {
    throw new Error(
      "Cannot configure the deep-agent provider model: ChatOpenAI construction fields are unavailable.",
    );
  }
  return fields;
}

function reconstructProviderModel(
  model: ProviderModel,
  fields: ProviderModelFields,
): ProviderModel {
  const ModelConstructor = model.constructor as unknown as new (
    fields: ProviderModelFields,
  ) => ProviderModel;
  if (typeof ModelConstructor !== "function") {
    throw new Error(
      "Cannot configure the deep-agent provider model: ChatOpenAI constructor is unavailable.",
    );
  }
  return new ModelConstructor(fields);
}

/**
 * OpenAI's SDK timeout does not override Node fetch's shorter response-header
 * and body-inactivity limits. Use the matching Undici fetch and one shared
 * dispatcher so both transport layers honor the same 30-minute boundary.
 */
const providerHttpDispatcher = new Agent(DEEP_AGENT_PROVIDER_HTTP_TIMEOUTS);

function withProviderHttpTransport(
  fields: ProviderModelFields,
): ProviderModelFields {
  const configuration = isRecord(fields.configuration)
    ? fields.configuration
    : {};
  const fetchOptions = isRecord(configuration.fetchOptions)
    ? configuration.fetchOptions
    : {};

  return {
    ...fields,
    configuration: {
      ...configuration,
      fetch: undiciFetch,
      fetchOptions: {
        ...fetchOptions,
        dispatcher: providerHttpDispatcher,
      },
    },
  };
}

function hasProviderHttpTransport(fields: ProviderModelFields): boolean {
  const configuration = fields.configuration;
  if (!isRecord(configuration) || configuration.fetch !== undiciFetch) {
    return false;
  }
  const fetchOptions = configuration.fetchOptions;
  return isRecord(fetchOptions)
    && fetchOptions.dispatcher === providerHttpDispatcher;
}

/**
 * Reconstructs any ProviderManager ChatOpenAI model with one bounded request
 * and no hidden LangChain retries. ProviderManager remains responsible for
 * explicit key/provider failover after the bounded request returns.
 */
export function withProviderTransportBounds(model: ProviderModel): ProviderModel {
  const fields = constructionFields(model);
  return reconstructProviderModel(model, {
    ...withProviderHttpTransport(fields),
    timeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
    maxRetries: DEEP_AGENT_PROVIDER_MAX_RETRIES,
  });
}

/** Verifies the live and reconstructable transport state after tool binding. */
export function assertProviderTransportBounds(
  model: ProviderModel,
  providerName = "unknown",
): void {
  const configuredFields = constructionFields(model);
  const boundModel = model.bindTools([]) as unknown as ProviderModel;
  const boundFields = constructionFields(boundModel);
  const liveBoundModel = boundModel as ModelWithConstructionFields;
  const liveClientConfig = liveBoundModel.clientConfig;

  if (
    configuredFields.timeout !== DEEP_AGENT_PROVIDER_TIMEOUT_MS
    || configuredFields.maxRetries !== DEEP_AGENT_PROVIDER_MAX_RETRIES
    || boundFields.timeout !== DEEP_AGENT_PROVIDER_TIMEOUT_MS
    || boundFields.maxRetries !== DEEP_AGENT_PROVIDER_MAX_RETRIES
    || liveBoundModel.timeout !== DEEP_AGENT_PROVIDER_TIMEOUT_MS
    || liveBoundModel.caller?.maxRetries !== DEEP_AGENT_PROVIDER_MAX_RETRIES
    || !hasProviderHttpTransport(configuredFields)
    || !hasProviderHttpTransport(boundFields)
    || !isRecord(liveClientConfig)
    || liveClientConfig.fetch !== undiciFetch
    || !isRecord(liveClientConfig.fetchOptions)
    || liveClientConfig.fetchOptions.dispatcher !== providerHttpDispatcher
  ) {
    throw new Error(
      `The ${providerName} deep-agent transport bounds did not survive tool binding; `
      + "refusing to run with unbounded provider requests or hidden retries.",
    );
  }
}

/**
 * Reconstructs the NVIDIA ChatOpenAI model instead of mutating it. LangChain's
 * bindTools() creates another ChatOpenAI instance from the original protected
 * `fields`, so mutating only maxTokens/modelKwargs on the first instance would
 * silently lose the production limits before the first request.
 */
export function withNvidiaDeepAgentProfile(model: ProviderModel): ProviderModel {
  const fields = constructionFields(model);
  const modelKwargs = isRecord(fields.modelKwargs) ? fields.modelKwargs : {};
  const chatTemplateKwargs = isRecord(modelKwargs.chat_template_kwargs)
    ? modelKwargs.chat_template_kwargs
    : {};

  return reconstructProviderModel(model, {
    ...withProviderHttpTransport(fields),
    timeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
    maxRetries: DEEP_AGENT_PROVIDER_MAX_RETRIES,
    maxTokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
    temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
    topP: NVIDIA_DEEP_AGENT_TOP_P,
    modelKwargs: {
      ...modelKwargs,
      chat_template_kwargs: {
        ...chatTemplateKwargs,
        ...NVIDIA_DEEP_AGENT_CHAT_TEMPLATE_KWARGS,
      },
      reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
    },
  });
}

/**
 * Installs a process-local profile at the framework's provider factory seam.
 * The original ProviderManager still selects keys, classifies failures, and
 * rotates providers. Every created model gets bounded transport behavior;
 * only models created for its NVIDIA branch get NVIDIA quality settings.
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
        : withProviderTransportBounds(model);
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
 * stops carrying any provider's transport bounds or NVIDIA's quality limits
 * through bindTools() to the actual request.
 */
export function assertNvidiaDeepAgentProfileConfigured(): void {
  const prototype = ProviderManager.prototype as ProviderManagerPrototype;
  if (prototype[INSTALL_MARKER] !== true) {
    throw new Error("The NVIDIA deep-agent model profile was not installed.");
  }

  for (const providerName of PROVIDER_ORDER) {
    assertProviderTransportBounds(
      new ProviderManager(providerName).getModel(),
      providerName,
    );
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
    || !isRecord(params.chat_template_kwargs)
    || params.chat_template_kwargs.enable_thinking !== true
    || params.chat_template_kwargs.low_effort !== true
    || params.chat_template_kwargs.force_nonempty_content !== true
    || params.reasoning_budget !== NVIDIA_DEEP_AGENT_REASONING_BUDGET
  ) {
    throw new Error(
      "The NVIDIA deep-agent model profile did not survive tool binding; refusing to run with an unsafe output budget.",
    );
  }
}
