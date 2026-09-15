import {
  PROVIDER_ORDER,
  ProviderManager,
} from "freetier-deepagent-framework/dist/providers/providerManager.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertProviderTransportBounds,
  assertNvidiaDeepAgentProfileConfigured,
  configureNvidiaDeepAgentProfile,
  DEEP_AGENT_PROVIDER_HTTP_TIMEOUTS,
  DEEP_AGENT_PROVIDER_MAX_RETRIES,
  DEEP_AGENT_PROVIDER_TIMEOUT_MS,
  NVIDIA_DEEP_AGENT_CHAT_TEMPLATE_KWARGS,
  NVIDIA_DEEP_AGENT_MAX_TOKENS,
  NVIDIA_DEEP_AGENT_REASONING_BUDGET,
  NVIDIA_DEEP_AGENT_TEMPERATURE,
  NVIDIA_DEEP_AGENT_TOP_P,
  withNvidiaDeepAgentProfile,
  withProviderTransportBounds,
} from "../services/nvidiaDeepAgentProfile.js";

type ModelFields = Record<string, unknown> & {
  configuration?: Record<string, unknown>;
  modelKwargs?: Record<string, unknown>;
};

type InspectableModel = ReturnType<ProviderManager["getModel"]> & {
  clientConfig?: Record<string, unknown>;
  fields?: ModelFields;
  timeout?: number;
  caller?: {
    maxRetries?: number;
  };
};

type InvocationParamsModel = {
  invocationParams(options?: unknown): Record<string, unknown>;
};

const originalGetModelDescriptor = Object.getOwnPropertyDescriptor(
  ProviderManager.prototype,
  "getModel",
);
const originalPrototypeSymbols = new Set(
  Object.getOwnPropertySymbols(ProviderManager.prototype),
);

function constructionFields(model: ReturnType<ProviderManager["getModel"]>): ModelFields {
  const fields = (model as InspectableModel).fields;
  if (!fields) throw new Error("Test model did not expose ChatOpenAI construction fields.");
  return fields;
}

function requestParams(model: ReturnType<ProviderManager["getModel"]>): Record<string, unknown> {
  const bound = model.bindTools([]) as unknown as InvocationParamsModel;
  return bound.invocationParams();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object while inspecting the provider transport.");
  }
  return value as Record<string, unknown>;
}

function expectTransportBounds(model: ReturnType<ProviderManager["getModel"]>): void {
  const configured = model as InspectableModel;
  const configuredFields = constructionFields(configured);
  const bound = model.bindTools([]) as unknown as InspectableModel;
  const boundFields = constructionFields(bound);

  expect(configuredFields.timeout).toBe(DEEP_AGENT_PROVIDER_TIMEOUT_MS);
  expect(configuredFields.maxRetries).toBe(DEEP_AGENT_PROVIDER_MAX_RETRIES);
  expect(boundFields.timeout).toBe(DEEP_AGENT_PROVIDER_TIMEOUT_MS);
  expect(boundFields.maxRetries).toBe(DEEP_AGENT_PROVIDER_MAX_RETRIES);
  expect(bound.timeout).toBe(DEEP_AGENT_PROVIDER_TIMEOUT_MS);
  expect(bound.caller?.maxRetries).toBe(DEEP_AGENT_PROVIDER_MAX_RETRIES);

  const configuredConfiguration = record(configuredFields.configuration);
  const boundConfiguration = record(boundFields.configuration);
  const configuredFetchOptions = record(configuredConfiguration.fetchOptions);
  const boundFetchOptions = record(boundConfiguration.fetchOptions);
  const boundClientConfig = record(bound.clientConfig);
  const boundClientFetchOptions = record(boundClientConfig.fetchOptions);

  expect(configuredConfiguration.fetch).toBeTypeOf("function");
  expect(boundConfiguration.fetch).toBe(configuredConfiguration.fetch);
  expect(boundClientConfig.fetch).toBe(configuredConfiguration.fetch);
  expect(configuredFetchOptions.dispatcher).toBeTruthy();
  expect(boundFetchOptions.dispatcher).toBe(configuredFetchOptions.dispatcher);
  expect(boundClientFetchOptions.dispatcher).toBe(
    configuredFetchOptions.dispatcher,
  );
}

afterAll(() => {
  if (originalGetModelDescriptor) {
    Object.defineProperty(
      ProviderManager.prototype,
      "getModel",
      originalGetModelDescriptor,
    );
  }
  for (const symbol of Object.getOwnPropertySymbols(ProviderManager.prototype)) {
    if (!originalPrototypeSymbols.has(symbol)) {
      delete (ProviderManager.prototype as unknown as Record<symbol, unknown>)[symbol];
    }
  }
});

describe("NVIDIA main deep-agent profile", () => {
  it("uses one 30-minute SDK, response-header, and body-inactivity boundary", () => {
    expect(DEEP_AGENT_PROVIDER_TIMEOUT_MS).toBe(1_800_000);
    expect(DEEP_AGENT_PROVIDER_HTTP_TIMEOUTS).toEqual({
      headersTimeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
      bodyTimeout: DEEP_AGENT_PROVIDER_TIMEOUT_MS,
    });
  });

  it("retains enough reasoning capacity to emit complex forced script tool calls", () => {
    expect(NVIDIA_DEEP_AGENT_REASONING_BUDGET).toBe(16_384);
    expect(NVIDIA_DEEP_AGENT_REASONING_BUDGET).toBeLessThan(
      NVIDIA_DEEP_AGENT_MAX_TOKENS,
    );
  });

  it("reconstructs fallback models with bounded transport while preserving provider fields", () => {
    const original = new ProviderManager("anyapi").getModel();
    const originalFields = constructionFields(original);

    const configured = withProviderTransportBounds(original);
    const configuredFields = constructionFields(configured);

    expect(configured).not.toBe(original);
    expect(configuredFields.apiKey === originalFields.apiKey).toBe(true);
    expect(configuredFields.model).toBe(originalFields.model);
    expect(record(configuredFields.configuration).baseURL).toBe(
      record(originalFields.configuration).baseURL,
    );
    expect(configuredFields.temperature).toBe(originalFields.temperature);
    expect(configuredFields.modelKwargs).toEqual(originalFields.modelKwargs);
    expectTransportBounds(configured);
    expect(() => assertProviderTransportBounds(configured, "anyapi")).not.toThrow();
  });

  it("reconstructs the model and preserves its selected key, model, and endpoint fields", () => {
    const original = new ProviderManager("nvidia").getModel();
    const originalFields = constructionFields(original);

    const configured = withNvidiaDeepAgentProfile(original);
    const configuredFields = constructionFields(configured);

    expect(configured).not.toBe(original);
    expect(configuredFields.apiKey === originalFields.apiKey).toBe(true);
    expect(configuredFields.model).toBe(originalFields.model);
    expect(record(configuredFields.configuration).baseURL).toBe(
      record(originalFields.configuration).baseURL,
    );
    expectTransportBounds(configured);
  });

  it("carries the full output and bounded low-effort reasoning profile through bindTools", () => {
    const original = new ProviderManager("nvidia").getModel();
    const params = requestParams(withNvidiaDeepAgentProfile(original));

    expect(params).toMatchObject({
      max_tokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
      temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
      top_p: NVIDIA_DEEP_AGENT_TOP_P,
      chat_template_kwargs: NVIDIA_DEEP_AGENT_CHAT_TEMPLATE_KWARGS,
      reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
    });
    expect(params.reasoning_effort).toBeUndefined();
  });

  it("installs idempotently, bounds every provider, and tunes only NVIDIA quality", () => {
    configureNvidiaDeepAgentProfile();
    const configuredGetModel = ProviderManager.prototype.getModel;
    configureNvidiaDeepAgentProfile();

    expect(ProviderManager.prototype.getModel).toBe(configuredGetModel);
    expect(() => assertNvidiaDeepAgentProfileConfigured()).not.toThrow();

    for (const providerName of PROVIDER_ORDER) {
      expectTransportBounds(new ProviderManager(providerName).getModel());
    }

    const nvidiaManager = new ProviderManager("nvidia");
    expect(requestParams(nvidiaManager.getModel())).toMatchObject({
      max_tokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
      temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
      top_p: NVIDIA_DEEP_AGENT_TOP_P,
      chat_template_kwargs: NVIDIA_DEEP_AGENT_CHAT_TEMPLATE_KWARGS,
      reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
    });

    const originalKeyIndex = nvidiaManager.currentNvidiaKeyIndex;
    const nextProvider = nvidiaManager.switchToNext();
    if (nextProvider === "nvidia") {
      expect(nvidiaManager.currentNvidiaKeyIndex).toBe(originalKeyIndex + 1);
      expect(requestParams(nvidiaManager.getModel())).toMatchObject({
        max_tokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
        reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
      });
    }

    const fallbackParams = requestParams(new ProviderManager("anyapi").getModel());
    expect(fallbackParams.max_tokens).not.toBe(NVIDIA_DEEP_AGENT_MAX_TOKENS);
    expect(fallbackParams.max_completion_tokens).not.toBe(NVIDIA_DEEP_AGENT_MAX_TOKENS);
    expect(fallbackParams.reasoning_budget).toBeUndefined();
    expect(fallbackParams.chat_template_kwargs).toBeUndefined();
  });

  it("fails closed if transport bounds disappear during tool binding", () => {
    configureNvidiaDeepAgentProfile();
    const configuredGetModel = ProviderManager.prototype.getModel;
    const rawGetModel = originalGetModelDescriptor?.value;
    if (typeof rawGetModel !== "function") {
      throw new Error("ProviderManager.getModel test seam is unavailable.");
    }

    Object.defineProperty(ProviderManager.prototype, "getModel", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function getModelWithUnsafeBinding(this: ProviderManager) {
        const configured = configuredGetModel.call(this);
        Object.defineProperty(configured, "bindTools", {
          configurable: true,
          value: () => rawGetModel.call(this),
        });
        return configured;
      },
    });

    try {
      expect(() => assertNvidiaDeepAgentProfileConfigured()).toThrow(
        "transport bounds did not survive tool binding",
      );
    } finally {
      Object.defineProperty(ProviderManager.prototype, "getModel", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: configuredGetModel,
      });
    }
  });

  it("fails closed if the ChatOpenAI reconstruction seam disappears", () => {
    const model = new ProviderManager("nvidia").getModel();
    Object.defineProperty(model, "fields", { configurable: true, value: undefined });

    expect(() => withNvidiaDeepAgentProfile(model)).toThrow(
      "ChatOpenAI construction fields are unavailable",
    );
  });
});
