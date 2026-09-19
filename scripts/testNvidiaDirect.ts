import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

async function main() {
  console.log("=== Testing NVIDIA Direct ===");
  const key = process.env.NVIDIA_DEEP_AGENT_API_KEY_1 || process.env.NVIDIA_API_KEY;

  const testTool = new DynamicStructuredTool({
    name: "record_story_outline",
    description: "Records a story outline.",
    schema: z.object({
      title: z.string(),
      premise: z.string(),
      scenes: z.array(z.object({
        sceneNumber: z.number(),
        narration: z.string(),
      })),
    }),
    func: async (input) => JSON.stringify(input),
  });

  const model = new ChatOpenAI({
    apiKey: key,
    configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    temperature: 0.2,
    maxTokens: 4096,
  }).bindTools([testTool], {
    tool_choice: "record_story_outline",
  });

  console.log("Sending prompt to NVIDIA...");
  const t0 = Date.now();
  const res = await model.invoke([
    new SystemMessage("You must call record_story_outline with 3 short scenes."),
    new HumanMessage("Write a 3-scene story about Pip the Ant finding an acorn."),
  ]);
  console.log(`NVIDIA responded in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("Tool calls:", JSON.stringify(res.tool_calls, null, 2));
}

main().catch(console.error);
