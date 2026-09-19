import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

async function main() {
  console.log("=== Testing Raw Provider Calls ===");

  const testTool = new DynamicStructuredTool({
    name: "record_test_result",
    description: "Records a test result.",
    schema: z.object({
      summary: z.string(),
      score: z.number(),
    }),
    func: async (input) => JSON.stringify(input),
  });

  // 1. Test AnyAPI (Claude / Gemini)
  console.log("\n--- Testing AnyAPI (Claude / Gemini) ---");
  const anyApiKey = process.env.ANYAPI_AGENT_KEY_1 || process.env.ANYAPI_KEY;
  const anyApiModel = new ChatOpenAI({
    apiKey: anyApiKey,
    configuration: { baseURL: "https://api.anyapi.ai/v1" },
    model: process.env.ANYAPI_DEEP_AGENT_MODEL || "anthropic/claude-sonnet-4.6",
    temperature: 0.7,
  }).bindTools([testTool], {
    tool_choice: "record_test_result",
  });

  try {
    const res2 = await anyApiModel.invoke([
      new SystemMessage("You must call record_test_result with a summary and score."),
      new HumanMessage("Evaluate this project."),
    ]);
    console.log("AnyAPI tool_calls:", res2.tool_calls);
    console.log("AnyAPI content preview:", String(res2.content).slice(0, 100));
  } catch (err) {
    console.error("AnyAPI failed:", err);
  }
}

main().catch(console.error);
