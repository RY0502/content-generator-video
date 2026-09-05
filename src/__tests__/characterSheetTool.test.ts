import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../config.js", () => ({
  CONFIG: {
    assetsDir: "",
  },
}));

const generateAnyApiSceneImageMock = vi.fn();
vi.mock("../providers/anyApiImageClient.js", () => ({
  generateAnyApiSceneImage: (...args: unknown[]) => generateAnyApiSceneImageMock(...args),
}));

const chatTextMock = vi.fn();
const chatVisionFrameworkOnlyMock = vi.fn();
vi.mock("../providers/aiClient.js", () => ({
  chatText: (...args: unknown[]) => chatTextMock(...args),
  chatVisionFrameworkOnly: (...args: unknown[]) => chatVisionFrameworkOnlyMock(...args),
}));

import { buildCharacterSheetTool } from "../tools/characterSheetTool.js";
import { CONFIG } from "../config.js";
import {
  PORTRAIT_MODEL,
  characterPortraitStorage,
  conflictsWithCharacterVisual,
  createCharacterPortraitRequestDigest,
  inspectCharacterSignaturePrompt,
} from "../services/characterSheetService.js";

const validSignature =
  "Small ant, crimson-red shell, deep-blue backpack, round black eyes, brave posture. Always same colors.";

describe("characterSheetTool (single Gemini portrait, vision detail extraction)", () => {
  let assetsDir: string;
  let seriesState: any;
  let customState: any;
  const promptHash = "test-prompt-hash";

  beforeEach(async () => {
    assetsDir = await mkdtemp(path.join(tmpdir(), "char-sheet-test-"));
    (CONFIG as any).assetsDir = assetsDir;

    generateAnyApiSceneImageMock.mockReset();
    generateAnyApiSceneImageMock.mockImplementation(async () => {
      return Buffer.from(`portrait-${Math.random()}`);
    });
    chatTextMock.mockReset();
    chatVisionFrameworkOnlyMock.mockReset();
    chatVisionFrameworkOnlyMock.mockResolvedValue(
      "Small ant with a crimson-red shell, deep-blue backpack, round black eyes, and brave posture.",
    );
    chatTextMock.mockResolvedValue(validSignature);

    seriesState = {
      seriesExists: vi.fn().mockResolvedValue(true),
      getCharacterSheet: vi.fn().mockResolvedValue(null),
      upsertCharacterSheet: vi.fn().mockResolvedValue(undefined),
    };

    const store = new Map<string, unknown>();
    customState = {
      get: vi.fn(async (_hash: string, key: string) => (store.has(key) ? store.get(key) : null)),
      set: vi.fn(async (_hash: string, key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it("generates 1 portrait with Gemini, extracts a detailed description, and saves it", async () => {
    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);
    const result = await (tool as any).func({
      seriesId: 1,
      characterName: "Pip the Ant",
      characterDescription: "A small red ant with a blue backpack",
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("generated");

    // 1 portrait generated via AnyAPI with Gemini model.
    expect(generateAnyApiSceneImageMock).toHaveBeenCalledTimes(1);
    expect(generateAnyApiSceneImageMock.mock.calls[0][1]).toBe("google/gemini-3.1-flash-image");
    // Detailed description extracted once via the framework-only vision call.
    expect(chatVisionFrameworkOnlyMock).toHaveBeenCalledTimes(1);
    // Signature prompt distilled once via text LLM call.
    expect(chatTextMock).toHaveBeenCalledTimes(1);

    // Only portrait is persisted (no candidates).
    expect(Object.keys(parsed.sheet)).toEqual(["portrait"]);
    expect(parsed.sheet.portrait.path).toContain("portrait.png");

    // Compact signature prompt returned.
    expect(parsed.generationPrompt).toBe(validSignature);

    // Upserted to DB with the portrait reference and compact signature prompt.
    expect(seriesState.upsertCharacterSheet).toHaveBeenCalledTimes(1);
    const upsertArgs = seriesState.upsertCharacterSheet.mock.calls[0];
    expect(upsertArgs[2]).toBe("A small red ant with a blue backpack");
    expect(upsertArgs[3]).toHaveProperty("portrait");
    expect(upsertArgs[4]).toBe(validSignature);
  });

  it("resumes from a checkpointed portrait/description without regenerating", async () => {
    // Pre-seed the checkpoint store as if the portrait + description already succeeded in a prior run.
    const description = "A small red ant with a blue backpack";
    const requestDigest = createCharacterPortraitRequestDigest({
      characterDescription: description,
      model: PORTRAIT_MODEL,
    });
    const storage = characterPortraitStorage({
      assetsDir,
      seriesId: 1,
      characterName: "Pip the Ant",
      requestDigest,
    });
    await mkdir(path.dirname(storage.portraitPath), { recursive: true });
    await writeFile(storage.portraitPath, Buffer.from("previously-locked-portrait"));
    await customState.set(promptHash, storage.checkpointKey, {
      portraitPath: storage.portraitPath,
      model: PORTRAIT_MODEL,
      requestDigest,
      detailedDescription: "Small ant with a crimson-red shell and deep-blue backpack.",
      generationPrompt: validSignature,
    });

    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);
    const result = await (tool as any).func({
      seriesId: 1,
      characterName: "Pip the Ant",
      characterDescription: description,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("generated");

    // Nothing was regenerated (no AnyAPI calls, no re-extraction, no distillation).
    expect(generateAnyApiSceneImageMock).not.toHaveBeenCalled();
    expect(chatVisionFrameworkOnlyMock).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();

    // Sheet references the checkpointed portrait.
    expect(parsed.sheet.portrait.path).toContain("portrait.png");
    expect(parsed.generationPrompt).toBe(validSignature);
  });

  it("short-circuits entirely when the character sheet is already fully approved", async () => {
    const description = "A small red ant";
    const requestDigest = createCharacterPortraitRequestDigest({
      characterDescription: description,
      model: PORTRAIT_MODEL,
    });
    const storage = characterPortraitStorage({
      assetsDir,
      seriesId: 1,
      characterName: "Pip the Ant",
      requestDigest,
    });
    await mkdir(path.dirname(storage.portraitPath), { recursive: true });
    await writeFile(storage.portraitPath, Buffer.from("approved-portrait"));
    seriesState.getCharacterSheet.mockResolvedValue({
      approvedAt: new Date(),
      description,
      referenceImagePaths: { portrait: { path: storage.portraitPath } },
      generationPrompt: validSignature,
    });

    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);
    const result = await (tool as any).func({
      seriesId: 1,
      characterName: "Pip the Ant",
      characterDescription: description,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("already_approved");
    expect(generateAnyApiSceneImageMock).not.toHaveBeenCalled();
  });

  it("does not treat generated non-human/not-humanoid safeguards as a real-creature conflict", () => {
    const characterVisual = {
      name: "Mina the Butterfly",
      visualForm: "real_creature" as const,
      speciesOrType: "butterfly",
      humanoidAllowed: false,
    };
    const guardedDescription =
      "A small amber butterfly. Visual ontology: Mina must be a real non-human butterfly with true butterfly anatomy, not a humanoid, fairy-like, mascot-like, doll-like, or human-child hybrid. No human face, human hands, upright child body, or clothing unless explicitly required by the story.";

    expect(conflictsWithCharacterVisual({
      characterVisual,
      description: guardedDescription,
      generationPrompt:
        "Small butterfly, amber-orange wings, black body, round green eyes. Always same colors.",
    })).toBe(false);
    expect(conflictsWithCharacterVisual({
      characterVisual,
      description: guardedDescription,
      generationPrompt:
        "Young girl fairy, amber dress, long black hair, green eyes. Always same colors.",
    })).toBe(true);
  });

  it("scopes portrait storage by series and description/model digest", async () => {
    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);
    const first = JSON.parse(await (tool as any).func({
      seriesId: 1,
      characterName: "Pip the Ant",
      characterDescription: "A small red ant with a blue backpack",
    }));
    const secondSeries = JSON.parse(await (tool as any).func({
      seriesId: 2,
      characterName: "Pip the Ant",
      characterDescription: "A small red ant with a blue backpack",
    }));
    const changedDescription = JSON.parse(await (tool as any).func({
      seriesId: 1,
      characterName: "Pip the Ant",
      characterDescription: "A small green ant with a yellow backpack",
    }));

    expect(first.sheet.portrait.path).toContain(`${path.sep}series_1${path.sep}characters${path.sep}`);
    expect(secondSeries.sheet.portrait.path).toContain(`${path.sep}series_2${path.sep}characters${path.sep}`);
    expect(new Set([
      first.sheet.portrait.path,
      secondSeries.sheet.portrait.path,
      changedDescription.sheet.portrait.path,
    ]).size).toBe(3);
    expect(generateAnyApiSceneImageMock).toHaveBeenCalledTimes(3);

    const originalDigest = createCharacterPortraitRequestDigest({
      characterDescription: "A small red ant with a blue backpack",
      model: PORTRAIT_MODEL,
    });
    expect(createCharacterPortraitRequestDigest({
      characterDescription: "A small green ant with a yellow backpack",
      model: PORTRAIT_MODEL,
    })).not.toBe(originalDigest);
    expect(createCharacterPortraitRequestDigest({
      characterDescription: "A small red ant with a blue backpack",
      model: "different/model",
    })).not.toBe(originalDigest);
  });

  it("preserves multiline identity details and retries invalid signature responses", async () => {
    expect(inspectCharacterSignaturePrompt(
      `${"crimson-red ant identity, ".repeat(12)}${"Always same colors."}`,
    ).issues.join(" ")).toContain("maximum is 250");
    chatTextMock
      .mockReset()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("Small crimson-red ant, deep-blue backpack")
      .mockResolvedValueOnce(
        "Small ant, crimson-red shell,\ndeep-blue backpack, round black eyes. Always same colors.",
      );

    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);
    const parsed = JSON.parse(await (tool as any).func({
      seriesId: 4,
      characterName: "Pip the Ant",
      characterDescription: "A small red ant with a blue backpack",
    }));

    expect(chatTextMock).toHaveBeenCalledTimes(3);
    expect(parsed.generationPrompt).toBe(
      "Small ant, crimson-red shell, deep-blue backpack, round black eyes. Always same colors.",
    );
    expect(inspectCharacterSignaturePrompt(parsed.generationPrompt).pass).toBe(true);
  });

  it("fails closed after three invalid signature responses instead of persisting one", async () => {
    chatTextMock.mockReset().mockResolvedValue("generic character description without a color lock");
    const tool = buildCharacterSheetTool(seriesState, customState, promptHash);

    await expect((tool as any).func({
      seriesId: 5,
      characterName: "Pip the Ant",
      characterDescription: "A small red ant with a blue backpack",
    })).rejects.toThrow("failed validation after 3 attempts");

    expect(chatTextMock).toHaveBeenCalledTimes(3);
    expect(seriesState.upsertCharacterSheet).not.toHaveBeenCalled();
  });
});
