import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import {
  AgentProgressCallback,
  type AgentProgressLogger,
} from "../services/agentProgressCallback.js";

function serialized(name: string, secret = "never-log-this-secret") {
  return {
    lc: 1,
    type: "constructor" as const,
    id: ["langchain", "test", name],
    name,
    kwargs: { apiKey: secret },
  };
}

function harness(times: number[]) {
  const info = vi.fn();
  const error = vi.fn();
  const logger: AgentProgressLogger = { info, error };
  const now = vi.fn(() => {
    const value = times.shift();
    if (value === undefined) throw new Error("Test clock exhausted.");
    return value;
  });
  return {
    callback: new AgentProgressCallback({ logger, now }),
    info,
    error,
  };
}

describe("AgentProgressCallback", () => {
  it("logs only compact LLM metadata and elapsed time", () => {
    const { callback, info } = harness([1_000, 1_275]);
    const promptSecret = "prompt-secret-do-not-log";

    callback.handleChatModelStart(
      serialized("ChatOpenAI"),
      [[new HumanMessage(promptSecret)]],
      "12345678-full-run-id",
    );
    callback.handleLLMEnd({
      generations: [[{ text: "private model response" }]],
      llmOutput: { providerResponse: "private-provider-payload" },
    }, "12345678-full-run-id");

    expect(info).toHaveBeenNthCalledWith(1, "[agent-progress] LLM call started", {
      runId: "12345678",
      model: "ChatOpenAI",
      messageCount: 1,
      inputTextChars: promptSecret.length,
    });
    expect(info).toHaveBeenNthCalledWith(2, "[agent-progress] LLM call completed", {
      runId: "12345678",
      model: "ChatOpenAI",
      elapsedMs: 275,
      outputTextChars: "private model response".length,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(promptSecret);
    expect(JSON.stringify(info.mock.calls)).not.toContain("never-log-this-secret");
    expect(JSON.stringify(info.mock.calls)).not.toContain("private model response");
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-provider-payload");
  });

  it("logs tool names and sizes without tool arguments or results", () => {
    const { callback, info } = harness([2_000, 2_480]);
    const inputSecret = "{\"bearerToken\":\"input-secret\"}";
    const outputSecret = "output-secret";

    callback.handleToolStart(
      serialized("DynamicStructuredTool"),
      inputSecret,
      "tool-run-long-id",
      undefined,
      undefined,
      { token: "metadata-secret" },
      "get_next_episode",
    );
    callback.handleToolEnd(outputSecret, "tool-run-long-id");

    expect(info).toHaveBeenNthCalledWith(1, "[agent-progress] Tool call started", {
      runId: "tool-run",
      tool: "get_next_episode",
      inputChars: inputSecret.length,
    });
    expect(info).toHaveBeenNthCalledWith(2, "[agent-progress] Tool call completed", {
      runId: "tool-run",
      tool: "get_next_episode",
      elapsedMs: 480,
      outputChars: outputSecret.length,
    });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("input-secret");
    expect(logged).not.toContain(outputSecret);
    expect(logged).not.toContain("metadata-secret");
    expect(logged).not.toContain("never-log-this-secret");
  });

  it("logs safe finish and token telemetry for a truncated tool-call generation", () => {
    const { callback, info } = harness([1_000, 2_000]);
    const privateToolArgument = "private-script-payload";

    callback.handleChatModelStart(
      serialized("ChatOpenAI"),
      [[new HumanMessage("hidden prompt")]],
      "length-limited-run",
    );
    callback.handleLLMEnd({
      generations: [[{
        text: "",
        generationInfo: { finish_reason: "length" },
        message: {
          tool_calls: [{ name: "stage_episode_script_draft", args: privateToolArgument }],
          usage_metadata: {
            input_tokens: 5_000,
            output_tokens: 16_384,
            total_tokens: 21_384,
            output_token_details: { reasoning: 4_096 },
          },
        },
      } as any]],
      llmOutput: { providerPayload: "private-provider-response" },
    }, "length-limited-run");

    expect(info).toHaveBeenLastCalledWith("[agent-progress] LLM call completed", {
      runId: "length-l",
      model: "ChatOpenAI",
      elapsedMs: 1_000,
      outputTextChars: 0,
      finishReason: "length",
      inputTokens: 5_000,
      outputTokens: 16_384,
      totalTokens: 21_384,
      reasoningTokens: 4_096,
    });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(privateToolArgument);
    expect(logged).not.toContain("private-provider-response");
  });

  it("does not expose provider or tool error messages", () => {
    const { callback, error } = harness([3_000, 3_250, 4_000, 4_600]);

    callback.handleChatModelStart(
      serialized("ChatOpenAI"),
      [[new HumanMessage("hidden")]],
      "llm-error-run",
    );
    const llmError = Object.assign(new Error("Authorization: Bearer llm-secret"), {
      status: 429,
    });
    callback.handleLLMError(llmError, "llm-error-run");

    callback.handleToolStart(
      serialized("Tool"),
      "hidden input",
      "tool-error-run",
      undefined,
      undefined,
      undefined,
      "submit_agnes_scene_videos",
    );
    const toolError = Object.assign(new TypeError("token=tool-secret"), {
      response: { status: 503 },
    });
    callback.handleToolError(toolError, "tool-error-run");

    expect(error).toHaveBeenNthCalledWith(1, "[agent-progress] LLM call failed", {
      runId: "llm-erro",
      model: "ChatOpenAI",
      elapsedMs: 250,
      errorName: "Error",
      status: 429,
    });
    expect(error).toHaveBeenNthCalledWith(2, "[agent-progress] Tool call failed", {
      runId: "tool-err",
      tool: "submit_agnes_scene_videos",
      elapsedMs: 600,
      errorName: "TypeError",
      status: 503,
    });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("llm-secret");
    expect(logged).not.toContain("tool-secret");
  });

  it("tracks overlapping calls independently", () => {
    const { callback, info } = harness([100, 200, 350, 600]);

    callback.handleChatModelStart(serialized("FirstModel"), [[]], "first-run");
    callback.handleChatModelStart(serialized("SecondModel"), [[]], "second-run");
    callback.handleLLMEnd({ generations: [] }, "second-run");
    callback.handleLLMEnd({ generations: [] }, "first-run");

    expect(info.mock.calls[2]?.[1]).toMatchObject({
      model: "SecondModel",
      elapsedMs: 150,
    });
    expect(info.mock.calls[3]?.[1]).toMatchObject({
      model: "FirstModel",
      elapsedMs: 500,
    });
  });
});
