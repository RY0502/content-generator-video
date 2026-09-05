import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureCharacterBibleEntryMock = vi.fn();
vi.mock("../services/characterSheetService.js", () => ({
  ensureCharacterBibleEntry: (...args: unknown[]) => ensureCharacterBibleEntryMock(...args),
}));

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
  beforeEach(() => vi.clearAllMocks());

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
    expect(ensureCharacterBibleEntryMock).not.toHaveBeenCalled();
  });

  it("requires an approved sheet and never backfills it during Agnes prompting", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A red ant." }]),
      getCharacterSheet: vi.fn(async () => null),
    };

    await expect(materializeScenePrompt({
      seriesState: state as never,
      input: baseInput,
    })).rejects.toThrow("generate_character_sheet");
    expect(ensureCharacterBibleEntryMock).not.toHaveBeenCalled();
  });

  it("uses the approved locked identity in the direct Agnes prompt", async () => {
    const state = {
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A red ant." }]),
      getCharacterSheet: vi.fn(async () => ({
        approvedAt: "2026-09-04T00:00:00.000Z",
        generationPrompt: "Tiny ruby-red ant, round black eyes, yellow leaf vest. Always same colors.",
      })),
    };

    const result = await materializeScenePrompt({
      seriesState: state as never,
      input: baseInput,
    });
    expect(result.characterNames).toEqual(["Pip the Ant"]);
    expect(result.prompt).toContain("Tiny ruby-red ant");
    expect(result.prompt).toContain("VISIBLE ACTION");
    expect(ensureCharacterBibleEntryMock).not.toHaveBeenCalled();
  });
});
