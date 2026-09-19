import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  countNarrationSpokenWords,
  inspectNarrationText,
} from "../src/services/narrationContract.js";
import { z } from "zod";

const ROSTER_NAMES = [
  "Pip the Ant",
  "Nibbles the Hamster",
  "Sunny the Sparrow",
  "Pebble the Turtle",
  "Chip the Squirrel",
] as const;

const authoringPlanBeatSchema = z.object({
  startScene: z.number().int().min(1).max(30),
  endScene: z.number().int().min(1).max(30),
  storyBeat: z.string().describe("The causal story movement advancing the single continuous quest."),
  setting: z.string().describe("The location and physical environment for this beat."),
  continuityOutcome: z.string().describe("The concrete irreversible story/prop state carried forward."),
});

const authoringPlanSchema = z.object({
  storyArc: z.string().describe("Complete single continuous preschool adventure from scene 1 to 24 strictly matching title and premise."),
  educationalIdea: z.string().describe("The one integrated learning idea."),
  endingInsight: z.string().describe("The final age-appropriate insight for ages 4-8."),
  beats: z.array(authoringPlanBeatSchema).describe("Sequential beats covering scenes 1 to 24 across the 5 dramatic stages."),
  supportingEntityBible: z.array(z.string()).default([]),
  continuityBible: z.array(z.string()).default([]),
});

const sceneSchema = z.object({
  sceneNumber: z.number().int().min(1).max(30),
  narrationText: z.string().describe(
    "10 to 16 spoken words (hard limit: 20 words, <=180 chars). MUST include expressive quoted dialogue inside third-person narration (e.g., 'Look up there!' chirped Sunny, pointing her wing.). Name only 1-2 active friends or 'the club'.",
  ),
  environmentDescription: z.string().describe(
    "Specific physical setting. Must keep verbatim wording across adjacent shots in the same location for visual continuity.",
  ),
  action: z.string().describe(
    "Visible story beat with specific character physical movement and reaction.",
  ),
  characterNames: z.array(z.string()).describe(
    "CRITICAL: Array of 1 to 3 active club members visible in this scene. You MUST ONLY choose from these 5 names: 'Pip the Ant', 'Nibbles the Hamster', 'Sunny the Sparrow', 'Pebble the Turtle', 'Chip the Squirrel'. NEVER put guest characters (like Lily the Ladybug, Ducklings, Mouse) in characterNames; they belong ONLY in supportingEntities.",
  ),
  supportingEntities: z.array(z.string()).default([]).describe(
    "Visible guest creatures with locked descriptor: 'Name: visual descriptor' (e.g. 'Lily the Ladybug: tiny scarlet ladybug with 7 black spots'). Non-roster creatures go here.",
  ),
  continuityAnchors: z.array(z.string()).min(1).describe(
    "CRITICAL: Non-empty array of continuing props, tools, or physical items carried across shots (e.g. '[Anchor 1]: The golden leaf with dewdrop spots').",
  ),
  lighting: z.string().describe("Lighting profile: e.g. 'warm morning sunlight', 'golden afternoon light'."),
  cameraAngle: z.string().describe("Camera framing: 'establishing', 'medium', or 'close'."),
});

const writeEpisodeScriptChunkSchema = z.object({
  operation: z.literal("start").describe("start begins the complete 24-scene script draft."),
  episodeId: z.number().int().positive(),
  targetSceneCount: z.literal(24).describe("Target exactly 24 scenes for the complete episode."),
  authoringPlan: authoringPlanSchema.describe("The 24-scene authoring plan covering the 5 dramatic stages."),
  scenes: z.array(sceneSchema).min(24).max(24).describe("The complete contiguous sequence of scenes 1 to 24. ALL 24 scenes are REQUIRED in this single tool call."),
});

export function buildTestSystemPrompt(): string {
  return `## Kids story episode production (ages 4-8)

You are the production script author for the "Tiny Heroes Club" animated series.
Your task is to write one complete, coherent, continuous 24-scene preschool adventure (~2 minutes total runtime) in a single tool call to write_episode_script_chunk(operation=start, targetSceneCount=24, scenes=[scenes 1-24]).

### CRITICAL RULES:
1. PREMISE LOCK:
   The story, characters, and events MUST strictly follow the assigned episode title and premise. Never invent an unrelated creature, quest, or story.

2. ONE SINGLE CONTINUOUS STORY (24 Scenes, 0 Repetition):
   The episode must follow a single forward causal progression across 5 dramatic stages:
   - Stage 1 (Scenes 1-4) Wonder & Introduction: Establish the meadow clubhouse, the friends in action, and introduce the initial situation or guest.
   - Stage 2 (Scenes 5-8) The Specific Problem: The exact quest from the premise is revealed (e.g. lost leaf home). The club commits to help and begins the search.
   - Stage 3 (Scenes 9-16) Teamwork & The Tricky Obstacle: The club investigates clues across the meadow. They spot where the lost item/problem is, but encounter a real physical obstacle (e.g., across a swift stream, wedged under heavy stones, high in thorny brambles). Friends combine their distinct talents (Pip coordinates, Sunny scouts, Nibbles invents a tool, Pebble plans stability, Chip gathers materials). DO NOT conclude or solve the quest here!
   - Stage 4 (Scenes 17-20) Cooperative Retrieval Climax: Working together in an exciting cooperative breakthrough to reach, retrieve, or solve the problem.
   - Stage 5 (Scenes 21-24) Celebration & Insight: Joyful reunion, returning the item/home, grateful cheer, and a warm, clear preschool insight for ages 4-8.
   DO NOT repeat scenes or cycle back to earlier beats. Advance plot strictly forward.

3. CONSISTENCY & CONTINUITY:
   - environmentDescription: Use reusable environment clusters (e.g., "Tiny Heroes Clubhouse hollow stump", "Bramble Hedge Path", "Whispering Brook pebble bank"). Keep adjacent shots in the same location verbatim for visual continuity.
   - continuityAnchors: MUST NOT BE EMPTY in any scene. Always list concrete physical props, carried items, or active tools (e.g., "[Anchor 1]: The golden oak leaf with dewdrop markings", "[Anchor 2]: Nibbles' twig-and-vine reach tool").
   - supportingEntities: Format visible guest characters with locked stable visual descriptors (e.g. "Lily the Ladybug: tiny scarlet ladybug with 7 black spots").
   - characterNames: EXACTLY chosen from the 5 roster characters ('Pip the Ant', 'Nibbles the Hamster', 'Sunny the Sparrow', 'Pebble the Turtle', 'Chip the Squirrel'). Only include 1 to 3 active club members per scene. NEVER put guest creatures (like Lily the Ladybug, Duckling, Mouse) in characterNames; guest creatures MUST be in supportingEntities!

4. NARRATION & DIALOGUE:
   - Target 10 to 16 spoken words per scene (hard limit: 20 words, <=180 characters).
   - MANDATORY: Include quoted spoken dialogue in EVERY scene (e.g. "Look up there!" chirped Sunny, pointing her wing toward the high bramble. or "Hold on tight!" cheered Pip.).
   - Name only the 1 or 2 active friends, or say "the club" or "the friends". Never list all 5 character names in one sentence.
   - Any guest creature (e.g. Lily the Ladybug, Mama Duck, Little Mouse) must only be in supportingEntities, NEVER in characterNames.

Emit ONLY the write_episode_script_chunk tool call with the complete scenes array of all 24 scenes. Do not emit markdown, JSON prose, or explanation.`;
}

export async function runStoryScriptTest(params: {
  storyNumber: number;
  title: string;
  premise: string;
  episodeId: number;
}) {
  console.log(`\n======================================================`);
  console.log(`TESTING STORY ${params.storyNumber}: "${params.title}"`);
  console.log(`Premise: "${params.premise}"`);
  console.log(`======================================================\n`);

  // Build Requesty model (Gemini 2.5 Flash for fast, robust tool calling)
  // with fallback to NVIDIA if Requesty key is absent
  const requestyKey = process.env.REQUESTY_API_KEY;
  const nvidiaKey = process.env.NVIDIA_DEEP_AGENT_API_KEY_1 || process.env.NVIDIA_API_KEY;

  let model: any;
  let providerName = "requesty";
  if (requestyKey) {
    const selectedModel = process.env.TEST_MODEL || "deepseek/deepseek-chat";
    model = new ChatOpenAI({
      apiKey: requestyKey,
      configuration: { baseURL: "https://router.requesty.ai/v1" },
      model: selectedModel,
      temperature: 0.2,
      maxTokens: 16384,
    });
    console.log(`Using Requesty with model: ${selectedModel}`);
  } else {
    providerName = "nvidia";
    model = new ChatOpenAI({
      apiKey: nvidiaKey,
      configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      temperature: 0.2,
      maxTokens: 16384,
    });
    console.log("Using NVIDIA with model: nvidia/nemotron-3.5-lightning-30b-a3b");
  }

  let capturedArgs: any = null;

  const scriptChunkTool = new DynamicStructuredTool({
    name: "write_episode_script_chunk",
    description: "Writes the complete 24-scene episode script in a single call.",
    schema: writeEpisodeScriptChunkSchema,
    func: async (input) => {
      capturedArgs = input;
      return JSON.stringify({ status: "script_draft_complete", sceneCount: input.scenes.length });
    },
  });

  const modelWithTools = model.bindTools([scriptChunkTool], {
    tool_choice: { type: "function", function: { name: "write_episode_script_chunk" } },
  });

  const userPrompt = `Generate the next episode for the Tiny Heroes Club concept and upload it on youtube.
Concept: Tiny Heroes Club.
Premise: Instead of superheroes saving the world, tiny animals solve everyday problems.
Characters:
- Pip the Ant (leader)
- Nibbles the Hamster (inventor)
- Sunny the Sparrow (scout)
- Pebble the Turtle (planner)
- Chip the Squirrel (collector)

Episode to Author:
Series: Tiny Heroes Club (Series 16)
Episode ID: ${params.episodeId}
Title: "${params.title}"
Premise: "${params.premise}"

Target for ages 4-8 with natural, engaging vocabulary and short spoken sentences (10 to 16 words per scene).
Include character reactions and quoted dialogue inside third-person narration.
Do not list all character names in narration; refer to them collectively as the club or name only the 1 or 2 active friends.
Give the episode an engaging progression: wonder -> problem -> teamwork -> discovery -> celebration, ending with a clear age-appropriate insight.
Remember: characterNames must ONLY be chosen from the 5 roster characters (Pip the Ant, Nibbles the Hamster, Sunny the Sparrow, Pebble the Turtle, Chip the Squirrel). Any guest creature goes into supportingEntities.

Call write_episode_script_chunk now with operation=start, episodeId=${params.episodeId}, targetSceneCount=24, authoringPlan covering the 5 stages, and the COMPLETE array of all 24 scenes (scenes 1 to 24).`;

  let chunkCall: any = null;
  let args: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Invoking LLM for Story ${params.storyNumber} (Attempt ${attempt}/3)...`);
    const startTime = Date.now();

    try {
      const response = await modelWithTools.invoke([
        new SystemMessage(buildTestSystemPrompt()),
        new HumanMessage(userPrompt),
      ]);

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`LLM responded in ${durationSec}s.`);

      const toolCalls = response.tool_calls || [];
      chunkCall = toolCalls.find((tc: any) => tc.name === "write_episode_script_chunk");

      console.log(`Tool call received: name=${chunkCall?.name}, scenes length=${chunkCall?.args?.scenes?.length}, args keys=${Object.keys(chunkCall?.args || {})}`);
      if (chunkCall?.args?.scenes?.length >= 20 && chunkCall?.args?.scenes?.length <= 30) {
        args = chunkCall.args;
        break;
      }

      console.warn(`Attempt ${attempt}: Scene count was ${chunkCall?.args?.scenes?.length}; expected 24. Waiting 4s before retry...`);
      if ((response as any).response_metadata) {
        console.log("response_metadata:", JSON.stringify((response as any).response_metadata, null, 2));
      }
      await new Promise((r) => setTimeout(r, 4000));
    } catch (err: any) {
      console.error(`Attempt ${attempt} error:`, err?.message || err);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  if (!args) {
    console.error(`FAIL: Failed to obtain 24 scenes for Story ${params.storyNumber} after 3 attempts.`);
    return null;
  }

  // Defensive sanitization: ensure characterNames only contains roster characters
  for (const scene of args.scenes || []) {
    if (Array.isArray(scene.characterNames)) {
      const rosterOnly = scene.characterNames.filter((n: string) => ROSTER_NAMES.includes(n as any));
      // Move any guest characters to supportingEntities if not already present
      const guestEntities = scene.characterNames.filter((n: string) => !ROSTER_NAMES.includes(n as any));
      if (guestEntities.length > 0) {
        scene.supportingEntities = scene.supportingEntities || [];
        for (const guest of guestEntities) {
          if (!scene.supportingEntities.some((e: string) => e.startsWith(guest))) {
            scene.supportingEntities.push(guest);
          }
        }
      }
      scene.characterNames = rosterOnly.length > 0 ? rosterOnly : ["Pip the Ant"];
    }
  }

  console.log(`Tool call received: operation=${args.operation}, targetSceneCount=${args.targetSceneCount}, scenes=${args.scenes?.length}`);

  // Validation Audit
  const audit = auditGeneratedScript({
    title: params.title,
    premise: params.premise,
    args,
  });

  return {
    args,
    audit,
  };
}

export function auditGeneratedScript(params: {
  title: string;
  premise: string;
  args: any;
}) {
  const { args } = params;
  const scenes: any[] = args.scenes || [];
  const issues: string[] = [];

  // 1. Scene Count
  if (scenes.length !== 24) {
    issues.push(`Expected exactly 24 scenes; received ${scenes.length}.`);
  }

  // 2. Sequential numbers
  scenes.forEach((s, idx) => {
    if (s.sceneNumber !== idx + 1) {
      issues.push(`Scene index ${idx} has sceneNumber ${s.sceneNumber}; expected ${idx + 1}.`);
    }
  });

  // 3. Narration Contract & Dialogue
  let scenesWithDialogue = 0;
  let wordCountViolations = 0;
  let charCountViolations = 0;

  scenes.forEach((s) => {
    const text = s.narrationText || "";
    const inspection = inspectNarrationText(text, { production: true });
    if (!inspection.pass) {
      issues.push(`Scene ${s.sceneNumber} narration failed inspection: ${inspection.issues.map(i => i.message).join(", ")}`);
    }
    if (inspection.spokenWordCount < 8 || inspection.spokenWordCount > 20) {
      wordCountViolations++;
    }
    if (text.length > 180) {
      charCountViolations++;
    }
    if (/"[^"]+"/.test(text) || /'[^']+'/.test(text) || /“[^”]+”/.test(text)) {
      scenesWithDialogue++;
    }
  });

  // 4. Continuity Anchors
  let emptyAnchorCount = 0;
  scenes.forEach((s) => {
    if (!Array.isArray(s.continuityAnchors) || s.continuityAnchors.length === 0) {
      emptyAnchorCount++;
    }
  });
  if (emptyAnchorCount > 0) {
    issues.push(`${emptyAnchorCount}/24 scenes have empty continuityAnchors!`);
  }

  // 5. Cast consistency
  scenes.forEach((s) => {
    const names = s.characterNames || [];
    names.forEach((name: string) => {
      if (!ROSTER_NAMES.includes(name)) {
        issues.push(`Scene ${s.sceneNumber} contains invalid roster name: "${name}"`);
      }
    });
  });

  // 6. Repetition check (detect duplicate narration)
  const narrationSet = new Set<string>();
  let duplicateNarration = 0;
  scenes.forEach((s) => {
    const norm = (s.narrationText || "").toLowerCase().trim();
    if (narrationSet.has(norm)) {
      duplicateNarration++;
    }
    narrationSet.add(norm);
  });
  if (duplicateNarration > 0) {
    issues.push(`Found ${duplicateNarration} duplicate narration lines!`);
  }

  // 7. Environment Cluster Continuity
  const environments = scenes.map(s => s.environmentDescription);
  const uniqueEnvironments = new Set(environments).size;

  const passed = issues.length === 0;

  console.log(`\n--- AUDIT RESULTS FOR "${params.title}" ---`);
  console.log(`Pass: ${passed ? "✅ YES" : "❌ NO"}`);
  console.log(`Total Scenes: ${scenes.length}/24`);
  console.log(`Scenes with Quoted Dialogue: ${scenesWithDialogue}/24`);
  console.log(`Empty Continuity Anchors: ${emptyAnchorCount}/24`);
  console.log(`Unique Environment Clusters: ${uniqueEnvironments}`);
  console.log(`Word Count Outliers (<8 or >20 words): ${wordCountViolations}`);
  console.log(`Char Count Outliers (>180 chars): ${charCountViolations}`);
  console.log(`Duplicate Narrations: ${duplicateNarration}`);
  if (issues.length > 0) {
    console.log(`Issues (${issues.length}):`);
    issues.slice(0, 10).forEach((iss) => console.log(`  - ${iss}`));
  }
  console.log(`-------------------------------------------\n`);

  return {
    passed,
    issues,
    scenesWithDialogue,
    emptyAnchorCount,
    uniqueEnvironments,
    wordCountViolations,
    duplicateNarration,
    scenes,
  };
}

async function main() {
  console.log("=== RUNNING ISOLATED SCRIPT WRITING STRATEGY TESTS ===");

  const stories = [
    {
      storyNumber: 1,
      title: "The Lost Ladybug Leaf",
      premise: "When a ladybug loses her special leaf home, the Tiny Heroes Club searches the meadow to help her find it.",
      episodeId: 201,
    },
    {
      storyNumber: 2,
      title: "The Stream Crossing",
      premise: "When baby ducklings are separated from their mother by a swift brook, the Tiny Heroes Club works together to build a safe crossing.",
      episodeId: 202,
    },
    {
      storyNumber: 3,
      title: "The Giant Pinecone Jam",
      premise: "When a rolling pinecone wedges firmly in front of the field mouse family's burrow door, the Tiny Heroes Club devises a clever lever to unblock it.",
      episodeId: 203,
    },
  ];

  const results = [];
  const outDir = path.resolve(process.cwd(), "output", "test_script_generations");
  await mkdir(outDir, { recursive: true });

  for (const story of stories) {
    const result = await runStoryScriptTest(story);
    results.push({ story, result });
    if (result?.args) {
      const filePath = path.join(outDir, `story_${story.storyNumber}_${story.title.replace(/\s+/g, "_")}.json`);
      await writeFile(filePath, JSON.stringify(result.args, null, 2));
      console.log(`Saved story output to ${filePath}`);
    }
    console.log("Waiting 4s before next story to ensure clean rate limits...");
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\n======================================================");
  console.log("OVERALL SUMMARY ACROSS ALL 3 STORIES:");
  results.forEach(({ story, result }) => {
    const audit = result?.audit;
    console.log(`Story ${story.storyNumber} "${story.title}": ${audit?.passed ? "✅ PASSED" : "❌ FAILED"} | Scenes: ${audit?.scenes?.length ?? 0}/24 | Dialogue: ${audit?.scenesWithDialogue ?? 0}/24 | Anchors non-empty: ${24 - (audit?.emptyAnchorCount ?? 0)}/24 | Envs: ${audit?.uniqueEnvironments}`);
  });
  console.log("======================================================\n");
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith("testScriptWritingStrategies.ts") ||
  process.argv[1].endsWith("testScriptWritingStrategies.js")
);

if (isDirectRun) {
  main().catch(console.error);
}
