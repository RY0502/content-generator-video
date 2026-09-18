import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import {
  createProductionToolProtocolMiddleware,
  ProductionToolCallProtocolError,
  requiredProductionToolTurn,
} from "../services/productionToolProtocolMiddleware.js";

const productionTools = [
  { name: "get_or_create_series" },
  { name: "bulk_insert_episode_list" },
  { name: "get_next_episode" },
  { name: "ensure_series_character_portraits" },
  { name: "write_episode_script_chunk" },
  { name: "stage_episode_script_draft" },
  { name: "refine_episode_script" },
  { name: "synthesize_episode_narration_audio" },
  { name: "submit_agnes_scene_videos" },
] as any[];

function toolResult(name: string, content: string, id = `${name}-call`) {
  return new ToolMessage({
    name,
    tool_call_id: id,
    content,
  });
}

function request(messages: BaseMessage[], toolChoice: "auto" | "none" = "auto") {
  return {
    model: {} as any,
    messages,
    systemPrompt: "",
    systemMessage: new SystemMessage("Production system contract."),
    tools: productionTools,
    state: { messages },
    runtime: {} as any,
    toolChoice,
    modelSettings: { temperature: 0.25 },
  };
}

function toolCallResponse(
  name = "get_or_create_series",
  args: Record<string, unknown> = {},
) {
  return new AIMessage({
    content: "",
    tool_calls: [{
      id: `${name}-call`,
      name,
      args,
      type: "tool_call",
    }],
  });
}

async function invokeWrapModelCall(
  modelRequest: ReturnType<typeof request>,
  handler: ReturnType<typeof vi.fn>,
) {
  const middleware = createProductionToolProtocolMiddleware();
  expect(middleware.wrapModelCall).toBeTypeOf("function");
  return middleware.wrapModelCall!(modelRequest as any, handler as any);
}

describe("production tool protocol middleware", () => {
  it("proactively requires a structured tool call on the initial production turn", async () => {
    const response = toolCallResponse();
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([new HumanMessage("Generate the next episode.")]),
      handler,
    );

    expect(result).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "get_or_create_series" },
    });
    expect(handler.mock.calls[0][0].modelSettings).toEqual({
      temperature: 0.25,
      parallel_tool_calls: false,
    });
  });

  it.each([
    {
      resumeAction: "script_and_audio",
      extraReceipt: {
        scriptValidation: { status: "not_started" },
      },
      expectedTool: "ensure_series_character_portraits",
      expectedArgs: { seriesId: 42 },
    },
    {
      resumeAction: "script_authoring",
      extraReceipt: {
        scriptDraft: { episodeId: 77, revision: 4 },
        scriptValidation: { status: "authoring_in_progress" },
      },
      expectedTool: "write_episode_script_chunk",
      expectedArgs: {
        episodeId: 77,
        operation: "append",
        expectedDraftRevision: 4,
        scenes: [],
      },
    },
    {
      resumeAction: "repair_script",
      extraReceipt: {
        scriptDraft: { episodeId: 77, revision: 5 },
      },
      expectedTool: "refine_episode_script",
      expectedArgs: { episodeId: 77, draftRevision: 5 },
    },
    {
      resumeAction: "audio_repair",
      extraReceipt: {},
      expectedTool: "synthesize_episode_narration_audio",
      expectedArgs: { seriesId: 42, episodeNumber: 3 },
    },
    {
      resumeAction: "agnes",
      extraReceipt: {},
      expectedTool: "submit_agnes_scene_videos",
      expectedArgs: { seriesId: 42, episodeNumber: 3 },
    },
  ])(
    "routes get_next_episode resumeAction=$resumeAction to $expectedTool",
    async ({ resumeAction, extraReceipt, expectedTool, expectedArgs }) => {
      const receipt = JSON.stringify({
        kind: "ready",
        episode: {
          id: 77,
          seriesId: 42,
          episodeNumber: 3,
          title: "A durable title",
        },
        resumeAction,
        ...extraReceipt,
      });
      const response = toolCallResponse(expectedTool, expectedArgs);
      const handler = vi.fn().mockResolvedValue(response);

      expect(await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolCallResponse("get_next_episode", { seriesId: 42 }),
          toolResult("get_next_episode", receipt),
        ]),
        handler,
      )).toBe(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: expectedTool },
      });
      expect(handler.mock.calls[0][0].modelSettings).toEqual({
        temperature: 0.25,
        parallel_tool_calls: false,
      });
    },
  );

  it.each([
    {
      scriptStatus: "not_started",
      expectedTool: "write_episode_script_chunk",
      expectedArgs: {
        episodeId: 77,
        operation: "start",
        targetSceneCount: 40,
        authoringPlan: {},
        scenes: [],
      },
    },
    {
      scriptStatus: "ready",
      expectedTool: "synthesize_episode_narration_audio",
      expectedArgs: { seriesId: 42, episodeNumber: 3 },
    },
  ])(
    "routes roster completion with prior script status $scriptStatus to $expectedTool",
    async ({ scriptStatus, expectedTool, expectedArgs }) => {
      const response = toolCallResponse(expectedTool, expectedArgs);
      const handler = vi.fn().mockResolvedValue(response);
      const getNextCallId = "get-next-call";

      expect(await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          new AIMessage({
            content: "",
            tool_calls: [{
              id: getNextCallId,
              name: "get_next_episode",
              args: { seriesId: 42 },
              type: "tool_call",
            }],
          }),
          toolResult(
            "get_next_episode",
            JSON.stringify({
              kind: "ready",
              episode: { id: 77, seriesId: 42, episodeNumber: 3 },
              resumeAction: "script_and_audio",
              scriptValidation: { status: scriptStatus },
            }),
            getNextCallId,
          ),
          toolCallResponse("ensure_series_character_portraits", { seriesId: 42 }),
          toolResult(
            "ensure_series_character_portraits",
            '{"status":"complete_roster_approved","seriesId":42}',
          ),
        ]),
        handler,
      )).toBe(response);
      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: expectedTool },
      });
    },
  );

  it.each([
    "script_chunk_staged",
    "script_chunk_appended",
    "script_chunk_already_present",
    "invalid_script_chunk",
  ])(
    "routes retryable %s receipts to the exact authoritative append",
    async (status) => {
      const scenes = [{ sceneNumber: 1, narrationText: "corrected scene" }];
      const response = toolCallResponse("write_episode_script_chunk", {
        episodeId: 999,
        operation: "start",
        expectedDraftRevision: 1,
        targetSceneCount: 50,
        authoringPlan: { storyArc: "must be omitted on append" },
        scenes,
      });
      const handler = vi.fn().mockResolvedValue(response);

      const result = await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolCallResponse("write_episode_script_chunk", {
            episodeId: 128,
            operation: "start",
            targetSceneCount: 50,
            authoringPlan: { storyArc: "durable arc" },
            scenes: [],
          }),
          toolResult("write_episode_script_chunk", JSON.stringify({
            status,
            persisted: true,
            retryThisInvocation: true,
            episodeId: 128,
            draftRevision: 4,
            authoringProgress: { nextSceneNumber: 1, nextSceneEnd: 8 },
          })),
        ]),
        handler,
      ) as AIMessage;

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: "write_episode_script_chunk" },
      });
      expect(result.tool_calls?.[0].args).toEqual({
        episodeId: 128,
        operation: "append",
        expectedDraftRevision: 4,
        scenes,
      });
    },
  );

  it("retries an unpersisted invalid chunk input with authoritative append routing", async () => {
    const scenes = [{ sceneNumber: 17, narrationText: "corrected scene" }];
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "start",
      expectedDraftRevision: 999,
      targetSceneCount: 50,
      authoringPlan: { storyArc: "provider drift" },
      scenes,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolCallResponse("write_episode_script_chunk", {
        episodeId: 128,
        operation: "append",
        expectedDraftRevision: 4,
        scenes: [],
      }),
      toolResult("write_episode_script_chunk", JSON.stringify({
        status: "invalid_input",
        persisted: false,
        retryable: true,
        retryThisInvocation: true,
        episodeId: 128,
        draftRevision: 5,
        operation: "append",
        correctionRetryNumber: 1,
        correctionRetryLimit: 2,
        validation: {
          pass: false,
          issues: ["scenes.0.narrationText is required."],
          invalidPaths: ["scenes.0.narrationText"],
          omittedIssueCount: 0,
        },
      })),
    ]);

    expect(requiredProductionToolTurn(modelRequest as any)).toBe(
      "after_write_episode_script_chunk",
    );
    const result = await invokeWrapModelCall(modelRequest, handler) as AIMessage;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect(result.tool_calls?.[0].args).toEqual({
      episodeId: 128,
      operation: "append",
      expectedDraftRevision: 5,
      scenes,
    });
  });

  it("routes a durable restart-required receipt to the exact restart operation", async () => {
    const scenes = [{ sceneNumber: 1, narrationText: "corrected opening" }];
    const durablePlan = {
      storyArc: "durable replacement arc",
      beats: [{ startScene: 1, endScene: 40 }],
    };
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "append",
      expectedDraftRevision: 1,
      scenes,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolCallResponse("write_episode_script_chunk", {
          episodeId: 128,
          operation: "append",
          expectedDraftRevision: 4,
          scenes: [],
        }),
        toolResult("write_episode_script_chunk", JSON.stringify({
          status: "script_chunk_restart_required",
          persisted: true,
          retryThisInvocation: true,
          episodeId: 128,
          draftRevision: 5,
          restartPlan: {
            targetSceneCount: 40,
            authoringPlan: durablePlan,
            nextSceneNumber: 1,
            nextSceneEnd: 8,
          },
        })),
      ]),
      handler,
    ) as AIMessage;

    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect(result.tool_calls?.[0].args).toEqual({
      episodeId: 128,
      operation: "restart",
      expectedDraftRevision: 5,
      targetSceneCount: 40,
      authoringPlan: durablePlan,
      scenes,
    });
  });

  it("keeps only durable routing and word floor authoritative during an infeasible restart replan", async () => {
    const replacementPlan = {
      storyArc: "A longer replacement arc with enough distinct beats for the measured runtime floor.",
      beats: [{ startScene: 1, endScene: 42 }],
    };
    const replacementScenes = [{
      sceneNumber: 1,
      narrationText: "Mia follows the lantern toward a new and clearly distinct clue.",
    }];
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "start",
      expectedDraftRevision: 1,
      minimumReplacementSpokenWords: 750,
      targetSceneCount: 42,
      authoringPlan: replacementPlan,
      scenes: replacementScenes,
    });
    const handler = vi.fn().mockResolvedValue(response);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolCallResponse("write_episode_script_chunk", {
        episodeId: 17,
        operation: "restart",
        expectedDraftRevision: 4,
        minimumReplacementSpokenWords: 825,
        targetSceneCount: 40,
        authoringPlan: { storyArc: "Infeasible old plan." },
        scenes: [],
      }),
      toolResult("write_episode_script_chunk", JSON.stringify({
        status: "script_chunk_replan_required",
        persisted: false,
        retryable: true,
        retryThisInvocation: true,
        noProgress: true,
        episodeId: 17,
        draftRevision: 4,
        operation: "restart",
        minimumReplacementSpokenWords: 825,
        maximumReachableSpokenWords: 800,
        minimumRequiredSceneCount: 42,
      })),
    ]);

    expect(requiredProductionToolTurn(modelRequest as any)).toBe(
      "after_write_episode_script_chunk",
    );
    const result = await invokeWrapModelCall(modelRequest, handler) as AIMessage;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect(result.tool_calls?.[0].args).toEqual({
      episodeId: 17,
      operation: "restart",
      expectedDraftRevision: 4,
      minimumReplacementSpokenWords: 825,
      targetSceneCount: 42,
      authoringPlan: replacementPlan,
      scenes: replacementScenes,
    });
  });

  it("routes a completed chunk draft directly to refinement", async () => {
    const response = toolCallResponse("refine_episode_script", {
      episodeId: 999,
      draftRevision: 1,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolCallResponse("write_episode_script_chunk", {
          episodeId: 128,
          operation: "append",
          expectedDraftRevision: 8,
          scenes: [],
        }),
        toolResult("write_episode_script_chunk", JSON.stringify({
          status: "script_draft_complete",
          persisted: true,
          retryThisInvocation: true,
          episodeId: 128,
          draftRevision: 9,
        })),
      ]),
      handler,
    ) as AIMessage;

    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "refine_episode_script" },
    });
    expect(result.tool_calls?.[0].args).toEqual({
      episodeId: 128,
      draftRevision: 9,
    });
  });

  it.each([
    {
      operation: "start",
      receiptRevision: undefined,
      priorRevision: undefined,
      expected: {
        episodeId: 128,
        operation: "start",
        targetSceneCount: 50,
      },
    },
    {
      operation: "append",
      receiptRevision: 4,
      priorRevision: 4,
      expected: {
        episodeId: 128,
        operation: "append",
        expectedDraftRevision: 4,
      },
    },
    {
      operation: "restart",
      receiptRevision: 7,
      priorRevision: 7,
      expected: {
        episodeId: 128,
        operation: "restart",
        expectedDraftRevision: 7,
        targetSceneCount: 50,
      },
    },
  ])(
    "retries an oversized $operation chunk with its exact operation metadata",
    async ({ operation, receiptRevision, priorRevision, expected }) => {
      const authoringPlan = { storyArc: "The exact prior immutable plan." };
      const priorArgs = {
        episodeId: 128,
        operation,
        ...(priorRevision === undefined
          ? {}
          : { expectedDraftRevision: priorRevision }),
        ...(operation === "append"
          ? {}
          : { targetSceneCount: 50, authoringPlan }),
        scenes: [],
      };
      const nextScenes = [{ sceneNumber: 1, narrationText: "shorter scene" }];
      const response = toolCallResponse("write_episode_script_chunk", {
        episodeId: 999,
        operation: "append",
        expectedDraftRevision: 999,
        targetSceneCount: 40,
        authoringPlan: { storyArc: "provider drift" },
        scenes: nextScenes,
      });
      const handler = vi.fn().mockResolvedValue(response);

      const result = await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolCallResponse("write_episode_script_chunk", priorArgs),
          toolResult("write_episode_script_chunk", JSON.stringify({
            status: "script_chunk_too_large",
            persisted: false,
            retryThisInvocation: true,
            episodeId: 128,
            ...(receiptRevision === undefined
              ? {}
              : { draftRevision: receiptRevision }),
            operation,
            requestedSceneRange: { startScene: 1, endScene: 8 },
          })),
        ]),
        handler,
      ) as AIMessage;

      const actual = result.tool_calls?.[0].args as Record<string, unknown>;
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: "write_episode_script_chunk" },
      });
      expect(actual).toMatchObject({ ...expected, scenes: nextScenes });
      if (operation === "append") {
        expect(actual).not.toHaveProperty("targetSceneCount");
        expect(actual).not.toHaveProperty("authoringPlan");
      } else {
        expect(actual.authoringPlan).toBe(authoringPlan);
      }
      if (operation === "start") {
        expect(actual).not.toHaveProperty("expectedDraftRevision");
      }
    },
  );

  it.each([
    {
      scriptReloadRequired: true,
      expectedTool: "get_next_episode",
      expectedArgs: { seriesId: 42 },
    },
    {
      scriptReloadRequired: false,
      expectedTool: "synthesize_episode_narration_audio",
      expectedArgs: { seriesId: 42, episodeNumber: 3 },
    },
  ])(
    "routes ready refinement with scriptReloadRequired=$scriptReloadRequired to $expectedTool",
    async ({ scriptReloadRequired, expectedTool, expectedArgs }) => {
      const response = toolCallResponse(expectedTool, {});
      const handler = vi.fn().mockResolvedValue(response);

      const result = await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolCallResponse("refine_episode_script", {
            episodeId: 128,
            draftRevision: 9,
          }),
          toolResult("refine_episode_script", JSON.stringify({
            status: "ready",
            persisted: true,
            episodeId: 128,
            seriesId: 42,
            episodeNumber: 3,
            draftRevision: 9,
            scriptReloadRequired,
          })),
        ]),
        handler,
      ) as AIMessage;

      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: expectedTool },
      });
      expect(result.tool_calls?.[0].args).toEqual(expectedArgs);
    },
  );

  it("binds exact measured timing from an audio-repair receipt over hallucinated refinement arguments", async () => {
    const authoritativeTiming = {
      episodeId: 129,
      durationExceededScenes: [],
      measuredTotalNarrationSeconds: 284.952485,
      measuredNarrationSceneCount: 45,
    };
    const hallucinatedTiming = {
      episodeId: 129,
      durationExceededScenes: [
        { sceneNumber: 38, durationSeconds: 16.3 },
        { sceneNumber: 42, durationSeconds: 16.3 },
        { sceneNumber: 44, durationSeconds: 18.5 },
      ],
      measuredTotalNarrationSeconds: 587.6,
      measuredNarrationSceneCount: 45,
    };
    const response = toolCallResponse("refine_episode_script", hallucinatedTiming);
    const handler = vi.fn().mockResolvedValue(response);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolCallResponse("synthesize_episode_narration_audio", {
        seriesId: 13,
        episodeNumber: 4,
      }),
      toolResult("synthesize_episode_narration_audio", JSON.stringify({
        status: "repair_required",
        readyForAgnes: false,
        seriesId: 13,
        episodeId: 129,
        episodeNumber: 4,
        sceneCount: 45,
        measuredNarrationSceneCount: 45,
        measuredTotalNarrationSeconds: 284.952485,
        durationExceededScenes: [],
        totalDurationBelowMinimum: true,
        minimumTotalNarrationSeconds: 300,
      })),
    ]);

    expect(requiredProductionToolTurn(modelRequest as any)).toBe(
      "after_synthesize_episode_narration_audio",
    );
    const result = await invokeWrapModelCall(modelRequest, handler) as AIMessage;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "refine_episode_script" },
    });
    expect(result.tool_calls?.[0].args).toEqual(authoritativeTiming);
  });

  it("routes a successful legacy draft stage to refinement", async () => {
    const response = toolCallResponse("refine_episode_script", {});
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("stage_episode_script_draft", JSON.stringify({
          status: "draft_staged",
          persisted: true,
          episodeId: 128,
          draftRevision: 2,
        })),
      ]),
      handler,
    ) as AIMessage;

    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "refine_episode_script" },
    });
    expect(result.tool_calls?.[0].args).toEqual({
      episodeId: 128,
      draftRevision: 2,
    });
  });

  it.each([
    [
      "get_or_create_series",
      '{"seriesId":42,"characters":[],"environments":[]}',
      "bulk_insert_episode_list",
      { seriesId: 42 },
    ],
    [
      "get_or_create_series",
      '{"status":"needs_definition","conceptName":"Dino Friends","retryThisInvocation":true}',
      "get_or_create_series",
      { conceptName: "Dino Friends" },
    ],
    [
      "bulk_insert_episode_list",
      '{"status":"manifest_required","seriesId":42,"retryThisInvocation":true}',
      "bulk_insert_episode_list",
      { seriesId: 42 },
    ],
    [
      "bulk_insert_episode_list",
      '{"status":"ok","seriesId":42}',
      "get_next_episode",
      { seriesId: 42 },
    ],
    [
      "bulk_insert_episode_list",
      '{"status":"verified","seriesId":42}',
      "get_next_episode",
      { seriesId: 42 },
    ],
    [
      "bulk_insert_episode_list",
      '{"status":"inserted","seriesId":42}',
      "get_next_episode",
      { seriesId: 42 },
    ],
    [
      "bulk_insert_episode_list",
      '{"status":"invalid_series_id","retryThisInvocation":true}',
      "get_or_create_series",
      {},
    ],
  ])(
    "forces %s receipt %s to the exact next bootstrap tool %s",
    async (previousTool, receipt, expectedTool, expectedArgs) => {
      const response = toolCallResponse(expectedTool, expectedArgs);
      const handler = vi.fn().mockResolvedValue(response);

      const result = await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolResult(previousTool, receipt),
        ]),
        handler,
      );

      expect(result).toBe(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].toolChoice).toEqual({
        type: "function",
        function: { name: expectedTool },
      });
    },
  );

  it("retries when a provider ignores an exact startup choice and calls the wrong tool", async () => {
    const recovery = toolCallResponse("get_or_create_series");
    const handler = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("bulk_insert_episode_list"))
      .mockResolvedValueOnce(recovery);

    const result = await invokeWrapModelCall(
      request([new HumanMessage("Generate the next episode.")]),
      handler,
    );

    expect(result).toBe(recovery);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "get_or_create_series" },
    });
    expect(handler.mock.calls[1][0].toolChoice).toEqual({
      type: "function",
      function: { name: "get_or_create_series" },
    });
    expect(handler.mock.calls[0][0].modelSettings).toEqual({
      temperature: 0.25,
      parallel_tool_calls: false,
    });
    expect(handler.mock.calls[1][0].modelSettings).toEqual({
      temperature: 0.25,
      parallel_tool_calls: false,
    });
  });

  it("retries a wrong tool after a script_and_audio receipt using the exact durable route", async () => {
    const receipt = JSON.stringify({
      kind: "ready",
      episode: { id: 77, seriesId: 42, episodeNumber: 3 },
      resumeAction: "script_and_audio",
      scriptValidation: { status: "not_started" },
    });
    const recovery = toolCallResponse(
      "ensure_series_character_portraits",
      { seriesId: 42 },
    );
    const handler = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("write_episode_script_chunk", {
        episodeId: 77,
      }))
      .mockResolvedValueOnce(recovery);

    expect(await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", receipt),
      ]),
      handler,
    )).toBe(recovery);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const [guardedRequest] of handler.mock.calls) {
      expect(guardedRequest.toolChoice).toEqual({
        type: "function",
        function: { name: "ensure_series_character_portraits" },
      });
      expect(guardedRequest.modelSettings.parallel_tool_calls).toBe(false);
    }
  });

  it("retries multiple calls after a script_and_audio receipt", async () => {
    const receipt = JSON.stringify({
      kind: "ready",
      episode: { id: 77, seriesId: 42, episodeNumber: 3 },
      resumeAction: "script_and_audio",
      scriptValidation: { status: "not_started" },
    });
    const multipleCalls = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "first-roster-call",
          name: "ensure_series_character_portraits",
          args: { seriesId: 42 },
          type: "tool_call",
        },
        {
          id: "second-roster-call",
          name: "ensure_series_character_portraits",
          args: { seriesId: 42 },
          type: "tool_call",
        },
      ],
    });
    const recovery = toolCallResponse(
      "ensure_series_character_portraits",
      { seriesId: 42 },
    );
    const handler = vi.fn()
      .mockResolvedValueOnce(multipleCalls)
      .mockResolvedValueOnce(recovery);

    expect(await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", receipt),
      ]),
      handler,
    )).toBe(recovery);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("logs only structural diagnostics for rejected tool calls", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitiveValue = "PRIVATE-SCENE-CONTENT-MUST-NOT-BE-LOGGED";
    const recovery = toolCallResponse("get_or_create_series");
    const handler = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("bulk_insert_episode_list", {
        seriesId: sensitiveValue,
        scriptJson: sensitiveValue,
      }))
      .mockResolvedValueOnce(recovery);

    try {
      expect(await invokeWrapModelCall(
        request([new HumanMessage("Generate the next episode.")]),
        handler,
      )).toBe(recovery);
      const serializedDiagnostics = JSON.stringify(warning.mock.calls);
      expect(serializedDiagnostics).not.toContain(sensitiveValue);
      expect(serializedDiagnostics).not.toContain("scriptJson\":\"");
      expect(serializedDiagnostics).toContain("toolCallCount");
      expect(serializedDiagnostics).toContain("argKeyCount");
      expect(serializedDiagnostics).toContain("get_or_create_series");
      expect(serializedDiagnostics).toContain('toolNameMatches\\\":false');
    } finally {
      warning.mockRestore();
    }
  });

  it("binds an authoritative series id without another model call", async () => {
    const response = toolCallResponse(
      "bulk_insert_episode_list",
      { seriesId: 999, episodes: [{ episodeNumber: 1 }] },
    );
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult(
          "get_or_create_series",
          '{"seriesId":42,"characters":[],"environments":[]}',
        ),
      ]),
      handler,
    );

    expect(result).not.toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((result as AIMessage).tool_calls?.[0].args).toEqual({
      seriesId: 42,
      episodes: [{ episodeNumber: 1 }],
    });
  });

  it("binds the requested concept without changing definition content", async () => {
    const definitionArgs = {
      conceptName: "Dino Friends",
      characters: [],
      environments: [],
      episodeFormula: "A gentle educational adventure.",
    };
    const response = toolCallResponse("get_or_create_series", {
      ...definitionArgs,
      conceptName: "Different Series",
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult(
          "get_or_create_series",
          '{"status":"needs_definition","conceptName":"Dino Friends","retryThisInvocation":true}',
        ),
      ]),
      handler,
    );

    expect(result).not.toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((result as AIMessage).tool_calls?.[0].args).toEqual(definitionArgs);
  });

  it("binds resumed chunk routing and strips append-only immutable fields", async () => {
    const scenes = [{
      sceneNumber: 1,
      narrationText: "Mia follows the glowing footprints.",
      sceneDetails: { action: "Mia follows one trail." },
    }];
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "start",
      expectedDraftRevision: 1,
      targetSceneCount: 50,
      authoringPlan: { storyArc: "Must not be resent during append." },
      scenes,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", JSON.stringify({
          kind: "ready",
          episode: { id: 77, seriesId: 42, episodeNumber: 3 },
          resumeAction: "script_authoring",
          scriptDraft: { episodeId: 77, revision: 4 },
        })),
      ]),
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const args = (result as AIMessage).tool_calls?.[0].args as Record<string, unknown>;
    expect(args).toMatchObject({
      episodeId: 77,
      operation: "append",
      expectedDraftRevision: 4,
    });
    expect(args.scenes).toBe(scenes);
    expect(args).not.toHaveProperty("targetSceneCount");
    expect(args).not.toHaveProperty("authoringPlan");
  });

  it("forces complete-draft reauthoring through restart while preserving model-owned content", async () => {
    const authoringPlan = {
      storyArc: "Mia expands the rescue into enough clear visual beats for a full episode.",
      educationalIdea: "Careful observation helps solve problems.",
      endingInsight: "Patient teamwork can guide everyone home.",
      beats: [{
        startScene: 1,
        endScene: 48,
        storyBeat: "The friends discover, investigate, and resolve the rescue.",
        setting: "A sunny valley beside the clubhouse.",
        continuityOutcome: "Everyone returns safely with the clue preserved.",
      }],
      supportingEntityBible: [],
      continuityBible: [],
    };
    const scenes = [{
      sceneNumber: 1,
      narrationText: "Mia notices one bright clue beside the quiet trail.",
      sceneDetails: { action: "Mia kneels beside the single clue." },
    }];
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "append",
      expectedDraftRevision: 1,
      targetSceneCount: 48,
      minimumReplacementSpokenWords: 750,
      authoringPlan,
      scenes,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", JSON.stringify({
          kind: "ready",
          episode: { id: 77, seriesId: 42, episodeNumber: 3 },
          resumeAction: "script_authoring",
          scriptDraft: {
            episodeId: 77,
            revision: 5,
            validation: {
              pass: false,
              requiredAction: "reauthor_complete_script",
              durableTimingEvidence: {
                durationExceededSceneCount: 0,
                hasMeasuredTotalNarrationSeconds: true,
                measuredNarrationSceneCount: 45,
                minimumReplacementSpokenWords: 825,
              },
            },
          },
        })),
      ]),
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect((result as AIMessage).tool_calls?.[0].args).toEqual({
      episodeId: 77,
      operation: "restart",
      expectedDraftRevision: 5,
      targetSceneCount: 48,
      minimumReplacementSpokenWords: 825,
      authoringPlan,
      scenes,
    });
  });

  it("binds a fresh-run restart marker to restart with its durable plan", async () => {
    const authoringPlan = {
      storyArc: "Mia follows a complete three-act rescue arc.",
      educationalIdea: "Ice can preserve clues.",
      endingInsight: "Careful observation helps friends.",
      beats: [{
        startScene: 1,
        endScene: 50,
        storyBeat: "The friends discover, solve, and safely resolve the rescue.",
        setting: "An icy valley.",
        continuityOutcome: "Everyone returns safely.",
      }],
      supportingEntityBible: [],
      continuityBible: [],
    };
    const scenes = [{
      sceneNumber: 1,
      narrationText: "Mia follows the glowing footprints.",
      sceneDetails: { action: "Mia follows one trail." },
    }];
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "append",
      expectedDraftRevision: 1,
      scenes,
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", JSON.stringify({
          kind: "ready",
          episode: { id: 77, seriesId: 42, episodeNumber: 3 },
          resumeAction: "script_authoring",
          scriptDraft: {
            episodeId: 77,
            revision: 4,
            authoringProgress: {
              requiredAction: "restart_script_authoring",
              targetSceneCount: 50,
              authoringPlan,
            },
          },
        })),
      ]),
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result as AIMessage).tool_calls?.[0].args).toEqual({
      episodeId: 77,
      operation: "restart",
      expectedDraftRevision: 4,
      targetSceneCount: 50,
      authoringPlan,
      scenes,
    });
  });

  it("does not bind a correct-name tool call whose arguments are not an object", async () => {
    const malformed = new AIMessage({
      content: "",
      tool_calls: [{
        id: "malformed-series-call",
        name: "bulk_insert_episode_list",
        args: "not-an-object" as any,
        type: "tool_call",
      }],
    });
    const recovery = toolCallResponse("bulk_insert_episode_list", { seriesId: 42 });
    const handler = vi.fn()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(recovery);

    expect(await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult(
          "get_or_create_series",
          '{"seriesId":42,"characters":[],"environments":[]}',
        ),
      ]),
      handler,
    )).toBe(recovery);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("logs bound argument names without logging generated scene content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sensitiveScene = "PRIVATE-SCENE-CONTENT-MUST-NOT-BE-LOGGED";
    const response = toolCallResponse("write_episode_script_chunk", {
      episodeId: 999,
      operation: "append",
      expectedDraftRevision: 999,
      scenes: [{ sceneNumber: 1, narrationText: sensitiveScene }],
    });
    const handler = vi.fn().mockResolvedValue(response);

    try {
      await invokeWrapModelCall(
        request([
          new HumanMessage("Generate the next episode."),
          toolResult("get_next_episode", JSON.stringify({
            kind: "ready",
            episode: { id: 77, seriesId: 42, episodeNumber: 3 },
            resumeAction: "script_authoring",
            scriptDraft: { revision: 4 },
          })),
        ]),
        handler,
      );

      const serializedLogs = JSON.stringify(info.mock.calls);
      expect(serializedLogs).toContain("episodeId");
      expect(serializedLogs).toContain("expectedDraftRevision");
      expect(serializedLogs).not.toContain(sensitiveScene);
      expect(serializedLogs).not.toContain("999");
    } finally {
      info.mockRestore();
    }
  });

  it("preserves message metadata while removing stale raw routing arguments", async () => {
    const response = new AIMessage({
      id: "provider-message-id",
      name: "provider-message-name",
      content: [{
        type: "tool_call",
        id: "bulk-call",
        name: "bulk_insert_episode_list",
        args: { seriesId: 999, episodes: [{ episodeNumber: 1 }] },
      }] as any,
      additional_kwargs: {
        traceId: "trace-kept",
        function_call: {
          name: "bulk_insert_episode_list",
          arguments: '{"seriesId":999}',
        },
        tool_calls: [{
          id: "bulk-call",
          type: "function",
          function: {
            name: "bulk_insert_episode_list",
            arguments: '{"seriesId":999}',
          },
        }],
      },
      response_metadata: { model_name: "test-model", output_version: "v1" },
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      tool_calls: [{
        id: "bulk-call",
        name: "bulk_insert_episode_list",
        args: { seriesId: 999, episodes: [{ episodeNumber: 1 }] },
        type: "tool_call",
      }],
    });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolResult(
          "get_or_create_series",
          '{"seriesId":42,"characters":[],"environments":[]}',
        ),
      ]),
      handler,
    ) as AIMessage;

    expect(result.id).toBe("provider-message-id");
    expect(result.name).toBe("provider-message-name");
    expect(result.additional_kwargs).toEqual({ traceId: "trace-kept" });
    expect(result.response_metadata).toMatchObject({
      model_name: "test-model",
      output_version: "v1",
    });
    expect(result.usage_metadata).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(result.tool_calls?.[0].args).toEqual({
      seriesId: 42,
      episodes: [{ episodeNumber: 1 }],
    });
    expect((result.content as any[])[0].args).toEqual({
      seriesId: 42,
      episodes: [{ episodeNumber: 1 }],
    });
  });

  it("retries an exact startup turn that returns multiple tool calls", async () => {
    const multipleCalls = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "first-series-call",
          name: "get_or_create_series",
          args: { conceptName: "Dino Friends" },
          type: "tool_call",
        },
        {
          id: "second-series-call",
          name: "get_or_create_series",
          args: { conceptName: "Other Series" },
          type: "tool_call",
        },
      ],
    });
    const recovery = toolCallResponse("get_or_create_series", {
      conceptName: "Dino Friends",
    });
    const handler = vi.fn()
      .mockResolvedValueOnce(multipleCalls)
      .mockResolvedValueOnce(recovery);

    expect(await invokeWrapModelCall(
      request([new HumanMessage("Generate the next episode.")]),
      handler,
    )).toBe(recovery);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries multiple calls on an exact post-chunk workflow turn", async () => {
    const multipleCalls = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "first-authoring-call",
          name: "write_episode_script_chunk",
          args: {},
          type: "tool_call",
        },
        {
          id: "second-authoring-call",
          name: "refine_episode_script",
          args: {},
          type: "tool_call",
        },
      ],
    });
    const recovery = toolCallResponse("write_episode_script_chunk", { scenes: [] });
    const handler = vi.fn()
      .mockResolvedValueOnce(multipleCalls)
      .mockResolvedValueOnce(recovery);

    expect(await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolCallResponse("write_episode_script_chunk", {
          episodeId: 128,
          operation: "start",
          targetSceneCount: 50,
          authoringPlan: {},
          scenes: [],
        }),
        toolResult(
          "write_episode_script_chunk",
          JSON.stringify({
            status: "script_chunk_staged",
            persisted: true,
            retryThisInvocation: true,
            episodeId: 128,
            draftRevision: 4,
            authoringProgress: { nextSceneNumber: 9, nextSceneEnd: 16 },
          }),
        ),
      ]),
      handler,
    )).toMatchObject({
      tool_calls: [{
        name: "write_episode_script_chunk",
        args: {
          episodeId: 128,
          operation: "append",
          expectedDraftRevision: 4,
          scenes: [],
        },
      }],
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect(handler.mock.calls[1][0].toolChoice).toEqual(
      handler.mock.calls[0][0].toolChoice,
    );
  });

  it("recovers the active series id from the preceding successful bulk call", async () => {
    const response = toolCallResponse("get_next_episode", { seriesId: 42 });
    const handler = vi.fn().mockResolvedValue(response);

    const result = await invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolCallResponse("bulk_insert_episode_list", { seriesId: 42 }),
        toolResult("bulk_insert_episode_list", '{"status":"ok"}'),
      ]),
      handler,
    );

    expect(result).toBe(response);
    expect(handler.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      function: { name: "get_next_episode" },
    });
  });

  it("does not force an unspecified tool when the exact next tool is unavailable", async () => {
    const response = toolCallResponse("get_next_episode");
    const handler = vi.fn().mockResolvedValue(response);
    const modelRequest = {
      ...request([
        new HumanMessage("Generate the next episode."),
        toolResult(
          "get_or_create_series",
          '{"seriesId":42,"characters":[],"environments":[]}',
        ),
      ]),
      tools: productionTools.filter(
        (tool) => tool.name !== "bulk_insert_episode_list",
      ),
    };

    expect(await invokeWrapModelCall(modelRequest as any, handler)).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(modelRequest);
    expect(handler.mock.calls[0][0].toolChoice).toBe("auto");
  });

  it.each([
    {
      resumeAction: "script_and_audio",
      episode: { id: 77, episodeNumber: 3 },
    },
    {
      resumeAction: "script_authoring",
      episode: { id: 77, seriesId: 42, episodeNumber: 3 },
      scriptDraft: { episodeId: 77 },
    },
    {
      resumeAction: "audio_repair",
      episode: { id: 77, seriesId: 42 },
    },
  ])(
    "does not force $resumeAction from a receipt missing authoritative IDs",
    async ({ resumeAction, episode, scriptDraft }) => {
      const finalAnswer = new AIMessage("Reload durable state on the next run.");
      const handler = vi.fn().mockResolvedValue(finalAnswer);
      const modelRequest = request([
        new HumanMessage("Generate the next episode."),
        toolResult("get_next_episode", JSON.stringify({
          kind: "ready",
          resumeAction,
          episode,
          ...(scriptDraft === undefined ? {} : { scriptDraft }),
        })),
      ]);

      expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
      expect(await invokeWrapModelCall(modelRequest, handler)).toBe(finalAnswer);
      expect(handler.mock.calls[0][0]).toBe(modelRequest);
    },
  );

  it("retries prose-only output once without appending that prose to context", async () => {
    const originalMessages = [
      new HumanMessage("Generate the next episode."),
      toolCallResponse("write_episode_script_chunk", {
        episodeId: 128,
        operation: "append",
        expectedDraftRevision: 3,
        scenes: [],
      }),
      toolResult(
        "write_episode_script_chunk",
        JSON.stringify({
          status: "invalid_script_chunk",
          persisted: true,
          retryThisInvocation: true,
          episodeId: 128,
          draftRevision: 4,
          authoringProgress: { nextSceneNumber: 1, nextSceneEnd: 8 },
        }),
      ),
    ];
    const recovery = toolCallResponse("write_episode_script_chunk", { scenes: [] });
    const handler = vi.fn()
      .mockResolvedValueOnce(new AIMessage("I will carefully plan all the scenes."))
      .mockResolvedValueOnce(recovery);

    const result = await invokeWrapModelCall(request(originalMessages), handler);

    expect((result as AIMessage).tool_calls?.[0].args).toEqual({
      episodeId: 128,
      operation: "append",
      expectedDraftRevision: 4,
      scenes: [],
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].messages).toBe(originalMessages);
    expect(handler.mock.calls[1][0].messages).toBe(originalMessages);
    expect(handler.mock.calls[1][0].messages).toHaveLength(3);
    expect(handler.mock.calls[1][0].toolChoice).toEqual({
      type: "function",
      function: { name: "write_episode_script_chunk" },
    });
    expect(handler.mock.calls[1][0].systemMessage).not.toBe(
      handler.mock.calls[0][0].systemMessage,
    );
    expect(String(handler.mock.calls[1][0].systemMessage.content)).toContain(
      "Return exactly one structured domain-tool call now",
    );
    expect(String(handler.mock.calls[1][0].systemMessage.content)).toContain(
      "copy only its candidateScenes named by requiredSceneNumbers",
    );
    expect(String(handler.mock.calls[1][0].systemMessage.content)).toContain(
      "per-scene editableFields",
    );
    expect(String(handler.mock.calls[1][0].systemMessage.content)).not.toContain(
      "I will carefully plan all the scenes",
    );
  });

  it("throws a typed bounded error after two prose-only attempts", async () => {
    const handler = vi.fn().mockResolvedValue(
      new AIMessage("Here is my internal scene-by-scene plan."),
    );

    const result = invokeWrapModelCall(
      request([
        new HumanMessage("Generate the next episode."),
        toolCallResponse("write_episode_script_chunk", {
          episodeId: 128,
          operation: "append",
          expectedDraftRevision: 3,
          scenes: [],
        }),
        toolResult(
          "write_episode_script_chunk",
          JSON.stringify({
            status: "script_chunk_appended",
            persisted: true,
            retryThisInvocation: true,
            episodeId: 128,
            draftRevision: 4,
            authoringProgress: { nextSceneNumber: 9, nextSceneEnd: 16 },
          }),
        ),
      ]),
      handler,
    );

    await expect(result).rejects.toMatchObject({
      name: "ProductionToolCallProtocolError",
      code: "PRODUCTION_TOOL_CALL_PROTOCOL_VIOLATION",
      attempts: 2,
      turn: "after_write_episode_script_chunk",
    });
    await expect(result).rejects.toBeInstanceOf(ProductionToolCallProtocolError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "unknown receipt status",
      receipt: {
        status: "future_chunk_status",
        retryThisInvocation: true,
        episodeId: 128,
        draftRevision: 4,
      },
    },
    {
      label: "partial receipt without a valid next range",
      receipt: {
        status: "script_chunk_appended",
        persisted: true,
        retryThisInvocation: true,
        episodeId: 128,
        draftRevision: 4,
      },
    },
    {
      label: "unpersisted partial-success receipt",
      receipt: {
        status: "script_chunk_appended",
        persisted: false,
        retryThisInvocation: true,
        episodeId: 128,
        draftRevision: 4,
        authoringProgress: { nextSceneNumber: 9, nextSceneEnd: 16 },
      },
    },
    {
      label: "unpersisted complete-draft receipt",
      receipt: {
        status: "script_draft_complete",
        persisted: false,
        retryThisInvocation: true,
        episodeId: 128,
        draftRevision: 4,
      },
    },
    {
      label: "malformed receipt",
      receipt: "not-json",
    },
  ])("does not generic-force a tool after $label", async ({ receipt }) => {
    const finalAnswer = new AIMessage("Resume from durable state on the next run.");
    const handler = vi.fn().mockResolvedValue(finalAnswer);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolCallResponse("write_episode_script_chunk", {
        episodeId: 128,
        operation: "append",
        expectedDraftRevision: 3,
        scenes: [],
      }),
      toolResult(
        "write_episode_script_chunk",
        typeof receipt === "string" ? receipt : JSON.stringify(receipt),
      ),
    ]);

    expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
    expect(await invokeWrapModelCall(modelRequest, handler)).toBe(finalAnswer);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(modelRequest);
    expect(handler.mock.calls[0][0].toolChoice).toBe("auto");
  });

  it.each([
    {
      status: "script_chunk_too_large",
      persisted: false,
      retryThisInvocation: false,
      episodeId: 128,
      operation: "append",
      requestedSceneRange: { startScene: 1, endScene: 8 },
    },
    {
      status: "script_draft_complete",
      persisted: false,
      retryThisInvocation: false,
      episodeId: 128,
      draftRevision: 4,
    },
    {
      status: "invalid_script_chunk",
      persisted: true,
      retryThisInvocation: false,
      episodeId: 128,
      draftRevision: 4,
    },
  ])("never continues a terminal chunk receipt: $status", async (receipt) => {
    const finalAnswer = new AIMessage("The invocation stopped safely.");
    const handler = vi.fn().mockResolvedValue(finalAnswer);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolResult("write_episode_script_chunk", JSON.stringify(receipt)),
    ], "none");

    expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
    expect(await invokeWrapModelCall(modelRequest, handler)).toBe(finalAnswer);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    '{"kind":"daily_limit","message":"Only 2 episodes per day can be generated."}',
    '{"kind":"ready","resumeAction":"stop"}',
    '{"status":"needs_reauthor","retryThisInvocation":false}',
  ])("preserves an explicitly terminal receipt: %s", async (receipt) => {
    const tool = receipt.includes("needs_reauthor")
      ? "write_episode_script_chunk"
      : "get_next_episode";
    const finalAnswer = new AIMessage("The run has stopped safely.");
    const handler = vi.fn().mockResolvedValue(finalAnswer);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolResult(tool, receipt),
    ], "none");

    expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
    expect(await invokeWrapModelCall(modelRequest, handler)).toBe(finalAnswer);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(modelRequest);
    expect(handler.mock.calls[0][0].toolChoice).toBe("none");
  });

  it("does not constrain a legitimate final response after an unrelated production tool", async () => {
    const finalAnswer = new AIMessage("The episode video is assembled.");
    const handler = vi.fn().mockResolvedValue(finalAnswer);
    const modelRequest = request([
      new HumanMessage("Generate the next episode."),
      toolResult("assemble_episode_video", '{"status":"completed"}'),
    ]);

    expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
    expect(await invokeWrapModelCall(modelRequest, handler)).toBe(finalAnswer);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(modelRequest);
  });

  it("does not leak into another agent that lacks this production tool surface", async () => {
    const modelRequest = {
      ...request([new HumanMessage("Answer normally.")]),
      tools: [{ name: "search" }] as any[],
    };
    expect(requiredProductionToolTurn(modelRequest as any)).toBeNull();
  });

  it("propagates provider errors unchanged without a protocol retry", async () => {
    const providerError = Object.assign(new Error("provider unavailable"), {
      status: 503,
    });
    const handler = vi.fn().mockRejectedValue(providerError);

    const result = invokeWrapModelCall(
      request([new HumanMessage("Generate the next episode.")]),
      handler,
    );

    await expect(result).rejects.toBe(providerError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
