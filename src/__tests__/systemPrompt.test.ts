import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT_EXTENSION,
  buildSystemPromptExtension,
} from "../systemPrompt.js";

describe("production system prompt", () => {
  it("keeps detailed scene authorship without restoring character-sheet prose", () => {
    for (const requiredDetail of [
      "environmentDescription",
      "action",
      "characterNames",
      "supportingEntities",
      "continuityAnchors",
      "sceneDetails",
      "cameraAngle",
      "lighting",
    ]) {
      expect(SYSTEM_PROMPT_EXTENSION, requiredDetail).toContain(requiredDetail);
    }

    expect(SYSTEM_PROMPT_EXTENSION).toContain("20-24 scene preschool adventure");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("one naturally integrated learning idea");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Avoid filler and repeated beats");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("not semantic pass/fail tests");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Do not write characterVisuals or appearance descriptions");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("1-5 uniquely named main characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("never a character sheet or appearance paragraph");
    expect(SYSTEM_PROMPT_EXTENSION).not.toContain("at least 750 spoken words");
    expect(SYSTEM_PROMPT_EXTENSION).not.toContain("at least 300 measured narration seconds");
  });

  it("keeps the one-audio/one-video timing and narration-only repair rules", () => {
    expect(SYSTEM_PROMPT_EXTENSION).toContain("One scene = one narrationText = one Groq WAV = one Agnes request = one normalized final clip");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("hard limits are 20 spoken words and 200 raw characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("exact WAV duration");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("synthesize_episode_narration_audio once");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("shorten narrationText only");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("preserves every other scene field");
  });

  it("defines a compact resumable state machine and static QA", () => {
    for (const action of [
      "script_and_audio",
      "script_authoring",
      "repair_script",
      "audio_repair",
      "agnes",
      "youtube_upload",
    ]) {
      expect(SYSTEM_PROMPT_EXTENSION).toContain(action);
    }

    expect(SYSTEM_PROMPT_EXTENSION).toContain("ensure_series_character_portraits once");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("up to eight concise complete scene objects");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("A plan guides story quality but is not semantically graded");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Static QA checks durable rows");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("no Gemini/AnyAPI analysis call");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("never requests a QA rerender");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("upload_to_youtube is not available");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("do not generate YouTube metadata or mark the episode done");

    const enabledPrompt = buildSystemPromptExtension(true);
    expect(enabledPrompt).toContain("Only its durable success receipt may mark the episode done");
    expect(enabledPrompt).toContain("call upload_to_youtube once with the canonical seriesId and episodeNumber");
    expect(SYSTEM_PROMPT_EXTENSION.length).toBeLessThan(8_000);
  });
});
