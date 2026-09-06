import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEpisodeTtsTool,
  buildTtsTool,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  type NarrationAudioGenerator,
} from "../tools/ttsTool.js";

const temporaryDirectories: string[] = [];
const validNarration =
  "[warm] Mia watches the golden lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.";

async function makeTemporaryOutputDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "narration-tool-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeGenerator(): NarrationAudioGenerator & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async ({ outputPath }: { outputPath: string }) => {
    await writeFile(outputPath, Buffer.from("fake-wave-data"));
    return outputPath;
  });
  return { invoke } as NarrationAudioGenerator & { invoke: ReturnType<typeof vi.fn> };
}

function fakeMutationState(overrides: Record<string, unknown> = {}) {
  return {
    beginEpisodeNarrationAudioMutation: vi.fn().mockResolvedValue({
      acquired: true,
      audioRevision: 1,
      startedAssetCount: 0,
    }),
    renewEpisodeNarrationAudioMutation: vi.fn().mockResolvedValue(true),
    completeEpisodeNarrationAudioMutation: vi.fn().mockResolvedValue(true),
    abortEpisodeNarrationAudioMutation: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ttsTool one-scene narration contract", () => {
  it("sends one bounded scene as one unchanged Groq request and reuses it only with a matching digest sidecar", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 8.25,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 4, episodeNumber: 2, sceneNumber: 7, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({ status: "generated", readyForAgnes: true, reused: false, durationSeconds: 8.25 });
    expect(reused).toMatchObject({ status: "already_generated", readyForAgnes: true, reused: true, durationSeconds: 8.25 });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
    expect(audioGenerator.invoke.mock.calls[0][0].input).toBe(validNarration);

    const metadataPath = narrationAudioMetadataPath(generated.path);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.durationStatus).toBe("ready");
  });

  it("invalidates an existing WAV when the exact narration text changes", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
    });

    await (tool as any).func({ seriesId: 1, episodeNumber: 1, sceneNumber: 1, text: validNarration });
    await (tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "[warm] Mia watches the silver lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.",
    });

    expect(audioGenerator.invoke).toHaveBeenCalledTimes(2);
  });

  it("preserves the prior WAV and skips Groq when an Agnes claim already locks audio", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const originalGenerator = fakeGenerator();
    const originalTool = buildTtsTool({
      audioGenerator: originalGenerator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
    });
    const original = JSON.parse(await (originalTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: validNarration,
    }));
    const priorAudio = await readFile(original.path);
    const priorMetadata = await readFile(original.metadataPath, "utf8");
    const replacementGenerator = fakeGenerator();
    const beginEpisodeNarrationAudioMutation = vi.fn().mockResolvedValue({
      acquired: false,
      reason: "agnes_started",
      startedAssetCount: 2,
    });
    const seriesState = fakeMutationState({ beginEpisodeNarrationAudioMutation });
    const guardedTool = buildTtsTool({
      audioGenerator: replacementGenerator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
      seriesState,
    });

    const blocked = JSON.parse(await (guardedTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "[warm] Mia watches the silver lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.",
    }));

    expect(blocked).toMatchObject({
      status: "audio_repair_blocked",
      readyForAgnes: false,
      phase: "before_generation",
      startedAssetCount: 2,
    });
    expect(replacementGenerator.invoke).not.toHaveBeenCalled();
    expect(await readFile(original.path)).toEqual(priorAudio);
    expect(await readFile(original.metadataPath, "utf8")).toBe(priorMetadata);
  });

  it("rolls back a generated candidate if its durable audio lease cannot complete", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const originalTool = buildTtsTool({
      audioGenerator: fakeGenerator(),
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
    });
    const original = JSON.parse(await (originalTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: validNarration,
    }));
    const priorAudio = await readFile(original.path);
    const priorMetadata = await readFile(original.metadataPath, "utf8");
    const replacementInvoke = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, Buffer.from("replacement-wave-data"));
      return outputPath;
    });
    const seriesState = fakeMutationState({
      completeEpisodeNarrationAudioMutation: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const guardedTool = buildTtsTool({
      audioGenerator: { invoke: replacementInvoke },
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
      seriesState,
    });

    const blocked = JSON.parse(await (guardedTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "[warm] Mia watches the silver lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.",
    }));

    expect(blocked).toMatchObject({
      status: "audio_repair_deferred",
      phase: "lease_completion",
      reason: "lease_lost",
    });
    expect(replacementInvoke).toHaveBeenCalledOnce();
    expect(seriesState.beginEpisodeNarrationAudioMutation).toHaveBeenCalledTimes(2);
    expect(seriesState.renewEpisodeNarrationAudioMutation).toHaveBeenCalledTimes(2);
    expect(seriesState.completeEpisodeNarrationAudioMutation).toHaveBeenCalledTimes(2);
    expect(await readFile(original.path)).toEqual(priorAudio);
    expect(await readFile(original.metadataPath, "utf8")).toBe(priorMetadata);
  });

  it("never lets an expired publisher roll back over a successor committed before the first Agnes claim", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const originalTool = buildTtsTool({
      audioGenerator: fakeGenerator(),
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
    });
    const original = JSON.parse(await (originalTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: validNarration,
    }));

    let activeToken: string | null = null;
    let staleOwnerToken: string | null = null;
    let staleCompletionWaiting = false;
    let agnesStarted = false;
    let reportStaleCompletion!: () => void;
    let releaseStaleCompletion!: () => void;
    const staleCompletionReached = new Promise<void>((resolve) => {
      reportStaleCompletion = resolve;
    });
    const staleCompletionGate = new Promise<void>((resolve) => {
      releaseStaleCompletion = resolve;
    });
    const seriesState = {
      beginEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (agnesStarted) {
          return { acquired: false, reason: "agnes_started" as const, startedAssetCount: 1 };
        }
        if (activeToken === null) {
          activeToken = input.leaseToken;
          staleOwnerToken ??= input.leaseToken;
          return { acquired: true, audioRevision: 0, startedAssetCount: 0 };
        }
        if (staleCompletionWaiting && activeToken === staleOwnerToken) {
          // Models B atomically fencing A's expired lease before acquiring its
          // own. The database revision advance is not otherwise needed here.
          activeToken = input.leaseToken;
          return { acquired: true, audioRevision: 1, startedAssetCount: 0 };
        }
        return { acquired: false, reason: "mutation_in_progress" as const, startedAssetCount: 0 };
      }),
      renewEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => (
        activeToken === input.leaseToken
      )),
      completeEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (input.leaseToken === staleOwnerToken) {
          staleCompletionWaiting = true;
          reportStaleCompletion();
          await staleCompletionGate;
          return false;
        }
        if (activeToken !== input.leaseToken) return false;
        activeToken = null;
        return true;
      }),
      abortEpisodeNarrationAudioMutation: vi.fn(async (input: { leaseToken: string }) => {
        if (activeToken !== input.leaseToken) return false;
        activeToken = null;
        return true;
      }),
    };
    const staleText =
      "[warm] Mia watches the silver lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.";
    const successorText =
      "[warm] Mia watches the blue lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.";
    const generator = {
      invoke: vi.fn(async ({ input, outputPath }: { input: string; outputPath: string }) => {
        await writeFile(
          outputPath,
          input.includes("silver") ? "stale-owner-wave" : "successor-wave",
        );
        return outputPath;
      }),
    };
    const staleTool = buildTtsTool({
      audioGenerator: generator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
      seriesState,
    });
    const successorTool = buildTtsTool({
      audioGenerator: generator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
      seriesState,
    });

    const staleResultPromise = (staleTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: staleText,
    });
    await staleCompletionReached;

    const successorResult = JSON.parse(await (successorTool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: successorText,
    }));
    expect(successorResult).toMatchObject({ status: "generated", readyForAgnes: true });

    // The first irreversible Agnes claim wins after B's revision commit but
    // before A learns that its completion CAS lost.
    agnesStarted = true;
    releaseStaleCompletion();
    const staleResult = JSON.parse(await staleResultPromise);
    expect(staleResult).toMatchObject({
      status: "audio_repair_deferred",
      phase: "lease_completion",
      reason: "lease_lost",
    });

    expect(await readFile(original.path, "utf8")).toBe("successor-wave");
    const finalMetadata = JSON.parse(await readFile(original.metadataPath, "utf8"));
    expect(finalMetadata.requestDigest).toBe(createNarrationAudioRequestDigest({
      text: successorText,
      model: "canopylabs/orpheus-v1-english",
      voice: "hannah",
    }));
    expect(finalMetadata.publicationToken).toBeTruthy();
    expect(seriesState.beginEpisodeNarrationAudioMutation).toHaveBeenCalledTimes(3);
  });

  it("rejects text over the character or spoken-word limit before a paid request", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 8,
      retryDelayMs: () => 0,
    });

    await expect((tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "x".repeat(201),
    })).rejects.toThrow("200");
    await expect((tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 2,
      text: Array.from({ length: 21 }, (_, index) => `word${index}`).join(" "),
    })).rejects.toThrow("20");

    expect(audioGenerator.invoke).not.toHaveBeenCalled();
  });

  it("allows a short scene beat because only the global episode runtime has a minimum", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 1.2,
      retryDelayMs: () => 0,
    });

    const generated = JSON.parse(await (tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 3,
      text: "Pip stops.",
    }));

    expect(generated).toMatchObject({ status: "generated", readyForAgnes: true, spokenWordCount: 2 });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns a hard duration_exceeded result and reuses the measured rejected artifact without another request", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 12.4,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 2, episodeNumber: 3, sceneNumber: 4, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: false,
      durationSeconds: 12.4,
      maxDurationSeconds: 12,
      needsScriptSplit: true,
    });
    expect(generated.path).toBeUndefined();
    expect(generated.rejectedPath).toContain("scene_004_narrator.wav");
    expect(reused).toMatchObject({ status: "duration_exceeded", reused: true });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("honors a persisted duration_exceeded status when a boundary re-probe falls just below 12 seconds", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    let measuredDuration = 12.01;
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => measuredDuration,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 6, episodeNumber: 2, sceneNumber: 8, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    measuredDuration = 11.99;
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({ status: "duration_exceeded", readyForAgnes: false });
    expect(reused).toMatchObject({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: true,
      durationSeconds: 11.99,
    });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("binds request identity to text, model, voice, and response format", () => {
    const base = { text: validNarration, model: "orpheus", voice: "hannah" };
    const digest = createNarrationAudioRequestDigest(base);

    expect(createNarrationAudioRequestDigest(base)).toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, text: `${validNarration} Again.` })).not.toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, voice: "autumn" })).not.toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, model: "another-model" })).not.toBe(digest);
  });
});

function persistedNarrationScript(sceneCount: number) {
  return {
    title: "A Test Episode",
    scenes: Array.from({ length: sceneCount }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText: validNarration,
    })),
  };
}

describe("ttsTool production episode batch", () => {
  it("loads the persisted script and sequentially generates then reuses all scene audio in one compact call", async () => {
    const outputDir = await makeTemporaryOutputDir();
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const invoke = vi.fn(async (input: Parameters<NarrationAudioGenerator["invoke"]>[0]) => {
      const { outputPath } = input;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      await writeFile(outputPath, Buffer.from("fake-wave-data"));
      activeRequests -= 1;
      return outputPath;
    });
    const getEpisodeByNumber = vi.fn().mockResolvedValue({
      id: 91,
      scriptJson: persistedNarrationScript(40),
    });
    const seriesState = fakeMutationState({ getEpisodeByNumber });
    const progressLogger = vi.fn();
    const tool = buildEpisodeTtsTool({
      audioGenerator: { invoke },
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
      seriesState: seriesState as any,
      progressLogger,
    });

    expect(tool.name).toBe("synthesize_episode_narration_audio");
    expect((tool.schema as any).safeParse({
      seriesId: 4,
      episodeNumber: 2,
      text: "must not be accepted",
    }).success).toBe(false);

    const generated = JSON.parse(await (tool as any).func({ seriesId: 4, episodeNumber: 2 }));
    const reused = JSON.parse(await (tool as any).func({ seriesId: 4, episodeNumber: 2 }));

    expect(generated).toEqual(expect.objectContaining({
      status: "ready",
      readyForAgnes: true,
      seriesId: 4,
      episodeId: 91,
      episodeNumber: 2,
      sceneCount: 40,
      measuredNarrationSceneCount: 40,
      measuredTotalNarrationSeconds: 300,
      durationExceededScenes: [],
      totalDurationBelowMinimum: false,
      generatedSceneCount: 40,
      reusedSceneCount: 0,
    }));
    expect(reused).toEqual(expect.objectContaining({
      status: "ready",
      measuredNarrationSceneCount: 40,
      measuredTotalNarrationSeconds: 300,
      generatedSceneCount: 0,
      reusedSceneCount: 40,
    }));
    expect(getEpisodeByNumber).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(40);
    expect(maxActiveRequests).toBe(1);
    expect(invoke.mock.calls.map(([input]) => input.input)).toEqual(
      Array.from({ length: 40 }, () => validNarration),
    );
    expect(progressLogger).toHaveBeenCalledWith(
      expect.stringContaining("scene 40 (40/40) starting"),
    );
  });

  it("finishes every scene and returns complete refinement evidence when a WAV exceeds 12 seconds", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const seriesState = fakeMutationState({
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 12,
        scriptJson: JSON.stringify(persistedNarrationScript(40)),
      }),
    });
    const tool = buildEpisodeTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async (filePath) => {
        const sceneNumber = Number(filePath.match(/scene_(\d{3})/u)?.[1]);
        return sceneNumber === 7 ? 12.4 : 7.5;
      },
      retryDelayMs: () => 0,
      seriesState: seriesState as any,
      progressLogger: vi.fn(),
    });

    const result = JSON.parse(await (tool as any).func({ seriesId: 1, episodeNumber: 3 }));

    expect(result).toEqual(expect.objectContaining({
      status: "repair_required",
      readyForAgnes: false,
      episodeId: 12,
      sceneCount: 40,
      measuredNarrationSceneCount: 40,
      measuredTotalNarrationSeconds: 304.9,
      durationExceededScenes: [{ sceneNumber: 7, durationSeconds: 12.4 }],
      totalDurationBelowMinimum: false,
      generatedSceneCount: 40,
    }));
    expect(result.nextAction).toContain("refine_episode_script");
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(40);
  });

  it("returns complete evidence for deterministic repair when total narration is below five minutes", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const seriesState = fakeMutationState({
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 13,
        scriptJson: persistedNarrationScript(40),
      }),
    });
    const tool = buildEpisodeTtsTool({
      audioGenerator: fakeGenerator(),
      outputDir,
      probeDurationSeconds: async () => 7,
      retryDelayMs: () => 0,
      seriesState: seriesState as any,
      progressLogger: vi.fn(),
    });

    const result = JSON.parse(await (tool as any).func({ seriesId: 1, episodeNumber: 4 }));

    expect(result).toEqual(expect.objectContaining({
      status: "repair_required",
      readyForAgnes: false,
      measuredNarrationSceneCount: 40,
      measuredTotalNarrationSeconds: 280,
      durationExceededScenes: [],
      totalDurationBelowMinimum: true,
      minimumTotalNarrationSeconds: 300,
    }));
  });

  it.each([
    ["agnes_started", "audio_repair_blocked"],
    ["episode_complete", "audio_repair_blocked"],
    ["mutation_in_progress", "audio_repair_deferred"],
  ])("returns a compact typed result when the first mutation is %s", async (reason, expectedStatus) => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const seriesState = fakeMutationState({
      getEpisodeByNumber: vi.fn().mockResolvedValue({
        id: 14,
        scriptJson: persistedNarrationScript(2),
      }),
      beginEpisodeNarrationAudioMutation: vi.fn().mockResolvedValue({
        acquired: false,
        reason,
        startedAssetCount: reason === "agnes_started" ? 2 : 0,
      }),
    });
    const tool = buildEpisodeTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 7,
      retryDelayMs: () => 0,
      seriesState: seriesState as any,
      progressLogger: vi.fn(),
    });

    const result = JSON.parse(await (tool as any).func({ seriesId: 1, episodeNumber: 5 }));

    expect(result).toEqual(expect.objectContaining({
      status: expectedStatus,
      readyForAgnes: false,
      episodeId: 14,
      sceneCount: 2,
      processedSceneCount: 0,
      sceneNumber: 1,
      reason,
      generatedSceneCount: 0,
      reusedSceneCount: 0,
    }));
    expect(result).not.toHaveProperty("measuredTotalNarrationSeconds");
    expect(result).not.toHaveProperty("measuredNarrationSceneCount");
    expect(audioGenerator.invoke).not.toHaveBeenCalled();
  });

  it("validates every persisted narration before making the first provider request", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const script = persistedNarrationScript(2);
    script.scenes[1]!.narrationText = "x".repeat(201);
    const seriesState = fakeMutationState({
      getEpisodeByNumber: vi.fn().mockResolvedValue({ id: 15, scriptJson: script }),
    });
    const tool = buildEpisodeTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 7,
      retryDelayMs: () => 0,
      seriesState: seriesState as any,
      progressLogger: vi.fn(),
    });

    await expect((tool as any).func({ seriesId: 1, episodeNumber: 6 })).rejects.toThrow(
      "Persisted episode narration is invalid",
    );
    expect(audioGenerator.invoke).not.toHaveBeenCalled();
    expect(seriesState.beginEpisodeNarrationAudioMutation).not.toHaveBeenCalled();
  });
});
