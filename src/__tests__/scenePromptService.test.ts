import { describe, expect, it, vi } from "vitest";

import { materializeScenePrompt } from "../services/scenePromptService.js";

const baseInput = {
  seriesId: 7,
  sceneNumber: 3,
  narrationText: "Pip carries one berry toward the clubhouse.",
  environmentDescription: "A sunny meadow beside a small wooden clubhouse.",
  action: "Pip takes one careful step with the berry.",
  characterNames: ["Pip the Ant"],
  characterVisuals: [{
    name: "Pip the Ant",
    visualForm: "real_creature" as const,
    speciesOrType: "ant",
    humanoidAllowed: false,
  }],
  supportingEntities: [],
  continuityAnchors: ["Berry: one glossy raspberry-red berry held above the grass."],
  sceneDetails: "Pip remains fully visible with the berry centered between his forelegs.",
  cameraAngle: "medium wide shot",
  lighting: "warm morning sunlight",
};

describe("scenePromptService production character gate", () => {
  it("rejects a non-roster name instead of generating a new character image", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A red ant." }]),
      getCharacterSheet: vi.fn(),
    };

    await expect(materializeScenePrompt({
      seriesState: state as never,
      input: { ...baseInput, characterNames: ["Surprise Fox"] },
    })).rejects.toThrow("not in the fixed series roster");
    expect(state.getCharacterSheet).not.toHaveBeenCalled();
  });

  it("requires an approved public portrait and never backfills it during Agnes prompting", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A red ant." }]),
      getCharacterSheet: vi.fn(async () => null),
    };

    await expect(materializeScenePrompt({
      seriesState: state as never,
      input: baseInput,
    })).rejects.toThrow("ensure_series_character_portraits");
  });

  it("uses the approved public portrait while keeping appearance prose out of the prompt", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A red ant." }]),
      getCharacterSheet: vi.fn(async () => ({
        approvedAt: "2026-09-04T00:00:00.000Z",
        generationPrompt: "Tiny ruby-red ant, round black eyes, yellow leaf vest. Always same colors.",
        referenceImagePaths: {
          portrait: { publicUrl: "https://example.supabase.co/storage/v1/object/public/refs/pip_the_ant.png" },
        },
      })),
    };

    const result = await materializeScenePrompt({
      seriesState: state as never,
      input: baseInput,
    });
    expect(result.characterNames).toEqual(["Pip the Ant"]);
    expect(result.prompt).toContain("REFERENCE-CONDITIONED MAIN CAST — [Pip the Ant]");
    expect(result.prompt).not.toContain("Tiny ruby-red ant");
    expect(result.prompt).toContain("ONE CONTINUOUS BEAT");
    expect(result.prompt).not.toContain("A red ant");
    expect(result.characterReferenceSources).toEqual([{
      name: "Pip the Ant",
      source: "https://example.supabase.co/storage/v1/object/public/refs/pip_the_ant.png",
    }]);
  });

  it("canonicalizes a durable supporting alias to its approved roster identity before prompting", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [
        { name: "Pip the Ant", description: "A tiny ruby-red ant." },
        { name: "Bobo the Backpack", description: "One teal living backpack with yellow straps." },
      ]),
      getCharacterSheet: vi.fn(async (_seriesId: number, name: string) => ({
        approvedAt: "2026-09-04T00:00:00.000Z",
        generationPrompt: name === "Bobo the Backpack"
          ? "One teal backpack, two button eyes, yellow straps, one flap-mouth."
          : "Tiny ruby-red ant, round black eyes, yellow leaf vest.",
        referenceImagePaths: {
          portrait: {
            publicUrl: `https://example.supabase.co/storage/v1/object/public/refs/${name === "Bobo the Backpack" ? "bobo_the_backpack" : "pip_the_ant"}.png`,
          },
        },
      })),
    };

    const result = await materializeScenePrompt({
      seriesState: state as never,
      input: {
        ...baseInput,
        action: "Pip the Ant steadies Bobo beside the clubhouse.",
        supportingEntities: ["Bobo: playful magical living backpack with button eyes and yellow straps"],
        sceneDetails: "Pip the Ant stands left while Bobo waits on the right.",
      },
    });

    expect(result.characterNames).toEqual(["Pip the Ant", "Bobo the Backpack"]);
    expect(result.prompt).toContain("[Bobo the Backpack]");
    expect(result.prompt).not.toContain("One teal backpack, two button eyes");
    expect(result.prompt).not.toContain("SUPPORTING IDENTITY REFERENCES — [Bobo]");
    expect(result.characterReferenceSources.map(({ name }) => name)).toEqual([
      "Pip the Ant",
      "Bobo the Backpack",
    ]);
  });
});
