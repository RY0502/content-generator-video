import { describe, expect, it } from "vitest";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
  countNarrationSpokenWords,
  inspectEpisodeNarrationManifest,
  inspectNarrationDuration,
  inspectNarrationText,
  minimumNarrationWords,
  stripNarrationVocalDirections,
} from "../services/narrationContract.js";

describe("narrationContract", () => {
  it("excludes Orpheus vocal directions while counting spoken words", () => {
    const text = "[warm and gentle] Mia can't wait; fireflies loop-de-loop above the meadow.";

    expect(stripNarrationVocalDirections(text)).not.toContain("warm and gentle");
    expect(countNarrationSpokenWords(text)).toBe(8);
  });

  it("always enforces 200 raw characters and only the 20-word maximum in production", () => {
    const overCharacters = inspectNarrationText("x".repeat(NARRATION_MAX_RAW_CHARACTERS + 1));
    const shortBeat = inspectNarrationText("Pip stops.", { production: true });
    const overWords = inspectNarrationText(
      Array.from({ length: NARRATION_MAX_SPOKEN_WORDS + 1 }, (_, index) => `word${index}`).join(" "),
      { production: true },
    );

    expect(overCharacters.pass).toBe(false);
    expect(overCharacters.issues.map((issue) => issue.code)).toContain("too_many_raw_characters");
    expect(shortBeat).toMatchObject({ pass: true, spokenWordCount: 2 });
    expect(shortBeat.issues.map((issue) => issue.code)).not.toContain("too_few_spoken_words");
    expect(overWords.pass).toBe(false);
    expect(overWords.issues.map((issue) => issue.code)).toContain("too_many_spoken_words");
  });

  it("uses measured duration as the authoritative 12-second postcondition", () => {
    expect(inspectNarrationDuration(NARRATION_MAX_AUDIO_SECONDS).pass).toBe(true);
    expect(inspectNarrationDuration(NARRATION_MAX_AUDIO_SECONDS + 0.001)).toMatchObject({
      pass: false,
      maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
    });
    expect(inspectNarrationDuration(Number.NaN).pass).toBe(false);
  });

  it("derives the five-minute word floor at the contract narration pace", () => {
    expect(minimumNarrationWords(5)).toBe(750);
  });

  it("rejects an old long-scene manifest and accepts 40 sequential bounded scenes", () => {
    const bounded =
      "Pip the Ant gently carries one berry across the sunny meadow toward all his patient friends beside their cozy clubhouse.";
    const valid = inspectEpisodeNarrationManifest({
      scenes: Array.from({ length: 40 }, (_unused, index) => ({
        sceneNumber: index + 1,
        narrationText: bounded,
      })),
    });
    const invalid = inspectEpisodeNarrationManifest({
      scenes: [{
        sceneNumber: 1,
        narrationText: Array.from({ length: 21 }, (_, index) => `word${index}`).join(" "),
      }],
    });

    expect(valid).toMatchObject({ pass: true, sceneCount: 40 });
    expect(valid.totalSpokenWords).toBeGreaterThanOrEqual(750);
    expect(invalid.pass).toBe(false);
    expect(invalid.issues.join(" ")).toContain("production minimum");
    expect(invalid.issues.join(" ")).toContain("20");
  });
});
