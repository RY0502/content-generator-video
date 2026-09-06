import { ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  createAgent,
  FakeToolCallingModel,
} from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildEndEpisodeInvocationTool,
  END_EPISODE_INVOCATION_TOOL_NAME,
  guardTerminalEpisodeInvocationReceipts,
  wrapTerminalEpisodeInvocationReceipt,
} from "../services/episodeInvocationBoundary.js";

function graphToolConfig(toolCallId: string) {
  return {
    toolCall: {
      id: toolCallId,
      name: "refine_episode_script",
      args: {},
      type: "tool_call" as const,
    },
  };
}

async function streamNodeNames(receipt: string): Promise<string[]> {
  const model = new FakeToolCallingModel({
    toolCalls: [
      [{
        name: "refine_episode_script",
        args: {},
        id: "refine-call-1",
        type: "tool_call",
      }],
      [],
    ],
  });
  const refinement = guardTerminalEpisodeInvocationReceipts(new DynamicStructuredTool({
    name: "refine_episode_script",
    description: "Test-only refinement receipt.",
    schema: z.object({}).strict(),
    func: async () => receipt,
  }));
  const agent = createAgent({
    model,
    tools: [refinement, buildEndEpisodeInvocationTool()],
  });

  const nodes: string[] = [];
  const stream = await agent.stream({
    messages: [{ role: "user", content: "Validate the staged script." }],
  });
  for await (const chunk of stream) nodes.push(...Object.keys(chunk));
  return nodes;
}

describe("episode invocation boundary", () => {
  it("preserves a terminal receipt and tool-call id in the sentinel ToolMessage", () => {
    const receipt = '{ "status": "needs_reauthor", "retryThisInvocation": false }';
    const result = wrapTerminalEpisodeInvocationReceipt(
      receipt,
      graphToolConfig("tool-call-42"),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).name).toBe(END_EPISODE_INVOCATION_TOOL_NAME);
    expect((result as ToolMessage).tool_call_id).toBe("tool-call-42");
    expect((result as ToolMessage).content).toBe(receipt);
  });

  it("leaves direct calls, normal receipts, malformed JSON, and nested flags unchanged", () => {
    const terminal = '{"retryThisInvocation":false,"status":"needs_reauthor"}';
    const ready = '{"status":"ready","persisted":true}';
    const malformed = '{"retryThisInvocation":false';
    const nested = '{"receipt":{"retryThisInvocation":false}}';
    const config = graphToolConfig("tool-call-7");

    expect(wrapTerminalEpisodeInvocationReceipt(terminal)).toBe(terminal);
    expect(wrapTerminalEpisodeInvocationReceipt(terminal, graphToolConfig(""))).toBe(terminal);
    expect(wrapTerminalEpisodeInvocationReceipt(ready, config)).toBe(ready);
    expect(wrapTerminalEpisodeInvocationReceipt(malformed, config)).toBe(malformed);
    expect(wrapTerminalEpisodeInvocationReceipt(nested, config)).toBe(nested);
  });

  it("provides exactly one return-direct routing sentinel", () => {
    const tool = buildEndEpisodeInvocationTool();

    expect(tool.name).toBe("end_episode_invocation");
    expect(tool.returnDirect).toBe(true);
  });

  it("keeps a guarded tool's public identity and direct-call result", async () => {
    const receipt = '{"status":"needs_reauthor","retryThisInvocation":false}';
    const tool = guardTerminalEpisodeInvocationReceipts(new DynamicStructuredTool({
      name: "stage_episode_script_draft",
      description: "Test-only staged draft.",
      schema: z.object({}).strict(),
      func: async () => receipt,
    }));

    expect(tool.name).toBe("stage_episode_script_draft");
    expect(await tool.invoke({})).toBe(receipt);
  });

  it("ends the graph immediately after a terminal receipt", async () => {
    const nodes = await streamNodeNames(
      '{"status":"needs_reauthor","retryThisInvocation":false}',
    );

    expect(nodes).toEqual(["model_request", "tools"]);
  });

  it("continues to the model after a non-terminal ready receipt", async () => {
    const nodes = await streamNodeNames(
      '{"status":"ready","persisted":true}',
    );

    expect(nodes).toEqual(["model_request", "tools", "model_request"]);
  });

  it("continues to the model when a receipt explicitly requests an in-run retry", async () => {
    const nodes = await streamNodeNames(
      '{"status":"invalid_script_chunk","persisted":true,"retryThisInvocation":true}',
    );

    expect(nodes).toEqual(["model_request", "tools", "model_request"]);
  });
});
