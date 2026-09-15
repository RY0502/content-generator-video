import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { classifyProviderError } from "freetier-deepagent-framework/dist/providers/errorClassifier.js";
import type { ProviderName } from "freetier-deepagent-framework/dist/providers/providerManager.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProductionModelCallFailoverMiddleware,
  PRODUCTION_MODEL_CALL_TIMEOUT_MS,
  ProductionModelProviderPoolExhaustedError,
  type ProductionProviderManager,
} from "../services/productionModelCallFailoverMiddleware.js";
import {
  createProductionToolProtocolMiddleware,
  ProductionToolCallProtocolError,
} from "../services/productionToolProtocolMiddleware.js";

type Candidate = {
  provider: ProviderName;
  model: object;
  nvidiaKeyIndex?: number;
  anyApiKeyIndex?: number;
};

function fakeManager(candidates: Candidate[]) {
  let index = 0;
  const getModel = vi.fn(() => candidates[index]!.model as any);
  const switchToNext = vi.fn(() => {
    if (index + 1 >= candidates.length) return null;
    index += 1;
    return candidates[index]!.provider;
  });
  const manager: ProductionProviderManager = {
    get current() {
      return candidates[index]!.provider;
    },
    get currentNvidiaKeyIndex() {
      return candidates[index]!.nvidiaKeyIndex ?? 0;
    },
    get currentAnyApiKeyIndex() {
      return candidates[index]!.anyApiKeyIndex ?? 0;
    },
    getModel,
    switchToNext,
  };
  return { manager, getModel, switchToNext };
}

function modelRequest(model: object) {
  const messages = [new HumanMessage("Continue the durable episode workflow.")];
  const tools = [{ name: "get_next_episode" }] as any[];
  const systemMessage = new SystemMessage("Production contract.");
  const toolChoice = {
    type: "function" as const,
    function: { name: "get_next_episode" },
  };
  const state = { messages };
  const runtime = { configurable: { thread_id: "run-1" } } as any;
  return {
    model: model as any,
    messages,
    tools,
    systemPrompt: systemMessage.text,
    systemMessage,
    toolChoice,
    state,
    runtime,
    modelSettings: {
      temperature: 0.25,
      headers: { "x-safe-header": "retained" },
      timeout: 12,
      maxRetries: 9,
    },
  };
}

function response(content = "ok") {
  return new AIMessage(content);
}

function lengthLimitedResponse() {
  return new AIMessage({
    content: "",
    response_metadata: { finish_reason: "length" },
    usage_metadata: {
      input_tokens: 10_836,
      output_tokens: 2_111,
      total_tokens: 12_947,
      output_token_details: { reasoning: 2_110 },
    },
  });
}

function toolCallResponse(name = "get_next_episode") {
  return new AIMessage({
    content: "",
    tool_calls: [{
      id: `${name}-call`,
      name,
      args: {},
      type: "tool_call",
    }],
  });
}

async function invoke(
  middleware: ReturnType<typeof createProductionModelCallFailoverMiddleware>,
  request: ReturnType<typeof modelRequest>,
  handler: ReturnType<typeof vi.fn>,
) {
  expect(middleware.wrapModelCall).toBeTypeOf("function");
  return middleware.wrapModelCall!(request as any, handler as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production model-call failover middleware", () => {
  it("bounds a successful primary request while preserving all other request fields", async () => {
    const primary = { id: "primary" };
    const pool = fakeManager([{ provider: "nvidia", model: primary }]);
    const expected = response();
    const handler = vi.fn().mockResolvedValue(expected);
    const request = modelRequest(primary);
    const middleware = createProductionModelCallFailoverMiddleware({
      providerManagerFactory: () => pool.manager,
    });

    expect(await invoke(middleware, request, handler)).toBe(expected);
    expect(pool.switchToNext).not.toHaveBeenCalled();
    expect(pool.getModel).not.toHaveBeenCalled();

    const delegated = handler.mock.calls[0]![0];
    expect(delegated).toMatchObject({
      model: primary,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      systemMessage: request.systemMessage,
      state: request.state,
      runtime: request.runtime,
      modelSettings: {
        temperature: 0.25,
        headers: { "x-safe-header": "retained" },
        timeout: PRODUCTION_MODEL_CALL_TIMEOUT_MS,
        maxRetries: 0,
      },
    });
    expect(delegated.messages).toBe(request.messages);
    expect(delegated.tools).toBe(request.tools);
    expect(delegated.toolChoice).toBe(request.toolChoice);
  });

  it("switches to the candidate after the primary on a retryable error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "nvidia-key-2" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary, nvidiaKeyIndex: 0 },
      { provider: "nvidia", model: fallback, nvidiaKeyIndex: 1 },
    ]);
    const expected = response("fallback");
    const timeout = new Error("Request timed out after the provider deadline");
    const handler = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(expected);
    const request = modelRequest(primary);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      request,
      handler,
    )).toBe(expected);

    expect(pool.switchToNext).toHaveBeenCalledTimes(1);
    expect(pool.getModel).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].model).toBe(primary);
    expect(handler.mock.calls[1]![0].model).toBe(fallback);
    expect(handler.mock.calls[1]![0].messages).toBe(request.messages);
    expect(handler.mock.calls[1]![0].tools).toBe(request.tools);
    expect(handler.mock.calls[1]![0].toolChoice).toBe(request.toolChoice);
    expect(handler.mock.calls[1]![0].modelSettings).toEqual({
      temperature: 0.25,
      headers: { "x-safe-header": "retained" },
      timeout: PRODUCTION_MODEL_CALL_TIMEOUT_MS,
      maxRetries: 0,
    });
  });

  it("switches candidates when a forced exact tool response exhausts its output on reasoning", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const expected = toolCallResponse();
    const handler = vi.fn()
      .mockResolvedValueOnce(lengthLimitedResponse())
      .mockResolvedValueOnce(expected);
    const request = modelRequest(primary);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      request,
      handler,
    )).toBe(expected);

    expect(handler.mock.calls.map(([candidateRequest]) => candidateRequest.model)).toEqual([
      primary,
      fallback,
    ]);
    expect(handler.mock.calls[1]![0].toolChoice).toBe(request.toolChoice);
    expect(pool.switchToNext).toHaveBeenCalledOnce();
  });

  it("does not rotate a length-limited response when tool choice is automatic", async () => {
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const expected = lengthLimitedResponse();
    const handler = vi.fn().mockResolvedValue(expected);
    const request = {
      ...modelRequest(primary),
      toolChoice: "auto" as const,
    };

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      request as unknown as ReturnType<typeof modelRequest>,
      handler,
    )).toBe(expected);
    expect(handler).toHaveBeenCalledOnce();
    expect(pool.switchToNext).not.toHaveBeenCalled();
  });

  it("does not rotate a length-limited response that contains a parsed tool call", async () => {
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const expected = new AIMessage({
      content: "",
      response_metadata: { finish_reason: "length" },
      tool_calls: [{
        id: "get-next-call",
        name: "get_next_episode",
        args: {},
        type: "tool_call",
      }],
    });
    const handler = vi.fn().mockResolvedValue(expected);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).toBe(expected);
    expect(handler).toHaveBeenCalledOnce();
    expect(pool.switchToNext).not.toHaveBeenCalled();
  });

  it("exhausts each candidate once when every forced response ends at length without a tool call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const handler = vi.fn().mockImplementation(async () => lengthLimitedResponse());

    let thrown: unknown;
    try {
      await invoke(
        createProductionModelCallFailoverMiddleware({
          providerManagerFactory: () => pool.manager,
        }),
        modelRequest(primary),
        handler,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProductionModelProviderPoolExhaustedError);
    expect((thrown as ProductionModelProviderPoolExhaustedError).attempts).toBe(2);
    expect((thrown as Error).cause).toMatchObject({
      name: expect.stringMatching(/Length|Truncat|Incomplete/u),
    });
    expect(handler.mock.calls.map(([candidateRequest]) => candidateRequest.model)).toEqual([
      primary,
      fallback,
    ]);
    expect(pool.switchToNext).toHaveBeenCalledTimes(2);
  });

  it("lets the protocol guard accept a fallback forced tool call without a same-candidate correction retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const expected = toolCallResponse("get_or_create_series");
    const baseHandler = vi.fn()
      .mockResolvedValueOnce(lengthLimitedResponse())
      .mockResolvedValueOnce(expected);
    const failover = createProductionModelCallFailoverMiddleware({
      providerManagerFactory: () => pool.manager,
    });
    const failoverHandler = vi.fn((candidateRequest) =>
      failover.wrapModelCall!(candidateRequest as any, baseHandler as any)
    );
    const protocol = createProductionToolProtocolMiddleware();
    const request = {
      ...modelRequest(primary),
      tools: [{ name: "get_or_create_series" }] as any[],
      toolChoice: "auto" as const,
    };

    expect(await protocol.wrapModelCall!(
      request as any,
      failoverHandler as any,
    )).toBe(expected);
    expect(failoverHandler).toHaveBeenCalledOnce();
    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(baseHandler.mock.calls.map(([candidateRequest]) => candidateRequest.model)).toEqual([
      primary,
      fallback,
    ]);
  });

  it("rotates a length-limited durable restart and preserves the exact restart contract", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const authoringPlan = {
      storyArc: "The complete rescue is rewritten as a coherent visual journey.",
      educationalIdea: "Careful observation helps friends solve problems.",
      endingInsight: "Patient teamwork can guide everyone safely home.",
      beats: [{
        startScene: 1,
        endScene: 50,
        storyBeat: "The friends discover, investigate, and resolve the rescue.",
        setting: "A bright valley beside the clubhouse.",
        continuityOutcome: "Everyone returns safely with the clue preserved.",
      }],
      supportingEntityBible: [],
      continuityBible: [],
    };
    const scenes = Array.from({ length: 8 }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: `Narration for exact restart scene ${index + 1}.`,
      sceneDetails: {
        action: `The friends complete visual beat ${index + 1}.`,
      },
    }));
    const fallbackResponse = new AIMessage({
      content: "",
      tool_calls: [{
        id: "restart-chunk-call",
        name: "write_episode_script_chunk",
        args: {
          // These stale model-owned routing values must be rebound from the
          // durable get_next_episode receipt before ToolNode can execute them.
          episodeId: 999,
          operation: "append",
          expectedDraftRevision: 1,
          targetSceneCount: 99,
          minimumReplacementSpokenWords: 750,
          authoringPlan: { storyArc: "stale plan" },
          scenes,
        },
        type: "tool_call",
      }],
    });
    const baseHandler = vi.fn()
      .mockResolvedValueOnce(lengthLimitedResponse())
      .mockResolvedValueOnce(fallbackResponse);
    const failover = createProductionModelCallFailoverMiddleware({
      providerManagerFactory: () => pool.manager,
    });
    const failoverHandler = vi.fn((candidateRequest) =>
      failover.wrapModelCall!(candidateRequest as any, baseHandler as any)
    );
    const protocol = createProductionToolProtocolMiddleware();
    const getNextCallId = "get-next-episode-call";
    const request = {
      ...modelRequest(primary),
      messages: [
        new HumanMessage("Continue the durable episode workflow."),
        new AIMessage({
          content: "",
          tool_calls: [{
            id: getNextCallId,
            name: "get_next_episode",
            args: { seriesId: 13 },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          name: "get_next_episode",
          tool_call_id: getNextCallId,
          content: JSON.stringify({
            kind: "ready",
            episode: { id: 129, seriesId: 13, episodeNumber: 4 },
            resumeAction: "script_authoring",
            scriptDraft: {
              episodeId: 129,
              revision: 6,
              authoringProgress: {
                requiredAction: "restart_script_authoring",
                targetSceneCount: 50,
                minimumSpokenWords: 831,
                nextSceneNumber: 1,
                nextSceneEnd: 8,
                authoringPlan,
              },
            },
          }),
        }),
      ],
      tools: [
        { name: "get_or_create_series" },
        { name: "get_next_episode" },
        { name: "write_episode_script_chunk" },
      ] as any[],
      toolChoice: "auto" as const,
    };

    const result = await protocol.wrapModelCall!(
      request as any,
      failoverHandler as any,
    ) as AIMessage;
    const args = result.tool_calls?.[0]?.args as Record<string, unknown>;

    expect(result.tool_calls?.[0]?.name).toBe("write_episode_script_chunk");
    expect(args).toMatchObject({
      episodeId: 129,
      operation: "restart",
      expectedDraftRevision: 6,
      targetSceneCount: 50,
      minimumReplacementSpokenWords: 831,
      authoringPlan,
    });
    expect(args.scenes).toBe(scenes);
    expect((args.scenes as typeof scenes)).toHaveLength(8);
    expect((args.scenes as typeof scenes).map((scene) => scene.sceneNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(failoverHandler).toHaveBeenCalledOnce();
    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(baseHandler.mock.calls.map(([candidateRequest]) => candidateRequest.model)).toEqual([
      primary,
      fallback,
    ]);
    for (const [candidateRequest] of baseHandler.mock.calls) {
      expect(candidateRequest.toolChoice).toEqual({
        type: "function",
        function: { name: "write_episode_script_chunk" },
      });
    }
    expect(pool.switchToNext).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error("Access is unavailable for this credential"), {
      status: 403,
    }),
    Object.assign(new Error("Authentication is unavailable for this credential"), {
      status: 401,
    }),
    Object.assign(new Error("provider wrapper"), {
      cause: Object.assign(new Error("authentication failed"), { status: 401 }),
    }),
    Object.assign(new Error("outer wrapper"), {
      cause: Object.assign(new Error("inner wrapper"), {
        cause: Object.assign(new Error("permission denied"), { statusCode: 403 }),
      }),
    }),
    Object.assign(new Error("outer wrapper"), {
      cause: Object.assign(new Error("authentication denied"), { statusCode: 401 }),
    }),
  ])("switches candidates for a provider access failure before any tool executes", async (accessError) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const expected = response("fallback");
    const handler = vi.fn()
      .mockRejectedValueOnce(accessError)
      .mockResolvedValueOnce(expected);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).toBe(expected);
    expect(handler.mock.calls.map(([request]) => request.model)).toEqual([
      primary,
      fallback,
    ]);
    expect(pool.switchToNext).toHaveBeenCalledOnce();
  });

  it("walks retryable and quota failures in ProviderManager order", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const second = { id: "nvidia-key-2" };
    const third = { id: "anyapi-key-1" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "nvidia", model: second, nvidiaKeyIndex: 1 },
      { provider: "anyapi", model: third },
    ]);
    const expected = response("third");
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockRejectedValueOnce(Object.assign(new Error("limited"), { status: 429 }))
      .mockResolvedValueOnce(expected);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).toBe(expected);
    expect(handler.mock.calls.map(([request]) => request.model)).toEqual([
      primary,
      second,
      third,
    ]);
    expect(pool.switchToNext).toHaveBeenCalledTimes(2);
  });

  it("advances again when a fallback has a wrapped provider-access failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const second = { id: "second" };
    const third = { id: "third" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: second },
      { provider: "requesty", model: third },
    ]);
    const expected = response("third");
    const wrappedAccessFailure = Object.assign(new Error("adapter wrapper"), {
      cause: Object.assign(new Error("provider permission failure"), { status: 403 }),
    });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("request timeout"))
      .mockRejectedValueOnce(wrappedAccessFailure)
      .mockResolvedValueOnce(expected);

    expect(await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).toBe(expected);
    expect(handler.mock.calls.map(([request]) => request.model)).toEqual([
      primary,
      second,
      third,
    ]);
    expect(pool.switchToNext).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful fallback sticky for later model turns", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "anyapi-key-1" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const middleware = createProductionModelCallFailoverMiddleware({
      providerManagerFactory: () => pool.manager,
    });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValueOnce(response("fallback first turn"))
      .mockResolvedValueOnce(response("fallback second turn"));

    await invoke(middleware, modelRequest(primary), handler);
    await invoke(middleware, modelRequest(primary), handler);

    expect(handler.mock.calls.map(([request]) => request.model)).toEqual([
      primary,
      fallback,
      fallback,
    ]);
    expect(pool.switchToNext).toHaveBeenCalledTimes(1);
    expect(pool.getModel).toHaveBeenCalledTimes(1);
  });

  it("does not switch for fatal or production-protocol errors", async () => {
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const errors = [
      new Error("invalid request schema"),
      new Error("403 Access denied"),
      new Error("unauthorized"),
      Object.assign(new Error("not a candidate access failure"), { status: 400 }),
      Object.assign(new Error("missing model"), { status: 404 }),
      Object.assign(new Error("unprocessable request"), { status: 422 }),
      new Error("Episode narration happens to mention 403 Access denied signs."),
      new ProductionToolCallProtocolError("after_get_next_episode"),
    ];

    for (const error of errors) {
      const pool = fakeManager([
        { provider: "nvidia", model: primary },
        { provider: "anyapi", model: fallback },
      ]);
      const handler = vi.fn().mockRejectedValue(error);
      await expect(invoke(
        createProductionModelCallFailoverMiddleware({
          providerManagerFactory: () => pool.manager,
        }),
        modelRequest(primary),
        handler,
      )).rejects.toBe(error);
      expect(pool.switchToNext).not.toHaveBeenCalled();
    }
  });

  it("terminates a cyclic cause chain without switching for message-only access text", async () => {
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const cyclic = new Error("403 Access denied") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    const handler = vi.fn().mockRejectedValue(cyclic);

    await expect(invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).rejects.toBe(cyclic);
    expect(pool.switchToNext).not.toHaveBeenCalled();
  });

  it("stops immediately when a fallback returns a fatal error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const unused = { id: "unused" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
      { provider: "requesty", model: unused },
    ]);
    const fatal = new Error("invalid authentication configuration");
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("request timeout"))
      .mockRejectedValueOnce(fatal);

    await expect(invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    )).rejects.toBe(fatal);
    expect(pool.switchToNext).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("wraps bounded exhaustion with the last error as cause and stays fatal to the outer classifier", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const lastError = Object.assign(new Error("provider returned 503"), {
      status: 503,
    });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("primary timeout"))
      .mockRejectedValueOnce(lastError);

    let thrown: unknown;
    try {
      await invoke(
        createProductionModelCallFailoverMiddleware({
          providerManagerFactory: () => pool.manager,
        }),
        modelRequest(primary),
        handler,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProductionModelProviderPoolExhaustedError);
    expect((thrown as Error).cause).toBe(lastError);
    expect((thrown as ProductionModelProviderPoolExhaustedError).attempts).toBe(2);
    expect(classifyProviderError(thrown)).toBe("fatal");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(pool.switchToNext).toHaveBeenCalledTimes(2);
  });

  it("does not copy provider messages or stacks into failover logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    const secret = "PRIVATE_PROMPT_AND_KEY_MUST_NOT_APPEAR";
    const providerError = Object.assign(new Error(`timeout ${secret}`), {
      status: 503,
      code: "ETIMEDOUT",
    });
    const handler = vi.fn()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce(response());

    await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    );

    const serializedLogs = JSON.stringify(warn.mock.calls);
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain(providerError.stack);
    expect(serializedLogs).toContain("ETIMEDOUT");
    expect(serializedLogs).toContain("503");
  });

  it("returns one fallback tool-call response without executing its domain tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const primary = { id: "primary" };
    const fallback = { id: "fallback" };
    const pool = fakeManager([
      { provider: "nvidia", model: primary },
      { provider: "anyapi", model: fallback },
    ]);
    let domainToolExecutions = 0;
    const toolResponse = new AIMessage({
      content: "",
      tool_calls: [{
        id: "next-call",
        name: "get_next_episode",
        args: { seriesId: 13 },
        type: "tool_call",
      }],
    });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(toolResponse);

    const result = await invoke(
      createProductionModelCallFailoverMiddleware({
        providerManagerFactory: () => pool.manager,
      }),
      modelRequest(primary),
      handler,
    );

    expect(result).toBe(toolResponse);
    expect(domainToolExecutions).toBe(0);
    domainToolExecutions += (result as AIMessage).tool_calls?.length ?? 0;
    expect(domainToolExecutions).toBe(1);
  });
});
