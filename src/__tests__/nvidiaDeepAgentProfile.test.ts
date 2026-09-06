import { ProviderManager } from "freetier-deepagent-framework/dist/providers/providerManager.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertNvidiaDeepAgentProfileConfigured,
  configureNvidiaDeepAgentProfile,
  NVIDIA_DEEP_AGENT_MAX_TOKENS,
  NVIDIA_DEEP_AGENT_REASONING_BUDGET,
  NVIDIA_DEEP_AGENT_REASONING_EFFORT,
  NVIDIA_DEEP_AGENT_TEMPERATURE,
  NVIDIA_DEEP_AGENT_TOP_P,
  withNvidiaDeepAgentProfile,
} from "../services/nvidiaDeepAgentProfile.js";

type ModelFields = Record<string, unknown> & {
  modelKwargs?: Record<string, unknown>;
};

type InspectableModel = ReturnType<ProviderManager["getModel"]> & {
  fields?: ModelFields;
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
  it("reconstructs the model and preserves its selected key, model, and endpoint fields", () => {
    const original = new ProviderManager("nvidia").getModel();
    const originalFields = constructionFields(original);

    const configured = withNvidiaDeepAgentProfile(original);
    const configuredFields = constructionFields(configured);

    expect(configured).not.toBe(original);
    expect(configuredFields.apiKey === originalFields.apiKey).toBe(true);
    expect(configuredFields.model).toBe(originalFields.model);
    expect(configuredFields.configuration).toEqual(originalFields.configuration);
  });

  it("carries the full output and bounded high-reasoning profile through bindTools", () => {
    const original = new ProviderManager("nvidia").getModel();
    const params = requestParams(withNvidiaDeepAgentProfile(original));

    expect(params).toMatchObject({
      max_tokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
      temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
      top_p: NVIDIA_DEEP_AGENT_TOP_P,
      reasoning_effort: NVIDIA_DEEP_AGENT_REASONING_EFFORT,
      reasoning_budget: NVIDIA_DEEP_AGENT_REASONING_BUDGET,
    });
  });

  it("installs idempotently, tunes every NVIDIA model, and leaves fallback providers unchanged", () => {
    configureNvidiaDeepAgentProfile();
    const configuredGetModel = ProviderManager.prototype.getModel;
    configureNvidiaDeepAgentProfile();

    expect(ProviderManager.prototype.getModel).toBe(configuredGetModel);
    expect(() => assertNvidiaDeepAgentProfileConfigured()).not.toThrow();

    const nvidiaManager = new ProviderManager("nvidia");
    expect(requestParams(nvidiaManager.getModel())).toMatchObject({
      max_tokens: NVIDIA_DEEP_AGENT_MAX_TOKENS,
      temperature: NVIDIA_DEEP_AGENT_TEMPERATURE,
      top_p: NVIDIA_DEEP_AGENT_TOP_P,
      reasoning_effort: NVIDIA_DEEP_AGENT_REASONING_EFFORT,
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
  });

  it("fails closed if the ChatOpenAI reconstruction seam disappears", () => {
    const model = new ProviderManager("nvidia").getModel();
    Object.defineProperty(model, "fields", { configurable: true, value: undefined });

    expect(() => withNvidiaDeepAgentProfile(model)).toThrow(
      "ChatOpenAI construction fields are unavailable",
    );
  });
});
