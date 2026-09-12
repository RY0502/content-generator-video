import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../config.js";
import type { AgnesSceneGenerationRow } from "../state/seriesState.js";
import { buildAgnesVideoQaTool } from "../tools/agnesVideoQaTool.js";

const originalOutputDir = CONFIG.outputDir;

afterEach(() => {
  (CONFIG as { outputDir: string }).outputDir = originalOutputDir;
});

function row(sceneNumber: number, videoPath: string): AgnesSceneGenerationRow {
  return {
    id: sceneNumber + 10,
    seriesId: 7,
    episodeNumber: 2,
    sceneNumber,
    variant: "text",
    status: "completed",
    prompt: `Prompt for ${sceneNumber}`,
    requestDigest: `${Math.abs(sceneNumber) + 1}`.padStart(64, "0"),
    attemptCount: 1,
    seed: 1234 + sceneNumber,
    requestedDurationSeconds: 6,
    providerDurationSeconds: 6,
    publicReferenceUrl: null,
    providerTaskId: `task-${sceneNumber}`,
    providerReceipt: { accepted: true },
    providerVideoUrl: "https://provider.invalid/video.mp4",
    rawOutputPath: null,
    normalizedOutputPath: videoPath,
    downloadStatus: "downloaded",
    renderRevision: 0,
    qaStatus: "pending",
    qaRequestDigest: null,
    qaVideoSha256: null,
    qaResult: null,
    qaContactSheetPath: null,
    qaModel: null,
    qaError: null,
    qaCheckedAt: null,
    error: null,
    submittedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:05:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:05:00.000Z",
  };
}

async function fixture() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-video-qa-tool-"));
  (CONFIG as { outputDir: string }).outputDir = outputDir;
  const portraitPath = path.join(outputDir, "mia.png");
  await writeFile(portraitPath, "portrait");
  const rows = new Map<number, AgnesSceneGenerationRow>();
  for (const sceneNumber of [-2, -1, 1]) {
    const videoPath = path.join(outputDir, `${sceneNumber}.mp4`);
    await writeFile(videoPath, `video-${sceneNumber}`);
    rows.set(sceneNumber, row(sceneNumber, videoPath));
  }
  const state = {
    getSeriesInfo: vi.fn().mockResolvedValue({
      conceptName: "Pocket Stars",
      episodeFormula: "Mia solves gentle mysteries.",
      charactersJson: [{
        name: "Mia",
        description: "Mia is exactly a six-year-old girl with black pigtails and a yellow coat.",
      }],
    }),
    getEpisodeByNumber: vi.fn().mockResolvedValue({
      title: "The Glowing Map",
      scriptJson: {
        scenes: [{
          sceneNumber: 1,
          narrationText: "Mia carefully opens the glowing map and smiles.",
          environmentDescription: "A warm painted attic with a round window.",
          action: "Mia opens one folded map on the table.",
          characterNames: ["Mia"],
          supportingEntities: [],
          sceneDetails: "Mia stands left of the table, with one map centered and the window behind her.",
          cameraAngle: "medium fixed eye-level shot",
          lighting: "warm amber interior light",
        }],
      },
    }),
    listAgnesSceneGenerations: vi.fn(async () => [...rows.values()]),
    getSeriesCharacters: vi.fn(),
    getCharacterSheet: vi.fn().mockResolvedValue({
      approvedAt: "2026-09-01T00:00:00.000Z",
      generationPrompt: "Exactly six-year-old girl; round face; black pigtails; yellow coat.",
      referenceImagePaths: { portrait: { path: portraitPath } },
    }),
    getOrCreateSeriesAgnesSeed: vi.fn().mockResolvedValue(98765),
    recordAgnesVideoQaVerdict: vi.fn(async (input: any) => {
      const current = rows.get(input.sceneNumber)!;
      if (
        current.requestDigest !== input.expectedRequestDigest
        || current.renderRevision !== input.expectedRenderRevision
        || current.normalizedOutputPath !== input.expectedNormalizedOutputPath
        || current.qaStatus !== input.expectedQaStatus
        || current.qaRequestDigest !== input.expectedQaRequestDigest
      ) return { recorded: false, row: current };
      const updated: AgnesSceneGenerationRow = {
        ...current,
        qaStatus: input.status,
        qaRequestDigest: input.qaRequestDigest,
        qaVideoSha256: input.videoSha256,
        qaResult: input.result,
        qaModel: input.model,
      };
      rows.set(input.sceneNumber, updated);
      return { recorded: true, row: updated };
    }),
    recordAgnesVideoQaError: vi.fn(async (input: any) => {
      const current = rows.get(input.sceneNumber)!;
      if (
        current.requestDigest === input.expectedRequestDigest
        && current.renderRevision === input.expectedRenderRevision
        && current.normalizedOutputPath === input.expectedNormalizedOutputPath
        && current.qaStatus === input.expectedQaStatus
        && current.qaRequestDigest === input.expectedQaRequestDigest
      ) rows.set(input.sceneNumber, { ...current, qaError: input.error });
    }),
    requeueAgnesSceneAfterQaFailure: vi.fn(async (input: any) => {
      const current = rows.get(input.sceneNumber)!;
      if (
        current.requestDigest !== input.expectedRequestDigest
        || current.renderRevision !== input.expectedRenderRevision
        || current.normalizedOutputPath !== input.expectedNormalizedOutputPath
        || current.qaStatus !== input.expectedQaStatus
        || current.qaRequestDigest !== input.expectedQaRequestDigest
      ) return { requeued: false, row: current };
      const updated: AgnesSceneGenerationRow = {
        ...current,
        status: "pending",
        downloadStatus: "pending",
        normalizedOutputPath: null,
        renderRevision: 1,
        qaStatus: "awaiting_regeneration",
        prompt: input.retryPrompt,
        requestDigest: input.retryRequestDigest,
        seed: input.retrySeed,
      };
      rows.set(input.sceneNumber, updated);
      return { requeued: true, row: updated };
    }),
  };
  const createReferenceBoard = vi.fn(async ({ outputPath }: { outputPath: string }) => {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "reference-board");
    return outputPath;
  });
  const createContactSheet = vi.fn(async ({ outputPath }: { outputPath: string }) => {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "contact-sheet");
    return outputPath;
  });
  return { state, rows, createReferenceBoard, createContactSheet };
}

function verdictFor(userText: string, failedScene?: number): string {
  const sceneNumbers = [...userText.matchAll(/TARGET [^\n]+\(sceneNumber=(-?\d+)\)/gu)]
    .map((match) => Number(match[1]));
  return JSON.stringify({
    assets: sceneNumbers.map((sceneNumber) => sceneNumber === failedScene
      ? {
          sceneNumber,
          pass: false,
          confidence: 0.98,
          issues: [{
            code: "duplicate_entity",
            characterNames: ["Mia"],
            frames: ["middle"],
            description: "Two copies of Mia are visible.",
          }],
        }
      : { sceneNumber, pass: true, confidence: 0.97, issues: [] }),
  });
}

describe("qa_agnes_episode_videos", () => {
  it("persists passes for both key arts and every scene before assembly", async () => {
    const { state, createReferenceBoard, createContactSheet } = await fixture();
    const analyze = vi.fn(async ({ userText }: { userText: string }) => verdictFor(userText));
    const tool = buildAgnesVideoQaTool(state as any, {
      analyze: analyze as any,
      createReferenceBoard: createReferenceBoard as any,
      createContactSheet: createContactSheet as any,
      maxVisionCalls: 20,
      preferredTargetsPerSheet: 3,
    });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));
    expect(result).toMatchObject({ status: "passed", assetCount: 3, passed: 3, apiCalls: 2 });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(state.recordAgnesVideoQaVerdict).toHaveBeenCalledTimes(3);
    expect(state.requeueAgnesSceneAfterQaFailure).not.toHaveBeenCalled();
  });

  it("archives and requeues only a failed asset with a new deterministic retry request", async () => {
    const { state, rows, createReferenceBoard, createContactSheet } = await fixture();
    const originalSeed = rows.get(1)!.seed;
    const analyze = vi.fn(async ({ userText }: { userText: string }) => verdictFor(userText, 1));
    const tool = buildAgnesVideoQaTool(state as any, {
      analyze: analyze as any,
      createReferenceBoard: createReferenceBoard as any,
      createContactSheet: createContactSheet as any,
      maxRegenerations: 1,
    });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));
    expect(result).toMatchObject({ status: "regeneration_required", requeued: 1, stopRun: true });
    expect(state.requeueAgnesSceneAfterQaFailure).toHaveBeenCalledOnce();
    const retry = state.requeueAgnesSceneAfterQaFailure.mock.calls[0]![0];
    expect(retry.sceneNumber).toBe(1);
    expect(retry.retryPrompt).toContain("Render each listed figure exactly once");
    expect(retry.retrySeed).not.toBe(originalSeed);
    expect(retry.retryRequestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(rows.get(1)).toMatchObject({
      status: "pending",
      renderRevision: 1,
      qaStatus: "awaiting_regeneration",
    });
  });

  it("does not let a later batch error regress an earlier verdict from the same batch", async () => {
    const { state, rows, createReferenceBoard, createContactSheet } = await fixture();
    const persistVerdict = state.recordAgnesVideoQaVerdict.getMockImplementation()!;
    state.recordAgnesVideoQaVerdict
      .mockImplementationOnce(persistVerdict)
      .mockRejectedValueOnce(new Error("simulated second persistence failure"));
    const analyze = vi.fn(async ({ userText }: { userText: string }) => verdictFor(userText));
    const tool = buildAgnesVideoQaTool(state as any, {
      analyze: analyze as any,
      createReferenceBoard: createReferenceBoard as any,
      createContactSheet: createContactSheet as any,
    });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "pending", stopRun: true });
    expect(rows.get(-2)).toMatchObject({ qaStatus: "passed", qaError: null });
    expect(rows.get(-1)).toMatchObject({ qaStatus: "pending", qaError: "simulated second persistence failure" });
    expect(state.recordAgnesVideoQaError).toHaveBeenCalledTimes(2);
    expect(state.recordAgnesVideoQaError.mock.calls[0]?.[0]).toMatchObject({
      expectedQaStatus: "pending",
      expectedQaRequestDigest: null,
    });
  });

  it("keeps a low-confidence judgment pending instead of spending the Agnes rerender", async () => {
    const { state, createReferenceBoard, createContactSheet } = await fixture();
    const analyze = vi.fn(async ({ userText }: { userText: string }) => {
      const sceneNumbers = [...userText.matchAll(/TARGET [^\n]+\(sceneNumber=(-?\d+)\)/gu)]
        .map((match) => Number(match[1]));
      return JSON.stringify({
        assets: sceneNumbers.map((sceneNumber) => ({
          sceneNumber,
          pass: true,
          confidence: 0.4,
          issues: [],
        })),
      });
    });
    const tool = buildAgnesVideoQaTool(state as any, {
      analyze: analyze as any,
      createReferenceBoard: createReferenceBoard as any,
      createContactSheet: createContactSheet as any,
      minConfidence: 0.8,
    });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));
    expect(result).toMatchObject({ status: "pending", requeued: 0, stopRun: true });
    expect(state.requeueAgnesSceneAfterQaFailure).not.toHaveBeenCalled();
    expect(state.recordAgnesVideoQaVerdict).not.toHaveBeenCalled();
    expect(state.recordAgnesVideoQaError).toHaveBeenCalledTimes(3);
  });
});
