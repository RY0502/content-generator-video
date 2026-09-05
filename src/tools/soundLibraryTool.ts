import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";

function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Very small keyword -> filename-substring matcher against a curated local
 * CC0/royalty-free asset bank (assets/sfx, assets/music). No network calls;
 * this keeps sound design fully offline and license-safe. The bank itself
 * must be populated by the user/operator (see README for sourcing notes)
 * since we cannot bundle third-party audio here.
 */
async function findBestMatch(dir: string, keywords: string[]): Promise<string | null> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const scored = files
    .map((f) => ({
      file: f,
      score: lowerKeywords.filter((k) => f.toLowerCase().includes(k)).length,
    }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0] ? path.join(dir, scored[0].file) : null;
}

export function buildSoundLibraryTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "find_scene_sound",
    description:
      "Looks up a subtle sound-effect and/or background-music file from the local curated royalty-free " +
      "asset bank (assets/sfx, assets/music) matching the given scene keywords (e.g. 'forest', 'water', " +
      "'cheer', 'footsteps'). Returns null for either if no match is found — do not fabricate a path.",
    schema: z.object({
      sceneKeywords: z
        .preprocess(parseJsonArrayInput, z.array(z.string()))
        .describe("Keywords describing the scene's setting/action/mood. Can be JSON string or array."),
    }),
    func: async ({ sceneKeywords }) => {
      const sfxPath = await findBestMatch(path.join(CONFIG.assetsDir, "sfx"), sceneKeywords);
      const musicPath = await findBestMatch(path.join(CONFIG.assetsDir, "music"), sceneKeywords);
      return JSON.stringify({ sfxPath, musicPath });
    },
  });
}
