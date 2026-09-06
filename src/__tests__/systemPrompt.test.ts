import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_EXTENSION } from "../systemPrompt.js";

describe("production system prompt", () => {
  it("retains the complete story and visual-quality contract", () => {
    for (const requiredDetail of [
      "environmentDescription",
      "action",
      "characterNames",
      "characterVisuals",
      "supportingEntities",
      "continuityAnchors",
      "sceneDetails",
      "cameraAngle",
      "lighting",
      "visualForm",
    ]) {
      expect(SYSTEM_PROMPT_EXTENSION, requiredDetail).toContain(requiredDetail);
    }

    expect(SYSTEM_PROMPT_EXTENSION).toContain("40-60 distinct scenes");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("at least 750 spoken words");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("target about 800 words");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("at least 300 measured narration seconds");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Scene 1 must establish time, place, mood");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("light preschool repetition");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("distinctive character voices and reactions");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("one naturally integrated educational idea");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("No filler or duplicate beats");
  });

  it("keeps the one-audio/one-video timing and narrow-repair rules", () => {
    expect(SYSTEM_PROMPT_EXTENSION).toContain("One script scene equals one narration paragraph, one Groq WAV, one Agnes request, and one final clip");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("no more than 20 spoken words");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("no more than 200 raw characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("exact WAV duration");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("synthesize_episode_narration_audio once");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Cloudflare is first and NVIDIA is fallback");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("may change only narrationText");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("environment, action, characters, visual forms, supporting entities, continuity, camera, and lighting remain untouched");
  });

  it("defines a compact resumable state machine without dropping safety", () => {
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
    expect(SYSTEM_PROMPT_EXTENSION).toContain("write_episode_script_chunk sequentially");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("operation=start");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("operation=append");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("operation=restart");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("scenes field must always be a real JSON array");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("sceneDetails must be at least 60 characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("semantic quality rejection explicitly returns retryThisInvocation=true");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("immediately rewrite only that same exact range");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("append call TARGET is at most 18000 serialized characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("start/restart call TARGET is at most 20000");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("hard content maximum is 24000");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("TARGET each complete scene at no more than 2000 serialized characters");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("syntactically valid size rejection returns retryThisInvocation=true");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("chunking is transport only and must not reduce creative detail");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("reuse that persisted script and do not draft or replace it");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("ensure_series_character_sheets once");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("only before the first claim");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("identities are immutable and missing sheets fail closed");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("rejected draft's exact expectedDraftRevision");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("synthesize_episode_narration_audio once with seriesId and episodeNumber");
    expect(SYSTEM_PROMPT_EXTENSION).toContain("Only a durable successful YouTube receipt may finalize the episode as done");
    expect(SYSTEM_PROMPT_EXTENSION.length).toBeLessThan(13_000);
  });
});
